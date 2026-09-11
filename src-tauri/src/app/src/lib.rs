mod menu;
pub mod settings_ui;
mod supervisor;
pub mod window;

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use supervisor::{HealthResult, KernelOps, KernelState, Supervisor};

/// 内核运行时共享态：spec 可被换参（Roxy 开关 / 插件开关 / 内核更新后重启），
/// supervisor 供命令与更新流程复用，generation 驱动防抖重启。
pub struct KernelRuntime {
    pub spec_slot: Arc<Mutex<kernel_process::spawn_spec::KernelSpec>>,
    pub supervisor: Arc<Mutex<Supervisor>>,
    pub app_data: PathBuf,
    pub settings_path: PathBuf,
    pub app_root: Option<PathBuf>,
    pub port: u16,
    generation: AtomicU64,
}

impl KernelRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        spec_slot: Arc<Mutex<kernel_process::spawn_spec::KernelSpec>>,
        supervisor: Arc<Mutex<Supervisor>>,
        app_data: PathBuf,
        settings_path: PathBuf,
        app_root: Option<PathBuf>,
        port: u16,
    ) -> Self {
        KernelRuntime {
            spec_slot,
            supervisor,
            app_data,
            settings_path,
            app_root,
            port,
            generation: AtomicU64::new(0),
        }
    }

    /// 用户导入插件的目录（`<userData>/plugins/`）。
    pub fn user_plugins_dir(&self) -> PathBuf {
        self.app_data.join("plugins")
    }
}

/// 真实内核操作：按 spec_slot 里当前的 KernelSpec 启动 node 进程，
/// stdout/stderr 落盘 logs/kernel.log；健康探测走 kernel-process::health，
/// 终止走 kill_tree。spec_slot 允许运行期换参（重启后生效）。
struct RealOps {
    spec_slot: Arc<Mutex<kernel_process::spawn_spec::KernelSpec>>,
    port: u16,
    log_path: PathBuf,
    child_slot: Arc<Mutex<Option<Child>>>,
}

