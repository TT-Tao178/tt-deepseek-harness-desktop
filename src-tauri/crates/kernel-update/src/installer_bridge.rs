//! 安装器桥：spawn Node 安装器子进程（resources/installer/install-kernel.cjs），
//! 解析其 stdout 的 JSON 行为强类型事件并转发；原始行同步落盘日志。
//!
//! 协议（与 install-kernel.cjs 约定）：
//! `{"t":"phase","phase":"resolving|downloading|extracting|selftest"}`
//! `{"t":"resolve","packages":N}` / `{"t":"dl","name":..,"ver":..,"i":..,"n":..,"pct":..}`
//! `{"t":"extract","name":..,"i":..}` / `{"t":"selftest","port":P}`
//! `{"t":"versions","latest":"..","versions":[{"version":..,"time":..}]}`
//! `{"t":"warn","detail":".."}`
//! `{"t":"ok","version":"..","packages":N,"ms":M}`
//! `{"t":"err","code":"E_INTEGRITY|E_NETWORK|E_REGISTRY|E_TAR|E_SEMVER|E_DISK|E_SELFTEST|E_TIMEOUT","pkg":"..","detail":".."}`

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use std::sync::mpsc::{self, Receiver};

/// 元数据里的一条版本记录。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct VersionInfo {
    pub version: String,
    /// npm 发布时间（ISO 字符串；镜像可能缺省）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
}

/// 安装器发出的事件。
#[derive(Debug, Clone)]
pub enum InstallerEvent {
    Phase(String),
    Resolve { packages: u64 },
    Dl { name: String, ver: String, i: u64, n: u64, pct: u64 },
    Extract { name: String, i: u64 },
    SelfTest { port: u16 },
    Versions { latest: Option<String>, versions: Vec<VersionInfo> },
    Warn { detail: String },
    Ok { version: String, packages: u64, ms: u64 },
    Err { code: String, pkg: Option<String>, detail: String },
    /// 无法解析的行（原样保留，供排障展示）。
    Raw(String),
}

