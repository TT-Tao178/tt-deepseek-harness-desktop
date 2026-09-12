mod kernel_manager;
mod menu;
mod plugin_manager;
pub mod settings_ui;
mod supervisor;
pub mod window;

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use supervisor::{HealthResult, KernelOps, KernelState, Supervisor};

/// 内核运行时共享态：spec 可被换参（Roxy 开关 / 插件开关 / 内核更新后重启），
/// supervisor 供命令与更新流程复用，generation 驱动防抖重启。
pub struct KernelRuntime {
    pub spec_slot: Arc<Mutex<kernel_process::spawn_spec::KernelSpec>>,
    pub supervisor: Arc<Mutex<Supervisor>>,
    /// 内核子进程句柄（RealOps spawn 时写入）。stop_kernel 用它等待
    /// 进程**真正退出**——kill_tree 之后 Windows 释放可执行文件锁有延迟，
    /// 换名（kernel/ → kernel-backup/）必须等锁消失（P30）。
    pub child_slot: Arc<Mutex<Option<Child>>>,
    pub app_data: PathBuf,
    pub settings_path: PathBuf,
    pub app_root: Option<PathBuf>,
    pub port: u16,
    generation: AtomicU64,
}

impl KernelRuntime {
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        spec_slot: Arc<Mutex<kernel_process::spawn_spec::KernelSpec>>,
        supervisor: Arc<Mutex<Supervisor>>,
        child_slot: Arc<Mutex<Option<Child>>>,
        app_data: PathBuf,
        settings_path: PathBuf,
        app_root: Option<PathBuf>,
        port: u16,
    ) -> Self {
        KernelRuntime {
            spec_slot,
            supervisor,
            child_slot,
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
pub(crate) fn locate_kernel_dir(app_root: &Path) -> Option<PathBuf> {
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

/// 挂载计划（v8 机制）：
/// - **全部 valid 插件都参与挂载**（junction + --patch，顺序 = 发现顺序）；
/// - 禁用的插件通过内核「用户 patch 层」的 `disabled: true` 条目实现
///   （官方机制：后应用层同 id 一票否决；路由/组合里不再出现）。
/// 返回（--patch 参数序列， 需禁用的 insert id 列表）。
fn compute_mount_plan(
    app_root: Option<&Path>,
    app_data: &Path,
    settings: &shell_core::settings::AppSettings,
) -> (Vec<String>, Vec<String>) {
    let plugins = discover_all_plugins(app_root, app_data);
    let mut patch_args = Vec::new();
    let mut disabled_ids = Vec::new();
    for p in plugins.iter().filter(|p| p.valid) {
        patch_args.push("--patch".to_string());
        patch_args.push(p.patch_path.to_string_lossy().into_owned());
        let enabled = shell_core::settings::is_plugin_enabled(
            settings,
            &p.id,
            p.source == shell_core::plugin_discovery::PluginSource::Bundled,
        );
        if !enabled {
            let mut ids = shell_core::plugins::parse_insert_ids(&p.patch_path);
            if ids.is_empty() {
                ids.push(p.id.clone()); // 降级：patch 解析失败时按模块名禁用
            }
            disabled_ids.extend(ids);
        }
    }
    (patch_args, disabled_ids)
}

/// 应用插件挂载：junction（valid 全集，幂等）+ 用户 patch 层（禁用条目）。
/// 启动前与每次插件开关重启前调用；失败只记日志不 panic。
fn apply_plugin_mount(
    app_root: Option<&Path>,
    app_data: &Path,
    settings: &shell_core::settings::AppSettings,
    log: &dyn Fn(String),
) {
    let plugins = discover_all_plugins(app_root, app_data);
    let links = shell_core::plugin_discovery::junction_targets(&plugins);
    let home_nm = app_data.join("dsh-home").join("node_modules");
    let _ = std::fs::create_dir_all(&home_nm);
    // 清理不再存在的插件留下的过期 junction（如已移除的 tt-bg）。
    // dsh-home/node_modules 内的链接全部由壳创建；只摘 reparse point
    // （junction/符号链接），绝不递归删除真实目录。
    let valid_ids: Vec<String> = links.iter().map(|(id, _)| id.clone()).collect();
    let is_reparse = |path: &Path| {
        std::fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    };
    let prune = |path: &Path, display: &str| {
        if !is_reparse(path) {
            return; // 真实目录不碰
        }
        let gone = !path.exists(); // 链接目标已消失
        let unmanaged = !display.starts_with('@') && !valid_ids.iter().any(|v| v == display);
        let scope_stale = display.starts_with('@') && {
            // scope 链接形如 "@scope/pkg"（在 valid_ids 里带斜杠），单层目录不会出现
            false
        };
        let _ = scope_stale;
        if gone || unmanaged {
            match std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path)) {
                Ok(()) => log(format!("pruned stale junction: {display}")),
                Err(e) => log(format!("prune {display} failed: {e}")),
            }
        }
    };
    if let Ok(entries) = std::fs::read_dir(&home_nm) {
        for e in entries.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if name.starts_with('@') {
                if let Ok(inner) = std::fs::read_dir(&path) {
                    for x in inner.filter_map(|x| x.ok()) {
                        let sub = format!("{name}/{}", x.file_name().to_string_lossy());
                        prune(&x.path(), &sub);
                    }
                }
                // scope 目录若已空且非 reparse，留给 ensure_junctions 复用
            } else {
                prune(&path, &name);
            }
        }
    }
    for err in shell_core::plugins::ensure_junctions(&home_nm, &links) {
        log(err);
    }
    let (_, disabled_ids) = compute_mount_plan(app_root, app_data, settings);
    let user_patch = app_data
        .join("dsh-home")
        .join("profiles")
        .join("web")
        .join("cordis.patch.yml");
    if let Err(e) = shell_core::plugins::write_user_patch_layer(&user_patch, &disabled_ids) {
        log(format!("user patch layer: {e}"));
    }
}


