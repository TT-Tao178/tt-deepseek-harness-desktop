//! 系统托盘：显示主窗口 / 设置 / Roxy 桌宠开关 / 退出。
//!
//! Roxy 复选框与设置面板共用同一事实源（settings.json → `plugins.enabled`）：
//! 勾选变化时调用 [`crate::settings_ui::set_roxy_enabled`]（含 3s 防抖重启内核）。
//!
//! 注意：muda 会在派发菜单事件**之前**反转 CheckMenuItem 的勾选，所以回调里
//! `is_checked()` 读到的就是用户想要的新状态，必须按「设置器」语义下发，
//! 不能再做一次取反（P22）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager, Wry};

/// 托盘里可动态更新的控件句柄（勾选状态回写）。
pub struct TrayState {
    pub roxy_item: CheckMenuItem<Wry>,
}

pub const MENU_SHOW: &str = "show";
pub const MENU_SETTINGS: &str = "settings";
pub const MENU_ROXY: &str = "roxy";
pub const MENU_QUIT: &str = "quit";

/// 在 setup 阶段创建托盘。失败只记 stderr，不阻塞应用启动。
pub fn init(app: &App, roxy_enabled: bool) {
    let show = match MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("show item", e),
    };
    let settings = match MenuItem::with_id(app, MENU_SETTINGS, "设置…", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("settings item", e),
    };
    let roxy = match CheckMenuItem::with_id(app, MENU_ROXY, "Roxy 桌宠", true, roxy_enabled, None::<&str>)
    {
        Ok(i) => i,
        Err(e) => return tray_skip("roxy item", e),
    };
    let quit = match MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("quit item", e),
    };
    // 用分组线把「窗口操作 / 挂件开关 / 退出」分开，菜单长了也不糊成一片。
    let sep_a = match PredefinedMenuItem::separator(app) {
        Ok(i) => i,
        Err(e) => return tray_skip("separator 1", e),
    };
    let sep_b = match PredefinedMenuItem::separator(app) {
        Ok(i) => i,
        Err(e) => return tray_skip("separator 2", e),
    };
    let menu = match Menu::with_items(app, &[&show, &settings, &sep_a, &roxy, &sep_b, &quit]) {
        Ok(m) => m,
        Err(e) => return tray_skip("menu", e),
    };

    let roxy_handle = roxy.clone();
    // 托盘图标 = 应用图标（与任务栏/exe 图标同源：icons/icon.ico）。
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))
        .map_err(|e| format!("decode tray icon: {e}"));
    let builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("TT DeepSeek Harness Desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let app: &AppHandle = app;
            match event.id().as_ref() {
                MENU_SHOW => focus_main(app),
                MENU_SETTINGS => crate::settings_ui::open_settings_window(app),
                MENU_ROXY => {
                    // 勾选状态**已经**被 muda 反转（见 settings_ui::set_roxy_enabled 注释）；
                    // 这里读到的就是用户意图，把它当作目标值下发。
                    let wanted = roxy_handle.is_checked().unwrap_or(false);
                    crate::settings_ui::set_roxy_enabled(app, wanted);
                }
                MENU_QUIT => {
                    // 走统一退出路径（RunEvent::Exit 停内核）。
                    app.exit(0);
                }
                _ => {}
            }
        });

    let builder = match tray_icon {
        Ok(icon) => builder.icon(icon),
        Err(e) => {
            crate::logln!("[tray] icon decode failed, using default: {e}");
            builder
        }
    };

    if let Err(e) = builder.build(app) {
        crate::logln!("[tray] build failed: {e}");
        return;
    }
    app.manage(TrayState { roxy_item: roxy });
    crate::logln!("[tray] ready");
}

fn tray_skip(what: &str, e: tauri::Error) {
    crate::logln!("[tray] skip ({what}): {e}");
}

/// 聚焦主窗口（无则忽略）。
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
