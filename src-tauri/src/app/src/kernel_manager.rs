//! 内核更新任务编排：检查更新 / 安装 / 回滚 / 取消，进度经 Tauri 事件推送。
//!
//! 事件名：
//! - `kernel://versions` — 检查更新结果（版本列表）
//! - `kernel://progress` — 安装过程进度（phase/pct/error）
//! - `kernel://done`     — 终态（installed / rolled_back / failed / cancelled / checked）
//!
//! 互斥：同一时刻至多一个更新任务（BUSY 原子标志）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use kernel_update::installer_bridge::{InstallerEvent, InstallerSpec};
use kernel_update::plan;
use kernel_update::swap::{self, SwapLayout};

use crate::settings_ui;
use crate::KernelRuntime;

/// 任务进行中标志（全局唯一更新任务）。
static BUSY: AtomicBool = AtomicBool::new(false);

/// 更新预检所需磁盘字节（staging + 备份 + 缓存余量）。
const NEED_DISK_BYTES: u64 = 1600 * 1024 * 1024;

/// 从 KernelRuntime 推导换名布局（staging/backup 与 kernel 同级）。
fn layout_of(rt: &KernelRuntime) -> Result<SwapLayout, String> {
    let kernel_dir = rt
        .app_root
        .as_deref()
        .map(crate::locate_kernel_dir)
        .flatten()
        .ok_or_else(|| "内核目录未找到（dev 目录布局或安装不完整）".to_string())?;
    let parent = kernel_dir
        .parent()
        .ok_or_else(|| "内核目录缺少父目录".to_string())?
        .to_path_buf();
    let s = shell_core::settings::read_settings(&rt.settings_path);
    Ok(SwapLayout {
        kernel_dir,
        staging_root: parent.join("kernel-staging"),
        backup_root: parent.join("kernel-backup"),
        keep_backups: s.kernel.keep_backups,
    })
}

fn registry_of(rt: &KernelRuntime) -> Result<String, String> {
    let s = shell_core::settings::read_settings(&rt.settings_path);
    shell_core::settings::registry_url(&s.kernel.registry)
        .map(|u| u.to_string())
        .ok_or_else(|| format!("未知 registry: {}", s.kernel.registry))
}

fn emit(app: &AppHandle, event: &str, payload: serde_json::Value) {
    let _ = app.emit(event, payload);
}

fn append_main_log(rt: &KernelRuntime, msg: &str) {
    let path = rt.app_data.join("logs").join("main.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "[kernel-update] {msg}");
    }
}

// ---------------- 命令 ----------------

/// 当前内核状态（供设置窗口渲染）。
#[tauri::command]
pub fn kernel_status(rt: tauri::State<'_, Arc<KernelRuntime>>) -> String {
    let payload = kernel_status_payload(&rt);
    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
}

fn kernel_status_payload(rt: &KernelRuntime) -> serde_json::Value {
    let layout = layout_of(rt);
    let s = shell_core::settings::read_settings(&rt.settings_path);
    let installed = layout
        .as_ref()
        .ok()
        .and_then(|l| swap::read_kernel_version(&l.kernel_dir));
    let backups = layout
        .as_ref()
        .map(|l| swap::list_backups(&l.backup_root))
        .unwrap_or_default();
    serde_json::json!({
        "busy": BUSY.load(Ordering::SeqCst),
        "installed_version": installed,
        "settings_version": s.kernel.installed_version,
        "backups": backups,
        "registry": s.kernel.registry,
        "last_checked": s.kernel.last_checked,
    })
}

/// 切换更新源（白名单校验 + 持久化）。
/// 旧实现只在设置窗口里改了下拉框、并没有写盘，用户切到 npmjs 后其实还是走
/// npmmirror——「检查更新」结果自然和预期不符。
#[tauri::command]
pub fn kernel_set_registry(
    rt: tauri::State<'_, Arc<KernelRuntime>>,
    registry: String,
) -> Result<String, String> {
    if shell_core::settings::registry_url(&registry).is_none() {
        return Err(format!("不支持的更新源: {registry}"));
    }
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    s.kernel.registry = registry.clone();
    shell_core::settings::write_settings(&rt.settings_path, &s)?;
    append_main_log(&rt, &format!("registry switched to {registry}"));
    Ok(registry)
}