/// stderr 输出（忽略写入失败）。
///
/// GUI 进程（windows_subsystem=windows）的 stderr 可能是空设备或已断开的
/// 管道；`eprintln!` 在写失败时会 **panic 并杀死调用线程**——poll 线程一旦
/// 被杀，崩溃自愈与页面重载全部静默失效（P31）。所有运行期诊断一律走本函数。
#[macro_export]
macro_rules! logln {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = std::io::stderr().write_all(format!($($arg)*).as_bytes());
    }};
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
    settings_ui::set_roxy_enabled(&app, enabled);
}

#[tauri::command]
fn settings_set_close_behavior(
    state: tauri::State<'_, Arc<KernelRuntime>>,
    value: String,
) -> bool {
    let mut s = shell_core::settings::read_settings(&state.settings_path);
    let before = s.close_behavior.clone();
    shell_core::settings::set_close_behavior(&mut s, &value);
    let changed = s.close_behavior != before;
    if changed {
        if let Err(e) = shell_core::settings::write_settings(&state.settings_path, &s) {
            logln!("[settings] write close_behavior failed: {e}");
            return false;
        }
    }
    changed
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
            logln!("[setup] app_data_dir failed: {e}");
            return;
        }
    };

    // --- a. 日志目录 + DSH_HOME ---
    let logs_dir = app_data.join("logs");
    if let Err(e) = std::fs::create_dir_all(&logs_dir) {
        logln!("[setup] create logs dir failed: {e}");
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

    // --- b. 插件发现 + 挂载（junction 全集 + 用户 patch 层禁用条目）---
    let app_root = app_root_from_exe();
    if app_root.is_none() {
        append_log(&main_log, "[setup] app root not found; skipping junctions and plugin patches");
    }
    let settings_path = app_data.join("settings.json");
    let settings = shell_core::settings::read_settings(&settings_path);
    apply_plugin_mount(
        app_root.as_deref(),
        &app_data,
        &settings,
        &|msg| append_log(&main_log, &format!("[setup] {msg}")),
    );

    // --- c. --patch 参数 ---
    let (patch_args, disabled_ids) = compute_mount_plan(app_root.as_deref(), &app_data, &settings);
    append_log(&main_log, &format!("[setup] patch args: {patch_args:?}"));
    append_log(&main_log, &format!("[setup] disabled plugin ids: {disabled_ids:?}"));

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
        child_slot.clone(),
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
    spawn_poll_thread(app.handle().clone(), supervisor, child_slot, paths.kernel_log());

    // --- f. 托盘（Roxy 勾选状态与设置一致）---
    // 必须从 plugins.enabled 判定：legacy 的 `roxy.enabled` 是 skip_serializing，
    // 首次写回后恒为默认值，用它初始化会让托盘勾选与真实状态不符。
    menu::init(app);
}

