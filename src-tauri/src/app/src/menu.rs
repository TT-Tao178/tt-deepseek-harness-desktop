//! 系统托盘：显示主窗口 / 设置… / 退出。
//!
//! 「页面宠物」开关在设置窗口（通用设置与插件管理两处），与主窗页面共用
//! 同一事实源（settings.json → `plugins.enabled`）；托盘不再单列宠物开关。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager};

pub const MENU_SHOW: &str = "show";
pub const MENU_SETTINGS: &str = "settings";
pub const MENU_QUIT: &str = "quit";

/// 在 setup 阶段创建托盘。失败只记日志，不阻塞应用启动。
pub fn init(app: &App) {
    let show = match MenuItem::with_id(app, MENU_SHOW, "显示主窗口", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("show item", e),
    };
    let settings = match MenuItem::with_id(app, MENU_SETTINGS, "设置…", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("settings item", e),
    };
    let quit = match MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("quit item", e),
    };
    let sep = match PredefinedMenuItem::separator(app) {
        Ok(i) => i,
        Err(e) => return tray_skip("separator", e),
    };
    let menu = match Menu::with_items(app, &[&show, &settings, &sep, &quit]) {
        Ok(m) => m,
        Err(e) => return tray_skip("menu", e),
    };

    // 托盘图标 = 应用图标（与任务栏/exe 图标同源：icons/icon.ico）。
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))
        .map_err(|e| format!("decode tray icon: {e}"));
    let builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("TT DeepSeek Harness Desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let app: &AppHandle = app;
            match event.id().as_ref() {
                MENU_SHOW => focus_main(app),
                MENU_SETTINGS => crate::settings_ui::open_settings_window(app),
                MENU_QUIT => {
                    // P43:先隐藏所有窗口(退出清理链需零点几到两秒),
                    // 再走统一退出路径(RunEvent::Exit 停内核)。
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    if let Some(w) = app.get_webview_window("settings") {
                        let _ = w.hide();
                    }
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