/// 检查更新（拉取官方注册表版本列表，事件 kernel://versions 回推）。
#[tauri::command]
pub fn kernel_check_updates(app: tauri::AppHandle, rt: tauri::State<'_, Arc<KernelRuntime>>) -> bool {
    if BUSY.swap(true, Ordering::SeqCst) {
        return false; // 已有任务
    }
    let rt = rt.inner().clone();
    std::thread::spawn(move || {
        let result = run_metadata(&app, &rt);
        match result {
            Ok(payload) => emit(&app, "kernel://versions", payload),
            Err(e) => emit(
                &app,
                "kernel://versions",
                serde_json::json!({ "error": e }),
            ),
        }
        BUSY.store(false, Ordering::SeqCst);
    });
    true
}

/// 安装指定版本（事件 kernel://progress / kernel://done 回推）。
#[tauri::command]
pub fn kernel_install(
    app: tauri::AppHandle,
    rt: tauri::State<'_, Arc<KernelRuntime>>,
    version: String,
) -> bool {
    if BUSY.swap(true, Ordering::SeqCst) {
        return false;
    }
    if plan::parse_semver(&version).is_none() {
        BUSY.store(false, Ordering::SeqCst);
        emit(&app, "kernel://done", serde_json::json!({
            "result": "failed", "error": format!("非法版本号: {version}")
        }));
        return true;
    }
    let rt = rt.inner().clone();
    std::thread::spawn(move || {
        let result = run_install(&app, &rt, &version, &CANCEL);
        BUSY.store(false, Ordering::SeqCst);
        let _ = result;
    });
    true
}

/// 取消（仅解析/下载阶段有效）。
#[tauri::command]
pub fn kernel_cancel() -> bool {
    CANCEL.store(true, Ordering::SeqCst);
    true
}

/// 一键回滚到备份版本。
#[tauri::command]
pub fn kernel_rollback(
    app: tauri::AppHandle,
    rt: tauri::State<'_, Arc<KernelRuntime>>,
    version: Option<String>,
) -> bool {
    if BUSY.swap(true, Ordering::SeqCst) {
        return false;
    }
    let rt = rt.inner().clone();
    std::thread::spawn(move || {
        let _ = run_rollback(&app, &rt, version.as_deref());
        BUSY.store(false, Ordering::SeqCst);
    });
    true
}

/// 取消标志（安装泵线程消费）。
static CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------------- 任务实现 ----------------