/// 一个 poll 线程，每 200ms：Starting/Ready 时检测进程退出（try_wait → on_exit）
/// 并 poll_health；Crashed 时调 restart（内部等待退避延迟）。
///
/// 主窗口（重）导航时机（P28）：
/// - 首次 Ready：导航到内核 URL（启动页被替换）；
/// - **Ready 边沿**（上一轮不是 Ready、这一轮 Ready）：说明内核经历了一次
///   重启（Roxy/插件开关、service_restart、内核更新、回滚）。此时必须把
///   主窗口**重新导航**——旧页面里已注入的插件脚本（如宠物）不会因为内核
///   重启而消失，不重载用户就会看到「开关没用」；同时新内核（0.1.5+）的
///   地址带一次性 token，裸 URL 会 401，所以重导航的 URL 从 kernel.log 的
///   `dsh web:` 行提取（P29）。
fn spawn_poll_thread(
    handle: tauri::AppHandle,
    sup_state: Arc<Mutex<Supervisor>>,
    child_slot: Arc<Mutex<Option<Child>>>,
    kernel_log: PathBuf,
) {
    let mut nav: Option<(String, u64)> = None; // 主窗导航状态（见 navigate_main_to_kernel）
    // Ready 边沿检测：只有「非 Ready → Ready」的跳变才触发（重）导航。
    let mut was_ready = false;
    // 重载节流：同一端口 5 秒内只（重）导航一次，防防抖期连点导致连环刷新。
    let mut last_nav: Option<std::time::Instant> = None;
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
                let port = sup.ready_port();
                match sup.poll_health() {
                    HealthResult::Ready => {
                        if nav.is_none() {
                            navigate_main_to_kernel(&handle, port, &kernel_log, &mut nav);
                        } else if !was_ready {
                            // 内核重启后的 Ready 边沿：主窗必须重载，
                            // 否则旧页面里已注入的插件（宠物）不会消失（P28）。
                            logln!("[kernel-supervisor] kernel restart detected; reloading main window");
                            navigate_main_to_kernel(&handle, port, &kernel_log, &mut nav);
                        }
                        was_ready = true;
                    }
                    HealthResult::Crashed => {
                        was_ready = false;
                        logln!("[kernel-supervisor] kernel crashed; scheduling restart")
                    }
                    HealthResult::Exhausted => {
                        was_ready = false;
                        logln!("[kernel-supervisor] kernel backoff exhausted")
                    }
                    HealthResult::StillStarting => {
                        was_ready = false;
                    }
                }
            }
            KernelState::Crashed => {
                was_ready = false;
                if let Err(e) = sup.restart() {
                    logln!("[kernel-supervisor] restart failed: {e}");
                }
            }
            KernelState::Stopped | KernelState::Exhausted => {
                was_ready = false;
                drop(sup);
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
        }
    });
}

/// 从 kernel.log 的 `[min_offset,)` 区间提取内核 Web 地址
/// （最后一条 `dsh web:` 且端口匹配的行）。
///
/// 返回 (url, 匹配行之后的文件偏移)。新版内核（0.1.5+）对根路径加了 token
/// 鉴权，启动时把带 token 的完整地址打到 stdout（`dsh web:
/// http://127.0.0.1:<port>/?token=...`）；旧版打印无 token 地址。kernel.log
/// 追加写、跨多次启动：用偏移区间保证读到的是**本次启动**打印的行，而不是
/// 上一个进程留下的旧行（旧 token 已失效，拿去导航必 401）。
fn kernel_web_url_from_log(kernel_log: &Path, port: u16, min_offset: u64) -> Option<(String, u64)> {
    let raw = std::fs::read(kernel_log).ok()?;
    let fresh = raw.get(min_offset as usize..).unwrap_or(&[]);
    let marker = format!("127.0.0.1:{port}");
    let text = String::from_utf8_lossy(fresh);
    let mut found = None;
    let mut consumed = min_offset;
    for line in text.lines() {
        let line_start = consumed;
        consumed += line.len() as u64 + 1; // 近似行宽（含换行），够定位用
        if line.contains("dsh web:") && line.contains(&marker) {
            if let Some(url) = line.rsplit("dsh web:").next().map(str::trim) {
                if url.starts_with("http://") {
                    found = Some((url.to_string(), line_start + line.len() as u64));
                }
            }
        }
    }
    found
}