/// 解析一行 JSON 协议输出；坏 JSON / 未知 t → Raw。
pub fn parse_event_line(line: &str) -> InstallerEvent {
    let line = line.trim();
    if line.is_empty() {
        return InstallerEvent::Raw(String::new());
    }
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return InstallerEvent::Raw(line.to_string()),
    };
    let t = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
    match t {
        "phase" => InstallerEvent::Phase(
            v.get("phase").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
        ),
        "resolve" => InstallerEvent::Resolve {
            packages: v.get("packages").and_then(|x| x.as_u64()).unwrap_or(0),
        },
        "dl" => InstallerEvent::Dl {
            name: v.get("name").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
            ver: v.get("ver").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
            i: v.get("i").and_then(|x| x.as_u64()).unwrap_or(0),
            n: v.get("n").and_then(|x| x.as_u64()).unwrap_or(0),
            pct: v.get("pct").and_then(|x| x.as_u64()).unwrap_or(0),
        },
        "extract" => InstallerEvent::Extract {
            name: v.get("name").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
            i: v.get("i").and_then(|x| x.as_u64()).unwrap_or(0),
        },
        "selftest" => InstallerEvent::SelfTest {
            port: v.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16,
        },
        "versions" => InstallerEvent::Versions {
            latest: v.get("latest").and_then(|x| x.as_str()).map(|s| s.to_string()),
            versions: v
                .get("versions")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            Some(VersionInfo {
                                version: item.get("version")?.as_str()?.to_string(),
                                time: item.get("time").and_then(|x| x.as_str()).map(|s| s.to_string()),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "warn" => InstallerEvent::Warn {
            detail: v.get("detail").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
        },
        "ok" => InstallerEvent::Ok {
            version: v.get("version").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
            packages: v.get("packages").and_then(|x| x.as_u64()).unwrap_or(0),
            ms: v.get("ms").and_then(|x| x.as_u64()).unwrap_or(0),
        },
        "err" => InstallerEvent::Err {
            code: v.get("code").and_then(|x| x.as_str()).unwrap_or("E_UNKNOWN").to_string(),
            pkg: v.get("pkg").and_then(|x| x.as_str()).map(|s| s.to_string()),
            detail: v.get("detail").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
        },
        _ => InstallerEvent::Raw(line.to_string()),
    }
}

/// 安装器进程描述。
#[derive(Debug, Clone)]
pub struct InstallerSpec {
    pub node_exe: PathBuf,
    pub script: PathBuf,
    pub args: Vec<String>,
    /// stdout 原始行落盘路径（追加）。
    pub log_path: PathBuf,
}

/// 运行中的安装器句柄。
pub struct InstallerHandle {
    events_rx: Receiver<InstallerEvent>,
    pid: u32,
    child: Arc<Mutex<Child>>,
    reader: Option<JoinHandle<()>>,
}

impl InstallerHandle {
    /// 非阻塞取一条事件（None = 暂无）。
    pub fn try_recv(&self) -> Option<InstallerEvent> {
        self.events_rx.try_recv().ok()
    }

    /// 安装器进程 pid（取消/杀树用）。
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// 进程是否仍在运行（不消费 handle）。
    pub fn is_running(&self) -> bool {
        let mut child = match self.child.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        matches!(child.try_wait(), Ok(None))
    }

    /// 取消：杀整个进程树（安装器可能还带自检内核子进程）。
    pub fn cancel(&self) {
        kernel_process::kill_tree::kill_tree(self.pid);
    }

    /// 等待退出，返回安装器退出码（0=成功）。阻塞。
    pub fn wait(mut self) -> Result<i32, String> {
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
        let mut child = match self.child.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match child.wait() {
            Ok(st) => Ok(st.code().unwrap_or(-1)),
            Err(e) => Err(format!("wait installer: {e}")),
        }
    }
}

/// spawn 安装器（参数数组，无 shell 拼接）。stdout 按行解析转发，
/// stderr 追加进同一日志文件。
pub fn spawn(spec: InstallerSpec) -> Result<InstallerHandle, String> {
    let mut cmd = Command::new(&spec.node_exe);
    cmd.arg(&spec.script);
    cmd.args(&spec.args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn installer: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("installer stdout not piped")?;
    let stderr = child.stderr.take().ok_or("installer stderr not piped")?;

    let (tx, rx) = mpsc::channel::<InstallerEvent>();
    let log_path = spec.log_path.clone();
    let reader = std::thread::spawn(move || {
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        let rd = BufReader::new(stdout);
        for line in rd.lines() {
            let Ok(line) = line else { break };
            if let Some(f) = log.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "{line}");
            }
            let _ = tx.send(parse_event_line(&line));
        }
        // stderr 合并记录（不进事件流）。
        let rde = BufReader::new(stderr);
        for line in rde.lines().map_while(Result::ok) {
            if let Some(f) = log.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "[stderr] {line}");
            }
        }
    });

    Ok(InstallerHandle {
        events_rx: rx,
        pid,
        child: Arc::new(Mutex::new(child)),
        reader: Some(reader),
    })
}

