mod supervisor;
pub mod window;

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use supervisor::{HealthResult, KernelOps, KernelState, Supervisor};

/// 真实内核操作：按 KernelSpec 启动 node 进程，stdout/stderr 落盘 logs/kernel.log；
/// 健康探测走 kernel-process::health，终止走 kill_tree。
struct RealOps {
    spec: kernel_process::spawn_spec::KernelSpec,
    port: u16,
    log_path: PathBuf,
    child_slot: Arc<Mutex<Option<Child>>>,
}

impl KernelOps for RealOps {
    fn spawn(&mut self) -> Result<u32, String> {
        let mut cmd = self.spec.command();
        // 内核 stdout/stderr 落盘（追加，保留多次重启的日志）。
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .map_err(|e| format!("open kernel log {}: {e}", self.log_path.display()))?;
        let err_file = file
            .try_clone()
            .map_err(|e| format!("clone kernel log fd: {e}"))?;
        cmd.stdout(std::process::Stdio::from(file));
        cmd.stderr(std::process::Stdio::from(err_file));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：不弹黑色控制台窗口。
            cmd.creation_flags(0x0800_0000);
        }
        let child = cmd.spawn().map_err(|e| format!("spawn kernel: {e}"))?;
        let pid = child.id();
        *self.child_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
        Ok(pid)
    }

    fn is_healthy(&self) -> bool {
        kernel_process::health::is_healthy(self.port, Duration::from_millis(200))
    }

    fn kill(&self, pid: u32) {
        kernel_process::kill_tree::kill_tree(pid);
    }
}

