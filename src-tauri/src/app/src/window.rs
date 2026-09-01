//! 窗口关闭行为三态（ask / tray / quit）与退出清理。
//!
//! - `ask`  ：关闭时弹原生确认框（tauri-plugin-dialog）。选“退出”→ 先停内核
//!            再放行关闭；选“取消”→ 阻止关闭。
//! - `tray` ：隐藏窗口并阻止关闭（驻留系统托盘）。
//! - `quit` ：直接放行关闭；内核停止统一由 `run()` 的 `RunEvent::Exit` 处理。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{App, AppHandle, CloseRequestApi, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::supervisor::Supervisor;

/// 已管理的 tauri State：settings.json 的绝对路径。
/// 每次关闭请求时现读，保证取到最新的 close_behavior。
pub struct SettingsPath(pub PathBuf);

/// 在 setup 中调用：把 settings.json 路径放入 tauri State，
/// 并在主窗口上注册关闭事件处理。
pub fn init(app: &App) {
    if let Ok(app_data) = app.path().app_data_dir() {
        app.manage(SettingsPath(app_data.join("settings.json")));
    }
    let Some(window) = app.get_webview_window("main") else {
        return; // 无主窗口（配置保证存在），跳过。
    };
    // 用户在确认框选“退出”后置位：放行紧随其后的第二次 CloseRequested，
    // 避免 window.close() 再次触发确认框造成循环。
    let approved = Arc::new(AtomicBool::new(false));
    let handler_window = window.clone();
    window.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        if approved.load(Ordering::Relaxed) {
            return; // 已确认退出，放行本次关闭。
        }
        handle_close_request(&handler_window, api, approved.clone());
    });
}

/// 按 close_behavior 处理一次关闭请求。
fn handle_close_request(window: &WebviewWindow, api: &CloseRequestApi, approved: Arc<AtomicBool>) {
    match current_close_behavior(window).as_str() {
        // tray：隐藏窗口并阻止关闭。
        "tray" => {
            let _ = window.hide();
            api.prevent_close();
        }
        // quit：放行关闭；内核清理在 RunEvent::Exit 统一处理。
        "quit" => {}
        // ask（含未知值，回退默认 ask）：先阻止关闭，再弹原生确认框。
        _ => {
            api.prevent_close();
            ask_confirm_close(window, approved);
        }
    }
}

/// 读取当前 close_behavior；settings.json 缺失/损坏时 read_settings 返回默认 ask。
fn current_close_behavior(window: &WebviewWindow) -> String {
    match window.try_state::<SettingsPath>() {
        Some(state) => shell_core::settings::read_settings(&state.0).close_behavior,
        None => "ask".to_string(),
    }
}

/// 弹原生确认框。选“退出”→ 停内核并放行关闭；其余选择什么都不做（窗口保持打开）。
///
/// tauri-plugin-dialog 2.7 的按钮枚举没有 `YesNoCustom`，两枚自定义按钮对应
/// `OkCancelCustom`；`show` 回调的 `bool` 为“是否按下确认（OK/Yes）按钮”。
fn ask_confirm_close(window: &WebviewWindow, approved: Arc<AtomicBool>) {
    let window = window.clone();
    window
        .app_handle()
        .dialog()
        .message("确认退出?")
        .title("TT DeepSeek Harness Desktop")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "退出".to_string(),
            "取消".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                stop_supervisor(window.app_handle());
                approved.store(true, Ordering::Relaxed);
                let _ = window.close(); // 第二次 CloseRequested 由 approved 放行
            }
        });
}

/// 从 tauri State 取 supervisor 并 stop()（kill 内核进程树）。
/// State 未管理（如内核目录缺失导致 setup_kernel 提前返回）时静默跳过，不 panic。
pub fn stop_supervisor(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<Mutex<Supervisor>>>() {
        let mut sup = match state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        sup.stop();
    }
}
