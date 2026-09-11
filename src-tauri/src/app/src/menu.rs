//! 系统托盘：显示主窗口 / 设置… / Roxy 桌宠开关 / 退出。
//!
//! Roxy 复选框与设置面板共用同一事实源（settings.json）：勾选状态变化时
//! 调用 [`crate::settings_ui::toggle_roxy`]（含 3s 防抖重启内核）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager, Wry};

/// 托盘里可动态更新的控件句柄（勾选状态回写）。
pub struct TrayState {
    pub roxy_item: CheckMenuItem<Wry>,
}

pub const MENU_SHOW: &str = "show";
pub const MENU_SETTINGS: &str = "settings";
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
    let roxy = match CheckMenuItem::with_id(app, "roxy", "Roxy 桌宠", true, roxy_enabled, None::<&str>)
    {
        Ok(i) => i,
        Err(e) => return tray_skip("roxy item", e),
    };
    let quit = match MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return tray_skip("quit item", e),
    };
    let menu = match Menu::with_items(app, &[&show, &settings, &roxy, &quit]) {
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
                "roxy" => {
                    let checked = roxy_handle.is_checked().unwrap_or(true);
                    crate::settings_ui::toggle_roxy(app, checked);
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
            eprintln!("[tray] icon decode failed, using default: {e}");
            builder
        }
    };

    if let Err(e) = builder.build(app) {
        eprintln!("[tray] build failed: {e}");
        return;
    }
    app.manage(TrayState { roxy_item: roxy });
    eprintln!("[tray] ready");
}

fn tray_skip(what: &str, e: tauri::Error) {
    eprintln!("[tray] skip ({what}): {e}");
}

/// 聚焦主窗口（无则忽略）。
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