fn run_metadata(_app: &AppHandle, rt: &Arc<KernelRuntime>) -> Result<serde_json::Value, String> {
    let registry = registry_of(rt)?;
    let script = kernel_update::installer_script_path(
        rt.app_root.as_ref().ok_or("app root 未找到")?,
    );
    let node_exe = layout_of(rt)?.kernel_dir.join("node.exe");
    let spec = InstallerSpec {
        node_exe,
        script,
        args: vec![
            "metadata".to_string(),
            "--registry".to_string(),
            registry,
            "--json-progress".to_string(),
        ],
        log_path: rt.app_data.join("logs").join(format!(
            "installer-check-{}.log",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        )),
    };
    append_main_log(rt, "check updates: spawn installer metadata");
    let handle = kernel_update::installer_bridge::spawn(spec)?;
    let mut versions: Option<serde_json::Value> = None;
    let mut error: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match handle.try_recv() {
            Some(InstallerEvent::Versions { latest, versions: list }) => {
                let current = layout_of(rt)
                    .ok()
                    .and_then(|l| swap::read_kernel_version(&l.kernel_dir));
                versions = Some(serde_json::json!({
                    "latest": latest,
                    "current": current,
                    "versions": list,
                }));
            }
            Some(InstallerEvent::Err { code, detail, .. }) => {
                error = Some(format!("{code}: {detail}"));
            }
            Some(_) => {}
            None => {
                if !handle.is_running() {
                    // 进程已退出；给 reader 线程 100ms 冲刷剩余事件。
                    std::thread::sleep(Duration::from_millis(100));
                    while let Some(ev) = handle.try_recv() {
                        if let InstallerEvent::Err { code, detail, .. } = ev {
                            error = Some(format!("{code}: {detail}"));
                        }
                    }
                    break;
                }
                if Instant::now() > deadline {
                    handle.cancel();
                    error = Some("检查更新超时".to_string());
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let _ = handle.wait();
    // 更新 last_checked。
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    s.kernel.last_checked = Some(iso_now());
    let _ = shell_core::settings::write_settings(&rt.settings_path, &s);

    match (versions, error) {
        (Some(v), _) => {
            append_main_log(rt, "check updates: ok");
            Ok(v)
        }
        (None, Some(e)) => {
            append_main_log(rt, &format!("check updates failed: {e}"));
            Err(e)
        }
        (None, None) => {
            append_main_log(rt, "check updates: no versions event");
            Err("未收到版本数据（安装器异常退出）".to_string())
        }
    }
}


fn run_install(app: &AppHandle, rt: &Arc<KernelRuntime>, version: &str, cancel: &AtomicBool) -> Result<(), String> {
    let registry = registry_of(rt)?;
    let layout = layout_of(rt)?;
    let script = kernel_update::installer_script_path(
        rt.app_root.as_ref().ok_or("app root 未找到")?,
    );
    let node_exe = layout.kernel_dir.join("node.exe");

    let started = Instant::now();
    let deadline = started + Duration::from_secs(60 * 40); // 硬上限 40 分钟
    let log_file = format!(
        "installer-install-{}.log",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    );

    // 1. 预检（可写/磁盘/残留 staging）。
    if let Err(e) = swap::precheck(&layout, NEED_DISK_BYTES) {
        append_main_log(rt, &format!("install {version} precheck failed: {e}"));
        emit(app, "kernel://done", serde_json::json!({ "result": "failed", "error": e, "version": version }));
        return Err(e);
    }

    // 2. spawn 安装器。
    CANCEL.store(false, Ordering::SeqCst);
    let staging_dir = layout
        .staging_root
        .join(version.replace(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '_' | '-'), "_"));
    let selftest_home = rt.app_data.join("selftest-home");
    let spec = InstallerSpec {
        node_exe,
        script,
        args: vec![
            "install".to_string(),
            "--registry".to_string(),
            registry,
            "--target".to_string(),
            version.to_string(),
            "--staging".to_string(),
            staging_dir.to_string_lossy().into_owned(),
            "--cache".to_string(),
            rt.app_data.join("kernel-cache").to_string_lossy().into_owned(),
            "--selftest-home".to_string(),
            selftest_home.to_string_lossy().into_owned(),
            "--json-progress".to_string(),
        ],
        log_path: rt.app_data.join("logs").join(log_file),
    };
    append_main_log(rt, &format!("install {version}: spawn installer"));
    let handle = match kernel_update::installer_bridge::spawn(spec) {
        Ok(h) => h,
        Err(e) => {
            emit(app, "kernel://done", serde_json::json!({ "result": "failed", "error": e, "version": version }));
            return Err(e);
        }
    };

    // 3. 泵事件 → UI；阶段推进由安装器事件驱动。
    emit(app, "kernel://progress", serde_json::json!({ "phase": "resolving", "version": version, "pct": 0 }));
    let mut installer_error: Option<(String, String)> = None; // (code, detail)
    let mut ok_event: Option<(String, u64)> = None;
    loop {
        if Instant::now() > deadline {
            handle.cancel();
            installer_error = Some(("E_TIMEOUT".into(), "更新超时（40 分钟）".into()));
            break;
        }
        if cancel.load(Ordering::SeqCst) {
            handle.cancel();
            installer_error = Some(("E_CANCELLED".into(), "用户取消".into()));
            break;
        }
        match handle.try_recv() {
            Some(InstallerEvent::Phase(p)) => {
                emit(app, "kernel://progress", serde_json::json!({ "phase": p, "version": version }));
            }
            Some(InstallerEvent::Resolve { .. }) => {}
            Some(InstallerEvent::Dl { i, n, pct, name, ver }) => {
                emit(app, "kernel://progress", serde_json::json!({
                    "phase": "downloading", "version": version, "i": i, "n": n, "pct": pct,
                    "detail": format!("{name}@{ver}"),
                }));
            }
            Some(InstallerEvent::Extract { i, .. }) => {
                emit(app, "kernel://progress", serde_json::json!({ "phase": "extracting", "version": version, "i": i }));
            }
            Some(InstallerEvent::SelfTest { port }) => {
                emit(app, "kernel://progress", serde_json::json!({ "phase": "selftest", "version": version, "detail": format!("端口 {port}") }));
            }
            Some(InstallerEvent::Warn { detail }) => {
                append_main_log(rt, &format!("install {version} warn: {detail}"));
            }
            Some(InstallerEvent::Err { code, detail, .. }) => {
                installer_error = Some((code, detail));
                break;
            }
            Some(InstallerEvent::Ok { version: v, packages, .. }) => {
                ok_event = Some((v, packages));
                break;
            }
            Some(_) => {}
            None => {
                if !handle.is_running() {
                    std::thread::sleep(Duration::from_millis(100));
                    while let Some(ev) = handle.try_recv() {
                        if let InstallerEvent::Err { code, detail, .. } = ev {
                            installer_error = Some((code, detail));
                        }
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
        }
    }
    let _ = handle.wait();

    if let Some((code, detail)) = installer_error {
        // 清 staging（用户取消/失败都清；自检通过前正式内核未动）。
        let _ = std::fs::remove_dir_all(&layout.staging_root);
        append_main_log(rt, &format!("install {version} failed: {code}: {detail}"));
        let cancelled = code == "E_CANCELLED";
        emit(app, "kernel://done", serde_json::json!({
            "result": if cancelled { "cancelled" } else { "failed" },
            "code": code, "error": format!("{code}: {detail}"), "version": version,
        }));
        return Err(format!("{code}: {detail}"));
    }
    let Some((installed_version, _packages)) = ok_event else {
        let _ = std::fs::remove_dir_all(&layout.staging_root);
        let e = "安装器异常退出（无 ok/err 事件）".to_string();
        emit(app, "kernel://done", serde_json::json!({ "result": "failed", "error": e, "version": version }));
        return Err(e);
    };

    // 4. 换名（SelfTest 已过）：正式 → 备份，staging → 正式。
    //    换名前必须先停内核并等它退出：运行中的 node.exe 持有内核目录下
    //    文件的句柄，Windows 上会让 `rename kernel → kernel-backup` 直接
    //    失败（拒绝访问）。旧的 `recompute_and_restart` 把 stop 放在换名
    //    之后，那条路径在 E_SEMVER 修好后就会踩到这个坑。
    emit(app, "kernel://progress", serde_json::json!({ "phase": "swapping", "version": version }));
    append_main_log(rt, &format!("install {version}: stopping kernel before swap"));
    settings_ui::stop_kernel(rt);
    let current = swap::read_kernel_version(&layout.kernel_dir);
    let backup_name = match swap::swap_in(&layout, &installed_version, current.as_deref()) {
        Ok(b) => b,
        Err(e) => {
            append_main_log(rt, &format!("install {version} swap failed: {e}"));
            // 换名失败：正式内核未被改动，把内核拉回来，别让用户停在停机态。
            settings_ui::compute_spec_and_start(rt);
            emit(app, "kernel://done", serde_json::json!({ "result": "failed", "error": e, "version": version }));
            return Err(e);
        }
    };

    // 5. 重启内核 + 健康等待；失败 → 回滚。
    emit(app, "kernel://progress", serde_json::json!({ "phase": "restarting", "version": version }));
    settings_ui::compute_spec_and_start(rt);
    if wait_kernel_ready(rt, Duration::from_secs(90)) {
        finish_install_success(app, rt, &installed_version);
        return Ok(());
    }

    // 健康失败 → 自动回滚（同样先停内核再动目录）。
    emit(app, "kernel://progress", serde_json::json!({ "phase": "rollback", "version": version, "detail": format!("新内核启动失败，回滚到 {backup_name}") }));
    append_main_log(rt, &format!("install {version}: health failed after swap; rolling back to {backup_name}"));
    settings_ui::stop_kernel(rt);
    if let Err(e) = swap::rollback_to(&layout, &backup_name) {
        append_main_log(rt, &format!("rollback failed: {e}"));
        settings_ui::compute_spec_and_start(rt);
        emit(app, "kernel://done", serde_json::json!({ "result": "failed", "error": format!("回滚也失败: {e}"), "version": version }));
        return Err(e);
    }
    settings_ui::compute_spec_and_start(rt);
    let restored = wait_kernel_ready(rt, Duration::from_secs(90));
    if !restored {
        append_main_log(rt, "rollback restart also failed");
    }
    emit(app, "kernel://done", serde_json::json!({
        "result": "rolled_back",
        "version": version,
        "backup": backup_name,
        "restored": restored,
        "error": format!("新内核启动失败，已回滚到 {backup_name}"),
    }));
    Err(format!("新内核启动失败，已回滚到 {backup_name}"))
}

fn finish_install_success(app: &AppHandle, rt: &Arc<KernelRuntime>, installed_version: &str) {
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    s.kernel.installed_version = Some(installed_version.to_string());
    s.kernel.last_checked = Some(iso_now());
    let _ = shell_core::settings::write_settings(&rt.settings_path, &s);
    // 清 staging 根（安装器已把版本目录换走，根目录此时应空；删除失败无碍）。
    if let Ok(l) = layout_of(rt) {
        let _ = std::fs::remove_dir_all(&l.staging_root);
    }
    append_main_log(rt, &format!("install {installed_version}: done"));
    emit(app, "kernel://done", serde_json::json!({
        "result": "installed", "version": installed_version,
    }));
}

fn run_rollback(app: &AppHandle, rt: &Arc<KernelRuntime>, version: Option<&str>) -> Result<(), String> {
    let layout = layout_of(rt)?;
    let target = match version {
        Some(v) => v.to_string(),
        None => swap::list_backups(&layout.backup_root)
            .first()
            .cloned()
            .ok_or_else(|| "没有可用备份".to_string())?,
    };
    emit(app, "kernel://progress", serde_json::json!({ "phase": "rollback", "detail": format!("回滚到 {target}") }));
    append_main_log(rt, &format!("manual rollback to {target}"));
    // 先停内核再动目录（同 run_install：运行中的进程会锁住 kernel/ 下的文件）。
    settings_ui::stop_kernel(rt);
    if let Err(e) = swap::rollback_to(&layout, &target) {
        settings_ui::compute_spec_and_start(rt);
        return Err(e);
    }
    settings_ui::compute_spec_and_start(rt);
    let ok = wait_kernel_ready(rt, Duration::from_secs(90));
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    s.kernel.installed_version = swap::read_kernel_version(&layout.kernel_dir);
    let _ = shell_core::settings::write_settings(&rt.settings_path, &s);
    append_main_log(rt, &format!("rollback to {target}: kernel ready = {ok}"));
    emit(app, "kernel://done", serde_json::json!({
        "result": "rolled_back", "version": target, "restored": ok,
    }));
    if ok { Ok(()) } else { Err("回滚后内核未就绪".to_string()) }
}

/// 等待 supervisor 状态转为 Ready（poll 线程在做健康检查）。
fn wait_kernel_ready(rt: &Arc<KernelRuntime>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut sup = match rt.supervisor.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            // 推进状态机（poll_health 幂等，重复调用安全）。
            let _ = sup.poll_health();
            if sup.state() == crate::supervisor::KernelState::Ready {
                return true;
            }
            if sup.state() == crate::supervisor::KernelState::Exhausted {
                return false;
            }
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn iso_now() -> String {
    // 无 chrono 依赖：epoch 秒即可（UI 展示为相对时间）。
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )
}
