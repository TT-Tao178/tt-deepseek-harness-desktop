//! 窗口关闭行为三态（ask / tray / quit）与退出清理。
//!
//! - `ask`  ：关闭时弹原生确认框（tauri-plugin-dialog）。选“退出”→ 先停内核
//!            再放行关闭；选“取消”→ 阻止关闭。
//! - `tray` ：隐藏窗口并阻止关闭（驻留系统托盘）。
//! - `quit` ：直接放行关闭；内核停止统一由 `run()` 的 `RunEvent::Exit` 处理。

use std::sync::Arc;

use tauri::{App, AppHandle, CloseRequestApi, Manager, WebviewWindow, WindowEvent};

use crate::KernelRuntime;

/// 在 setup 中调用：把 settings.json 路径放入 tauri State，
/// 并在主窗口上注册关闭事件处理。
pub fn init(app: &App) {
    let Some(window) = app.get_webview_window("main") else {
        return; // 无主窗口（配置保证存在），跳过。
    };
    let handler_window = window.clone();
    window.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        handle_close_request(&handler_window, api);
    });
}

/// 按 close_behavior 处理一次关闭请求。
fn handle_close_request(window: &WebviewWindow, api: &CloseRequestApi) {
    match current_close_behavior(window).as_str() {
        // tray：隐藏窗口并阻止关闭。
        "tray" => {
            let _ = window.hide();
            api.prevent_close();
        }
        // quit：放行关闭；内核清理在 RunEvent::Exit 统一处理。
        "quit" => {}
        // ask（含未知值，回退默认 ask）：先阻止关闭，再弹三选项对话框
        // （退出到托盘 / 关闭程序 / 取消 + 「不再弹出询问」）。
        _ => {
            api.prevent_close();
            open_close_dialog(window.app_handle());
        }
    }
}

/// 关闭确认对话框：应用启动时**预创建并隐藏**（webview 已就绪），点 × 时
/// 仅 show + 居中 + 聚焦——毫秒级出现，消除「现场新建 webview 的卡顿」与
/// 置顶窗口切换的闪烁（P33）。选择完成后 hide 复用，不销毁。
pub fn precreate_close_dialog(app: &AppHandle) {
    if app.get_webview_window("close-dialog").is_some() {
        return;
    }
    if let Err(e) = build_close_dialog(app) {
        crate::logln!("[close-dialog] precreate failed: {e}");
    }
}

fn build_close_dialog(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    tauri::WebviewWindowBuilder::new(
        app,
        "close-dialog",
        tauri::WebviewUrl::App("close-dialog.html".into()),
    )
    .title("关闭应用")
    .inner_size(440.0, 240.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    // skip_taskbar：对话框不应在任务栏闪现图标；不再用 always_on_top
    //（置顶窗口的创建/Z 序切换是视觉闪烁来源之一，P33）。
    .skip_taskbar(true)
    .decorations(true)
    .visible(false)
    .build()
}

/// 打开（或聚焦）关闭确认对话框。
fn open_close_dialog(app: &AppHandle) {
    let Some(window) = app.get_webview_window("close-dialog") else {
        // 预创建失败过（罕见）：退回现场创建并直接显示。
        match build_close_dialog(app) {
            Ok(w) => {
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => crate::logln!("[close-dialog] create failed: {e}"),
        }
        return;
    };
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 关闭对话框按钮入口（close-dialog.html 调用）。
/// - tray ：remember → 持久化 close_behavior=tray；随后隐藏主窗口。
/// - quit ：remember → 持久化 close_behavior=quit；随后整体退出（RunEvent::Exit 统一停内核）。
/// - 其他 ：仅关闭对话框（取消）。
#[tauri::command]
pub fn close_dialog_action(app: AppHandle, action: String, remember: bool) {
    let persist = |value: &str| {
        if let Some(rt) = app.try_state::<Arc<KernelRuntime>>() {
            let mut s = shell_core::settings::read_settings(&rt.settings_path);
            shell_core::settings::set_close_behavior(&mut s, value);
            if let Err(e) = shell_core::settings::write_settings(&rt.settings_path, &s) {
                crate::logln!("[close-dialog] persist failed: {e}");
            }
        }
    };
    match action.as_str() {
        "tray" => {
            if remember {
                persist("tray");
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            if let Some(w) = app.get_webview_window("close-dialog") {
                let _ = w.hide(); // 复用，不销毁
            }
        }
        "quit" => {
            if remember {
                persist("quit");
            }
            // 先隐藏对话框再退出，减少销毁顺序上的视觉抖动（P33）。
            if let Some(w) = app.get_webview_window("close-dialog") {
                let _ = w.hide();
            }
            app.exit(0); // RunEvent::Exit 统一停内核
        }
        _ => {
            if let Some(w) = app.get_webview_window("close-dialog") {
                let _ = w.hide();
            }
        }
    }
}

/// 读取当前 close_behavior；settings.json 缺失/损坏时 read_settings 返回默认 ask。
fn current_close_behavior(window: &WebviewWindow) -> String {
    match window.try_state::<Arc<KernelRuntime>>() {
        Some(rt) => shell_core::settings::read_settings(&rt.settings_path).close_behavior,
        None => "ask".to_string(),
    }
}


/// 从 tauri State 取 KernelRuntime 并 stop()（kill 内核进程树）。
/// State 未管理（如内核目录缺失导致 setup_kernel 提前返回）时静默跳过，不 panic。
pub fn stop_supervisor(app: &AppHandle) {
    if let Some(rt) = app.try_state::<Arc<KernelRuntime>>() {
        let mut sup = match rt.supervisor.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        sup.stop();
    }
}