/// 主窗口（重）导航到内核 Web UI。
///
/// - `nav`（线程内持有的状态）：None=首次导航；Some((上次 url, 上次日志偏移))
///   =内核重启后的重导航——只认日志里**新产生**的行（偏移之后），避免拿到
///   上一进程的旧 token；6 秒内没等到新行就退回裸 URL / 原 URL 重载。
fn navigate_main_to_kernel(
    handle: &tauri::AppHandle,
    port: Option<u16>,
    kernel_log: &Path,
    nav: &mut Option<(String, u64)>,
) {
    let Some(port) = port else { return };
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let plain = format!("http://127.0.0.1:{port}/");
    let min_offset = nav.as_ref().map(|(_, off)| *off).unwrap_or(0);

    // 最多 ~6s：内核通常在端口可连前后就把 `dsh web:` 行打出来了。
    let mut resolved = None;
    for _ in 0..30 {
        if let Some((url, off)) = kernel_web_url_from_log(kernel_log, port, min_offset) {
            resolved = Some((url, off));
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let (url, off) = resolved.unwrap_or_else(|| {
        let fallback = nav.as_ref().map(|(u, _)| u.clone()).unwrap_or_else(|| plain.clone());
        (fallback, min_offset)
    });

    let is_reload = nav.as_ref().map(|(u, _)| *u == url).unwrap_or(false);
    *nav = Some((url.clone(), off));

    if is_reload {
        // 同地址（如旧版内核重启，行里没有变化）：直接刷新页面即可。
        if let Err(e) = window.eval("location.reload()") {
            logln!("[window] reload failed: {e}");
        } else {
            logln!("[window] main window reloaded ({url})");
        }
        return;
    }
    match tauri::Url::parse(&url) {
        Ok(u) => {
            if let Err(e) = window.navigate(u) {
                logln!("[window] navigate failed ({url}): {e}");
                // 兜底：让页面自己跳过去。
                let _ = window.eval(&format!("location.replace('{url}')"));
            } else {
                logln!("[window] navigated to {url}");
            }
        }
        Err(e) => logln!("[window] bad url {url}: {e}"),
    }
}

/// 主窗注入脚本：右上角「设置」齿轮（仅内核页面，tauri:// 页面不注入）。
/// 点击导航到 ttshell://settings，由主窗 on_navigation 拦截并打开设置窗口
/// （远程页面被 ACL 禁止直接调用壳命令，scheme 导航是唯一通道，见 P35）。
const MAIN_INJECT: &str = r#"(function () {
  if (location.hostname !== '127.0.0.1') return;
  if (document.getElementById('ttshell-settings-btn')) return;
  function mount() {
    if (document.getElementById('ttshell-settings-btn')) return;
    var b = document.createElement('div');
    b.id = 'ttshell-settings-btn';
    b.title = '设置';
    b.style.cssText = 'position:fixed;top:14px;right:14px;width:36px;height:36px;' +
      'border-radius:50%;background:rgba(15,23,42,.55);backdrop-filter:blur(6px);' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'z-index:2147483647;transition:transform .15s,background .15s;user-select:none;';
    b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
    b.addEventListener('mouseenter', function () { b.style.transform = 'scale(1.08)'; b.style.background = 'rgba(15,23,42,.75)'; });
    b.addEventListener('mouseleave', function () { b.style.transform = 'scale(1)'; b.style.background = 'rgba(15,23,42,.55)'; });
    b.addEventListener('click', function () { location.href = 'ttshell://settings'; });
    document.documentElement.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();"#;

/// 代码构建主窗（原 tauri.conf.json windows[0]）：
/// - `on_navigation` 拦截 `ttshell://` scheme（设置入口通道，P35）；
/// - 深色窗口背景（reload 期间无白闪，P36）。
fn build_main_window(handle: &tauri::AppHandle) {
    let nav_handle = handle.clone();
    let builder = tauri::WebviewWindowBuilder::new(
        handle,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("TT DeepSeek Harness Desktop")
    .inner_size(1280.0, 800.0)
    .background_color(tauri::window::Color(0x10, 0x14, 0x18, 0xff))
    .initialization_script(MAIN_INJECT)
    .on_navigation(move |url| {
        if url.scheme() == "ttshell" {
            // 设置入口：延时线程打开，避免在导航回调里同步建窗。
            let h = nav_handle.clone();
            std::thread::spawn(move || {
                crate::settings_ui::open_settings_window(&h);
            });
            return false; // 阻止真实导航
        }
        true
    });
    if let Err(e) = builder.build() {
        crate::logln!("[window] main window build failed: {e}");
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
            build_main_window(app.handle());
            setup_kernel(app);
            window::init(app);
            // 关闭对话框预创建（隐藏），点 × 秒开（P33）。
            window::precreate_close_dialog(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            service_get_status,
            service_restart,
            settings_get,
            settings_set_close_behavior,
            roxy_set,
            kernel_manager::kernel_status,
            kernel_manager::kernel_set_registry,
            kernel_manager::kernel_check_updates,
            kernel_manager::kernel_install,
            kernel_manager::kernel_cancel,
            kernel_manager::kernel_rollback,
            plugin_manager::plugin_list,
            plugin_manager::plugin_set_enabled,
            plugin_manager::plugin_import,
            plugin_manager::plugin_remove,
            window::close_dialog_action
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // 退出前统一停内核（ask/quit 两条关闭路径都会走到这里；stop 幂等）。
        tauri::RunEvent::Exit => window::stop_supervisor(app_handle),
        _ => {}
    });
}