/// 便捷断言：收集 events（在 reader 线程驱动下由测试线程调用）。
#[allow(dead_code)]
pub fn drain(rx: &Receiver<InstallerEvent>, sink: &mut impl FnMut(InstallerEvent)) {
    while let Ok(ev) = rx.try_recv() {
        sink(ev);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_all_event_kinds() {
        let e = parse_event_line(r#"{"t":"phase","phase":"downloading"}"#);
        assert!(matches!(e, InstallerEvent::Phase(p) if p == "downloading"));

        let e = parse_event_line(r#"{"t":"resolve","packages":790}"#);
        assert!(matches!(e, InstallerEvent::Resolve { packages: 790 }));

        let e = parse_event_line(
            r#"{"t":"dl","name":"@deepseek-ai/dsh","ver":"0.1.0-rc.7","i":1,"n":790,"pct":12}"#,
        );
        assert!(matches!(e, InstallerEvent::Dl { ref name, ref ver, i: 1, n: 790, pct: 12 } if name == "@deepseek-ai/dsh" && ver == "0.1.0-rc.7"));

        let e = parse_event_line(r#"{"t":"selftest","port":52304}"#);
        assert!(matches!(e, InstallerEvent::SelfTest { port: 52304 }));

        let e = parse_event_line(
            r#"{"t":"versions","latest":"0.1.0-rc.7","versions":[{"version":"0.1.0-rc.6","time":"2026-08-01"},{"version":"0.1.0-rc.7"}]}"#,
        );
        match e {
            InstallerEvent::Versions { latest, versions } => {
                assert_eq!(latest.as_deref(), Some("0.1.0-rc.7"));
                assert_eq!(versions.len(), 2);
                assert_eq!(versions[0].version, "0.1.0-rc.6");
                assert_eq!(versions[0].time.as_deref(), Some("2026-08-01"));
                assert_eq!(versions[1].time, None);
            }
            other => panic!("wrong event: {other:?}"),
        }

        let e = parse_event_line(r#"{"t":"ok","version":"0.1.0-rc.7","packages":790,"ms":234567}"#);
        assert!(matches!(e, InstallerEvent::Ok { ref version, packages: 790, ms: 234567 } if version == "0.1.0-rc.7"));

        let e = parse_event_line(
            r#"{"t":"err","code":"E_INTEGRITY","pkg":"lodash","detail":"sha512 mismatch"}"#,
        );
        assert!(matches!(e, InstallerEvent::Err { ref code, ref pkg, .. } if code == "E_INTEGRITY" && pkg.as_deref() == Some("lodash")));
    }

    #[test]
    fn bad_lines_become_raw_not_errors() {
        assert!(matches!(parse_event_line("not json"), InstallerEvent::Raw(_)));
        assert!(matches!(parse_event_line(""), InstallerEvent::Raw(s) if s.is_empty()));
        assert!(matches!(
            parse_event_line(r#"{"t":"mystery"}"#),
            InstallerEvent::Raw(_)
        ));
        assert!(matches!(
            parse_event_line(r#"[1,2,3]"#),
            InstallerEvent::Raw(_)
        ));
    }

    /// 进程级：写一个临时 .cmd 输出两行协议 → spawn → 收事件 → wait。
    #[cfg(windows)]
    #[test]
    fn spawn_collects_lines_and_exit_code() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let root = std::env::temp_dir().join(format!(
            "installer-bridge-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let cmd_path = root.join("fake-installer.cmd");
        fs::write(
            &cmd_path,
            "@echo off\r\necho {\"t\":\"phase\",\"phase\":\"resolving\"}\r\necho {\"t\":\"ok\",\"version\":\"0.2.0\",\"packages\":3,\"ms\":12}\r\n",
        )
        .unwrap();
        let spec = InstallerSpec {
            node_exe: PathBuf::from("cmd"),
            script: PathBuf::from("/c"),
            args: vec![cmd_path.to_string_lossy().into_owned()],
            log_path: root.join("installer.log"),
        };
        let handle = spawn(spec).expect("spawn");
        let mut got_phase = false;
        let mut got_ok = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            while let Some(ev) = handle.try_recv() {
                match ev {
                    InstallerEvent::Phase(p) if p == "resolving" => got_phase = true,
                    InstallerEvent::Ok { ref version, .. } if version == "0.2.0" => got_ok = true,
                    _ => {}
                }
            }
            if got_phase && got_ok {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("timeout waiting events (phase={got_phase} ok={got_ok})");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let code = handle.wait().expect("wait installer");
        assert_eq!(code, 0, "cmd exits 0");
        let log = fs::read_to_string(root.join("installer.log")).unwrap();
        assert!(log.contains("\"t\":\"phase\""), "raw lines must tee to log");
        let _ = fs::remove_dir_all(&root);
    }
}