/// 从 current_exe() 向上找项目根 / 安装根：
/// dev 模式 exe 位于 `<root>/src-tauri/target/debug/`，向上找到同时含
/// `kernel/` 与 `plugins/` 的目录；安装模式 exe 旁有 `resources/`（含 `node/`）。
/// 找不到返回 None（调用方跳过相关步骤并记日志，不阻塞）。
fn app_root_from_exe() -> Option<PathBuf> {
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..8 {
        if dir.join("kernel").is_dir() && dir.join("plugins").is_dir() {
            return Some(dir);
        }
        if dir.join("resources").is_dir() && dir.join("resources").join("node").is_dir() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// 在 app 根下定位内核目录（dev：`<root>/kernel`；安装：resources 下）。
fn locate_kernel_dir(app_root: &Path) -> Option<PathBuf> {
    for cand in [
        app_root.join("kernel"),
        app_root.join("resources").join("kernel"),
        app_root.join("resources").join("node"),
    ] {
        if cand.join("node.exe").is_file() {
            return Some(cand);
        }
    }
    None
}

/// 追加一行到日志文件（失败静默，不 panic）。
fn append_log(path: &Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[tauri::command]
fn service_get_status(state: tauri::State<'_, Arc<Mutex<Supervisor>>>) -> String {
    let sup = match state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let payload = serde_json::json!({
        "state": format!("{:?}", sup.state()),
        "port": sup.ready_port(),
    });
    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn service_restart(state: tauri::State<'_, Arc<Mutex<Supervisor>>>) -> Result<String, String> {
    let mut sup = match state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    sup.stop();
    sup.start()?;
    let payload = serde_json::json!({
        "state": format!("{:?}", sup.state()),
        "port": sup.ready_port(),
    });
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

/// 装配内核生命周期：日志目录 / DSH_HOME → junction → --patch 参数 → supervisor
/// （tauri State）→ spawn 内核 + poll 线程。每步失败只写日志，不 panic。
fn setup_kernel(app: &tauri::App) {
    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[setup] app_data_dir failed: {e}");
            return;
        }
    };

    // --- a. 日志目录 + DSH_HOME ---
    let logs_dir = app_data.join("logs");
    if let Err(e) = std::fs::create_dir_all(&logs_dir) {
        eprintln!("[setup] create logs dir failed: {e}");
    }
    let main_log = logs_dir.join("main.log");
    let dsh_home = app_data.join("dsh-home");
    std::env::set_var("DSH_HOME", &dsh_home);
    append_log(
        &main_log,
        &format!(
            "app starting at unix-ms {}, dsh-home={}",
            unix_ms(),
            dsh_home.display()
        ),
    );

    // --- b. junction：<app_data>/dsh-home/node_modules <- plugins 源码 ---
    let home_node_modules = dsh_home.join("node_modules");
    if let Err(e) = std::fs::create_dir_all(&home_node_modules) {
        append_log(&main_log, &format!("[setup] create home/node_modules failed: {e}"));
    }
    let app_root = app_root_from_exe();
    if app_root.is_none() {
        append_log(&main_log, "[setup] app root not found; skipping junctions and plugin patches");
    }
    let resources = app_root.as_ref().map(|r| r.join("resources"));
    let mut links: Vec<(String, PathBuf)> = Vec::new();
    if let Some(root) = &app_root {
        let res_path: &Path = resources.as_deref().unwrap_or(root.as_path());
        for name in ["tt-bg", "dsh-pet-roxy"] {
            if let Some(src) = shell_core::plugins::find_plugin_src(root, res_path, name) {
                links.push((name.to_string(), src));
            }
        }
    }
    if links.is_empty() {
        append_log(&main_log, "[setup] no plugin sources found; skipping junctions");
    } else {
        for err in shell_core::plugins::ensure_junctions(&home_node_modules, &links) {
            append_log(&main_log, &format!("[setup] junction: {err}"));
        }
    }

    // --- c. --patch 参数（tt-bg 恒在，roxy 按 settings）---
    let settings = shell_core::settings::read_settings(&app_data.join("settings.json"));
    let mut patch_args: Vec<String> = Vec::new();
    if let Some(root) = &app_root {
        let res_path: &Path = resources.as_deref().unwrap_or(root.as_path());
        let mut push_patch = |name: &str, enabled: bool| {
            if let Some(src) = shell_core::plugins::find_plugin_src(root, res_path, name) {
                let path = shell_core::plugins::plugin_patch_path(&src);
                patch_args.extend(shell_core::plugins::resolve_patch_args(&path, enabled));
            }
        };
        push_patch("tt-bg", true);
        push_patch("dsh-pet-roxy", settings.roxy.enabled);
    }
    append_log(&main_log, &format!("[setup] patch args: {patch_args:?}"));
    app.manage(Arc::new(Mutex::new(patch_args.clone())));

    // --- d. supervisor（真实 ops）存入 tauri State ---
    let Some(kernel_dir) = app_root.as_deref().and_then(locate_kernel_dir) else {
        append_log(&main_log, "[setup] kernel dir not found; kernel supervisor disabled");
        return;
    };
    let port = match kernel_process::port::reserve_free_port() {
        Ok(p) => p,
        Err(e) => {
            append_log(&main_log, &format!("[setup] reserve free port failed: {e}"));
            return;
        }
    };
    let plugins_dir = app_root
        .map(|r| r.join("plugins"))
        .unwrap_or_else(|| kernel_dir.join("plugins"));
    let paths = shell_core::paths::DshPaths::new(app_data.clone(), kernel_dir.clone(), plugins_dir);
    let spec = kernel_process::spawn_spec::KernelSpec {
        node_exe: paths.kernel_node(),
        bin_js: paths.kernel_bin_js(),
        port,
        patch_args,
        env: vec![],
    };
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let ops = RealOps {
        spec,
        port,
        log_path: paths.kernel_log(),
        child_slot: child_slot.clone(),
    };
    let mut supervisor = Supervisor::new(Box::new(ops));
    supervisor.set_ready_port(port);
    let supervisor = Arc::new(Mutex::new(supervisor));
    app.manage(supervisor.clone());
    append_log(
        &main_log,
        &format!(
            "[setup] supervisor managed (kernel dir={}, port={port})",
            kernel_dir.display()
        ),
    );

    // --- e. spawn 内核 + poll 线程（W8a 阶段不 load_url）---
    match supervisor.lock().unwrap_or_else(|p| p.into_inner()).start() {
        Ok(()) => append_log(&main_log, &format!("[setup] kernel spawn requested on port {port}")),
        Err(e) => append_log(&main_log, &format!("[setup] kernel start failed: {e}")),
    }
    spawn_poll_thread(supervisor, child_slot);
}

/// 一个 poll 线程，每 200ms：Starting/Ready 时检测进程退出（try_wait → on_exit）
/// 并 poll_health；Crashed 时调 restart（内部等待退避延迟）。
fn spawn_poll_thread(
    sup_state: Arc<Mutex<Supervisor>>,
    child_slot: Arc<Mutex<Option<Child>>>,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        let mut sup = match sup_state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match sup.state() {
            KernelState::Starting | KernelState::Ready => {
                // 检测进程退出（外部 exit 事件 → on_exit）。
                if let Ok(mut slot) = child_slot.lock() {
                    if let Some(child) = slot.as_mut() {
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            sup.on_exit();
                        }
                    }
                }
                match sup.poll_health() {
                    HealthResult::Ready => {
                        eprintln!("[kernel-supervisor] kernel ready on port {:?}", sup.ready_port())
                    }
                    HealthResult::Crashed => {
                        eprintln!("[kernel-supervisor] kernel crashed; scheduling restart")
                    }
                    HealthResult::Exhausted => {
                        eprintln!("[kernel-supervisor] kernel backoff exhausted")
                    }
                    HealthResult::StillStarting => {}
                }
            }
            KernelState::Crashed => {
                if let Err(e) = sup.restart() {
                    eprintln!("[kernel-supervisor] restart failed: {e}");
                }
            }
            KernelState::Stopped | KernelState::Exhausted => {
                drop(sup);
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例时聚焦主窗口。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            setup_kernel(app);
            window::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![service_get_status, service_restart])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // 退出前统一停内核（ask/quit 两条关闭路径都会走到这里；stop 幂等）。
        tauri::RunEvent::Exit => window::stop_supervisor(app_handle),
        _ => {}
    });
}
