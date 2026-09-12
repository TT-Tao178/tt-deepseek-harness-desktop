//! 设置窗口 + Roxy 开关 + 防抖重启内核。
//!
//! - 设置窗口是壳自带的本地页面（ui-stub/settings.html），由托盘「设置…」打开；
//! - Roxy 开关（托盘复选框 / 设置窗口）写 settings.json 后统一走
//!   [`request_kernel_restart`]：3s 防抖（连续切换只重启最后一次）→
//!   重算 --patch 参数 → 停内核 → 带新参数再拉起。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Wry};

use crate::KernelRuntime;

/// 防抖窗口：连续开关只触发最后一次重启。
const DEBOUNCE_MS: u64 = 3000;

/// 打开（或聚焦）设置窗口。创建失败只记 stderr。
pub fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("设置 · TT DeepSeek Harness Desktop")
    // 侧栏 + 三/四段内容区的最小可用尺寸；允许用户拉大。
    .inner_size(880.0, 660.0)
    .min_inner_size(720.0, 520.0)
    .resizable(true)
    .maximizable(false);
    if let Err(e) = builder.build() {
        crate::logln!("[settings] create window failed: {e}");
    }
}

/// Roxy 开关入口（托盘复选框与设置窗口命令都走这里）。
/// v8 语义：Roxy = 插件 `dsh-pet-roxy` 的开关，写 plugins.enabled 后防抖重启内核。
///
/// **必须用设置器而不是切换器**：muda 在 Windows 上于派发菜单事件**之前**
/// 已经把 CheckMenuItem 的勾选反转了（muda-0.19.3 `platform_impl/windows/mod.rs`
/// `MenuItemType::Check => item.set_checked(!item.checked)`），所以事件回调里
/// 读到的 `is_checked()` 已经是「用户想要的新状态」。旧实现把这个新状态又交给
/// 一个 toggle 语义的函数，等于连翻两次——勾选状态回到原样，托盘取消宠物无效。
///
/// 无论写入成功或失败，最后都把托盘勾选对齐到 `enabled`（唯一事实源收敛）。
pub fn set_roxy_enabled(app: &AppHandle, enabled: bool) {
    let Some(rt) = app.try_state::<Arc<KernelRuntime>>() else {
        crate::logln!("[settings] roxy_set: runtime state missing");
        return;
    };
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    let before = shell_core::settings::roxy_enabled(&s);
    crate::logln!("[settings] roxy_set: {before} -> {enabled}");
    if before == enabled {
        return; // 已一致（重复点击）：不重启内核。
    }
    shell_core::settings::set_plugin_enabled(&mut s, shell_core::settings::ROXY_PLUGIN_ID, enabled);
    if let Err(e) = shell_core::settings::write_settings(&rt.settings_path, &s) {
        crate::logln!("[settings] write failed: {e}");
        return;
    }
    crate::logln!("[settings] roxy_set written; scheduling kernel restart");
    request_kernel_restart(&rt);
}

/// 追加一行到 main.log（release 下 stderr 不可靠，诊断统一落盘）。
fn main_log(rt: &KernelRuntime, msg: &str) {
    let path = rt.app_data.join("logs").join("main.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{msg}");
    }
}

/// 请求重启内核（3s 防抖，generation 计数，最后一次生效）。
pub fn request_kernel_restart(rt: &Arc<KernelRuntime>) {
    let gen = rt.generation.fetch_add(1, Ordering::SeqCst) + 1;
    main_log(rt, &format!("[settings] kernel restart requested (gen {gen})"));
    let rt = rt.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(DEBOUNCE_MS));
        if rt.generation.load(Ordering::SeqCst) != gen {
            main_log(&rt, "[settings] debounce superseded; skip");
            return; // 期间又有新的请求，放弃本次
        }
        main_log(&rt, "[settings] debounce fired; recomputing mount and restarting kernel");
        recompute_and_restart(&rt);
        main_log(&rt, "[settings] recompute_and_restart returned");
    });
}

/// 立即重算插件挂载并重启内核（stop → start，端口不变）。
/// 供防抖回调与 service_restart 命令复用；junction + 用户 patch 层幂等重建。
pub fn recompute_and_restart(rt: &KernelRuntime) {
    stop_kernel(rt);
    compute_spec_and_start(rt);
}

/// 停内核并等待其进程树真正退出。
///
/// 换名（kernel/ → kernel-backup/）要求没有任何进程占着内核目录下的文件：
/// Windows 上正在运行的 node.exe 持有自身映像与已加载模块的句柄，直接
/// rename 会拿到「拒绝访问」。kill_tree（taskkill /T /F）发出后进程终止
/// 和句柄释放有短暂延迟，所以要**等到子进程句柄报告退出**再返回（P30）。
///
/// 实现注记：此前一版用「在内核目录旁创建/改名探针文件」判断释放——
/// `kernel_dir.with_extension(..)` 生成的是**兄弟文件**，只验证了父目录
/// 可写，对内核目录本身的占用毫无感知，等于没等。现在直接轮询子进程
/// 句柄的 try_wait，这才是「进程已退出」的第一手证据。
pub fn stop_kernel(rt: &KernelRuntime) {
    {
        let mut sup = match rt.supervisor.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        sup.stop(); // 幂等：kill_tree 整个内核进程树
    }
    // 轮询子进程退出状态（kill 是强杀，通常 <1s；留 15s 上限防挂）。
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let exited = match rt.child_slot.lock() {
            Ok(mut slot) => match slot.as_mut() {
                // 句柄还在：问操作系统要退出状态。
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                // 没有句柄（从未 spawn / 已被取走）：按已退出处理。
                None => true,
            },
            Err(_) => true, // 锁中毒也按已退出处理，不让停机流程卡死
        };
        if exited {
            return;
        }
        if std::time::Instant::now() > deadline {
            crate::logln!("[kernel] stop: child still alive after 15s, proceeding");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 重算插件挂载 → 更新 spec 参数 → 启动内核（不停止，供已 stop 的场景复用）。
pub fn compute_spec_and_start(rt: &KernelRuntime) {
    let settings = shell_core::settings::read_settings(&rt.settings_path);
    crate::apply_plugin_mount(
        rt.app_root.as_deref(),
        &rt.app_data,
        &settings,
        &|msg| crate::logln!("[kernel] {msg}"),
    );
    let (patch_args, _) = crate::compute_mount_plan(rt.app_root.as_deref(), &rt.app_data, &settings);
    if let Ok(mut spec) = rt.spec_slot.lock() {
        spec.patch_args = patch_args;
    }
    let mut sup = match rt.supervisor.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    match sup.start() {
        Ok(()) => crate::logln!("[kernel] restarted with new patch args on port {}", rt.port),
        Err(e) => crate::logln!("[kernel] restart failed: {e}"),
    }
}

/// 确保设置窗口存在时关闭行为同步（预留：设置窗口 UI 在后续阶段接入）。
#[allow(dead_code)]
pub fn window_label() -> &'static str {
    "settings"
}

/// Wry 别名用于签名可读性。
#[allow(dead_code)]
type Window = tauri::WebviewWindow<Wry>;
