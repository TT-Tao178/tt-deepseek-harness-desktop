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

use crate::menu::TrayState;
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
    .title("设置 - TT DeepSeek Harness Desktop")
    .inner_size(760.0, 600.0)
    .minimizable(false)
    .maximizable(false);
    if let Err(e) = builder.build() {
        eprintln!("[settings] create window failed: {e}");
    }
}

/// Roxy 开关入口（托盘复选框与设置窗口命令都走这里）。
/// v8 语义：Roxy = 插件 `dsh-pet-roxy` 的开关，写 plugins.enabled 后防抖重启内核；
/// 失败时把托盘勾选回写为旧值。
pub fn toggle_roxy(app: &AppHandle, enabled: bool) {
    let Some(rt) = app.try_state::<Arc<KernelRuntime>>() else {
        return;
    };
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    shell_core::settings::set_plugin_enabled(&mut s, "dsh-pet-roxy", enabled);
    if let Err(e) = shell_core::settings::write_settings(&rt.settings_path, &s) {
        eprintln!("[settings] write failed: {e}");
        sync_tray_roxy(app, !enabled);
        return;
    }
    request_kernel_restart(&rt);
}

/// 托盘复选框与实际设置状态对齐。
pub fn sync_tray_roxy(app: &AppHandle, enabled: bool) {
    if let Some(tray) = app.try_state::<TrayState>() {
        let _ = tray.roxy_item.set_checked(enabled);
    }
}

/// 请求重启内核（3s 防抖，generation 计数，最后一次生效）。
pub fn request_kernel_restart(rt: &Arc<KernelRuntime>) {
    let gen = rt.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let rt = rt.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(DEBOUNCE_MS));
        if rt.generation.load(Ordering::SeqCst) != gen {
            return; // 期间又有新的请求，放弃本次
        }
        recompute_and_restart(&rt);
    });
}

/// 立即重算插件挂载并重启内核（stop → start，端口不变）。
/// 供防抖回调与 service_restart 命令复用；junction + 用户 patch 层幂等重建。
pub fn recompute_and_restart(rt: &KernelRuntime) {
    let settings = shell_core::settings::read_settings(&rt.settings_path);
    crate::apply_plugin_mount(
        rt.app_root.as_deref(),
        &rt.app_data,
        &settings,
        &|msg| eprintln!("[kernel] {msg}"),
    );
    let (patch_args, _) = crate::compute_mount_plan(rt.app_root.as_deref(), &rt.app_data, &settings);
    if let Ok(mut spec) = rt.spec_slot.lock() {
        spec.patch_args = patch_args;
    }
    let mut sup = match rt.supervisor.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    sup.stop();
    match sup.start() {
        Ok(()) => eprintln!("[kernel] restarted with new patch args on port {}", rt.port),
        Err(e) => eprintln!("[kernel] restart failed: {e}"),
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