impl KernelOps for RealOps {
    fn spawn(&mut self) -> Result<u32, String> {
        let spec = self
            .spec_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let mut cmd = spec.command();
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

/// 插件发现：内置目录（app_root/plugins）+ 用户目录（userData/plugins）。
/// app_root 为 None 时只扫用户目录。
fn discover_all_plugins(app_root: Option<&Path>, app_data: &Path) -> Vec<shell_core::plugin_discovery::PluginInfo> {
    let bundled = app_root.map(|r| r.join("plugins"));
    let bundled_ref = bundled.as_deref().unwrap_or(Path::new(""));
    shell_core::plugin_discovery::discover_plugins(bundled_ref, &app_data.join("plugins"))
}

/// 按 settings 计算 --patch 参数：valid ∧ enabled 的插件按发现顺序拼接。
fn compute_patch_args(
    app_root: Option<&Path>,
    app_data: &Path,
    settings: &shell_core::settings::AppSettings,
) -> Vec<String> {
    let plugins = discover_all_plugins(app_root, app_data);
    shell_core::plugin_discovery::resolve_enabled_patch_args(&plugins, |p| {
        shell_core::settings::is_plugin_enabled(settings, &p.id, p.source == shell_core::plugin_discovery::PluginSource::Bundled)
    })
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
fn service_get_status(state: tauri::State<'_, Arc<KernelRuntime>>) -> String {
    let sup = lock(&state.supervisor);
    let payload = serde_json::json!({
        "state": format!("{:?}", sup.state()),
        "port": sup.ready_port(),
    });
    serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn service_restart(state: tauri::State<'_, Arc<KernelRuntime>>) -> Result<String, String> {
    // 与 Roxy 开关同路径：重算 --patch 参数 → stop → start。
    settings_ui::recompute_and_restart(&state);
    let sup = lock(&state.supervisor);
    let payload = serde_json::json!({
        "state": format!("{:?}", sup.state()),
        "port": sup.ready_port(),
    });
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_get(state: tauri::State<'_, Arc<KernelRuntime>>) -> String {
    let s = shell_core::settings::read_settings(&state.settings_path);
    serde_json::to_string(&s).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn roxy_set(app: tauri::AppHandle, enabled: bool) {
    settings_ui::toggle_roxy(&app, enabled);
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
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

    // --- b. 插件发现 + junction：dsh-home/node_modules/<id> <- 插件真身 ---
    let app_root = app_root_from_exe();
    if app_root.is_none() {
        append_log(&main_log, "[setup] app root not found; skipping junctions and plugin patches");
    }
    let settings_path = app_data.join("settings.json");
    let settings = shell_core::settings::read_settings(&settings_path);
    let home_node_modules = dsh_home.join("node_modules");
    if let Err(e) = std::fs::create_dir_all(&home_node_modules) {
        append_log(&main_log, &format!("[setup] create home/node_modules failed: {e}"));
    }
    let plugins = discover_all_plugins(app_root.as_deref(), &app_data);
    for p in plugins.iter().filter(|p| !p.valid) {
        append_log(
            &main_log,
            &format!(
                "[setup] invalid plugin {} ({}): {}",
                p.id,
                if p.source == shell_core::plugin_discovery::PluginSource::Bundled { "bundled" } else { "user" },
                p.invalid_reason.as_deref().unwrap_or("?")
            ),
        );
    }
    let links = shell_core::plugin_discovery::junction_targets(&plugins);
    if links.is_empty() {
        append_log(&main_log, "[setup] no valid plugins found; skipping junctions");
    } else {
        for err in shell_core::plugins::ensure_junctions(&home_node_modules, &links) {
            append_log(&main_log, &format!("[setup] junction: {err}"));
        }
    }

    // --- c. --patch 参数 ---
    let patch_args = compute_patch_args(app_root.as_deref(), &app_data, &settings);
    append_log(&main_log, &format!("[setup] patch args: {patch_args:?}"));

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
        .as_ref()
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
    let spec_slot = Arc::new(Mutex::new(spec));
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let ops = RealOps {
        spec_slot: spec_slot.clone(),
        port,
        log_path: paths.kernel_log(),
        child_slot: child_slot.clone(),
    };
    let mut supervisor = Supervisor::new(Box::new(ops));
    supervisor.set_ready_port(port);
    let supervisor = Arc::new(Mutex::new(supervisor));
    let runtime = Arc::new(KernelRuntime::new(
        spec_slot,
        supervisor.clone(),
        app_data.clone(),
        settings_path,
        app_root,
        port,
    ));
    app.manage(runtime.clone());
    append_log(
        &main_log,
        &format!(
            "[setup] supervisor managed (kernel dir={}, port={port})",
            kernel_dir.display()
        ),
    );

    // --- e. spawn 内核 + poll 线程（Ready 后主窗口导航到内核页面）---
    match lock(&supervisor).start() {
        Ok(()) => append_log(&main_log, &format!("[setup] kernel spawn requested on port {port}")),
        Err(e) => append_log(&main_log, &format!("[setup] kernel start failed: {e}")),
    }
    spawn_poll_thread(app.handle().clone(), supervisor, child_slot);

    // --- f. 托盘（Roxy 勾选状态与设置一致）---
    menu::init(app, settings.roxy.enabled);
}

/// 一个 poll 线程，每 200ms：Starting/Ready 时检测进程退出（try_wait → on_exit）
/// 并 poll_health；Crashed 时调 restart（内部等待退避延迟）。
/// 首次 Ready 时把主窗口导航到内核页面（ui-stub 启动页被替换）。
fn spawn_poll_thread(
    handle: tauri::AppHandle,
    sup_state: Arc<Mutex<Supervisor>>,
    child_slot: Arc<Mutex<Option<Child>>>,
) {
    let navigated = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        let mut sup = lock(&sup_state);
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
                        if !navigated.swap(true, Ordering::Relaxed) {
                            navigate_main_to_kernel(&handle, sup.ready_port());
                        }
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

/// 主窗口导航到内核 Web UI（仅首次 Ready 调用一次）。
fn navigate_main_to_kernel(handle: &tauri::AppHandle, port: Option<u16>) {
    let Some(port) = port else { return };
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let url = format!("http://127.0.0.1:{port}/");
    match tauri::Url::parse(&url) {
        Ok(u) => {
            if let Err(e) = window.navigate(u) {
                eprintln!("[window] navigate failed ({url}): {e}");
                // 兜底：让页面自己跳过去。
                let _ = window.eval(&format!("location.replace('{url}')"));
            } else {
                eprintln!("[window] navigated to {url}");
            }
        }
        Err(e) => eprintln!("[window] bad url {url}: {e}"),
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例时聚焦主窗口。
            menu::focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            setup_kernel(app);
            window::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            service_get_status,
            service_restart,
            settings_get,
            roxy_set
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // 退出前统一停内核（ask/quit 两条关闭路径都会走到这里；stop 幂等）。
        tauri::RunEvent::Exit => window::stop_supervisor(app_handle),
        _ => {}
    });
}
