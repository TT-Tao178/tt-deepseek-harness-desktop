//! 插件管理命令：列表 / 开关 / 本地导入 / 移除（trash 可恢复）。
//!
//! 事实源：settings.plugins.enabled（期望态）+ 文件系统扫描（存在性）。
//! 开关 = 写设置 → 3s 防抖重启内核（--patch 增减）。内置插件只可禁用，
//! 不可移除；用户插件移除后进 plugin-trash/<id>-<时间戳>（手工可恢复）。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use shell_core::plugin_discovery::{discover_plugins, inspect_plugin_dir, PluginSource};
use shell_core::settings::{is_plugin_enabled, set_plugin_enabled};

use crate::menu::TrayState;
use crate::settings_ui;
use crate::KernelRuntime;

/// 前端列表条目。
#[derive(Serialize)]
struct PluginEntry {
    id: String,
    version: Option<String>,
    description: Option<String>,
    /// bundled | user
    source: &'static str,
    enabled: bool,
    valid: bool,
    invalid_reason: Option<String>,
}

fn discover(rt: &KernelRuntime) -> Vec<shell_core::plugin_discovery::PluginInfo> {
    let bundled = rt
        .app_root
        .as_deref()
        .map(|r| r.join("plugins"))
        .unwrap_or_default();
    discover_plugins(&bundled, &rt.user_plugins_dir())
}

#[tauri::command]
pub fn plugin_list(rt: tauri::State<'_, Arc<KernelRuntime>>) -> String {
    let settings = shell_core::settings::read_settings(&rt.settings_path);
    let list: Vec<PluginEntry> = discover(&rt)
        .into_iter()
        .map(|p| PluginEntry {
            enabled: is_plugin_enabled(
                &settings,
                &p.id,
                p.source == PluginSource::Bundled,
            ),
            id: p.id,
            version: p.version,
            description: p.description,
            source: match p.source {
                PluginSource::Bundled => "bundled",
                PluginSource::User => "user",
            },
            valid: p.valid,
            invalid_reason: p.invalid_reason,
        })
        .collect();
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())
}

#[tauri::command]
pub fn plugin_set_enabled(
    app: AppHandle,
    rt: tauri::State<'_, Arc<KernelRuntime>>,
    id: String,
    enabled: bool,
) -> bool {
    // 内置坏插件不允许启用；未知 id 由开关时不存在自然无效（--patch 找不到目录）。
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    set_plugin_enabled(&mut s, &id, enabled);
    if let Err(e) = shell_core::settings::write_settings(&rt.settings_path, &s) {
        eprintln!("[plugin] write settings failed: {e}");
        return false;
    }
    if id == "dsh-pet-roxy" {
        if let Some(tray) = app.try_state::<TrayState>() {
            let _ = tray.roxy_item.set_checked(enabled);
        }
    }
    settings_ui::request_kernel_restart(&rt);
    let _ = app.emit("plugin://changed", serde_json::json!({ "id": id, "enabled": enabled }));
    true
}

#[tauri::command]
pub fn plugin_import(
    app: AppHandle,
    rt: tauri::State<'_, Arc<KernelRuntime>>,
    path: String,
) -> String {
    let src = PathBuf::from(&path);
    let result = import_plugin(&rt, &src);
    match result {
        Ok(id) => {
            let _ = app.emit("plugin://changed", serde_json::json!({ "imported": id }));
            serde_json::json!({ "ok": true, "id": id }).to_string()
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}

fn import_plugin(rt: &KernelRuntime, src: &std::path::Path) -> Result<String, String> {
    // 1. 校验源目录（package.json + cordis.patch.yml + id 白名单）。
    let info = inspect_plugin_dir(src, PluginSource::User).ok_or_else(|| {
        "目录缺少 package.json，不是插件目录".to_string()
    })?;
    if !info.valid {
        return Err(info
            .invalid_reason
            .unwrap_or_else(|| "插件校验失败".to_string()));
    }
    let id = info.id.clone();

    // 2. 与现有插件重名 → 拒绝（同名冲突；内置/用户均不允许覆盖）。
    let existing = discover(rt);
    if existing.iter().any(|p| p.id == id) {
        return Err(format!("已存在同名插件 {id}，请先移除同名插件"));
    }

    // 3. 复制到 userData/plugins/<id>（先复制后入位，失败不半装）。
    let user_dir = rt.user_plugins_dir();
    let dest = user_dir.join(&id);
    if dest.exists() {
        return Err(format!("目标已存在: {}", dest.display()));
    }
    let staging_dest = user_dir.join(format!(".importing-{}", id));
    let _ = std::fs::remove_dir_all(&staging_dest);
    copy_dir_recursive(src, &staging_dest)
        .map_err(|e| format!("复制插件失败: {e}"))?;
    // 复制后再验一次（防止复制过程损坏）。
    if let Some(re) = inspect_plugin_dir(&staging_dest, PluginSource::User) {
        if !re.valid {
            let _ = std::fs::remove_dir_all(&staging_dest);
            return Err(re.invalid_reason.unwrap_or_else(|| "复制后校验失败".to_string()));
        }
    }
    std::fs::create_dir_all(&user_dir).map_err(|e| format!("create user plugins dir: {e}"))?;
    std::fs::rename(&staging_dest, &dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging_dest);
        format!("插件入位失败: {e}")
    })?;

    // 4. 默认禁用入设置（不自动启用）。
    let mut s = shell_core::settings::read_settings(&rt.settings_path);
    set_plugin_enabled(&mut s, &id, false);
    let _ = shell_core::settings::write_settings(&rt.settings_path, &s);
    Ok(id)
}

#[tauri::command]
pub fn plugin_remove(
    app: AppHandle,
    rt: tauri::State<'_, Arc<KernelRuntime>>,
    id: String,
) -> bool {
    let bundled_dir = rt.app_root.as_deref().map(|r| r.join("plugins"));
    let is_bundled = bundled_dir
        .map(|d| d.join(&id).join("package.json").is_file())
        .unwrap_or(false);
    if is_bundled {
        let _ = app.emit(
            "plugin://error",
            serde_json::json!({ "error": "内置插件不可移除，可禁用" }),
        );
        return false;
    }

    let settings = shell_core::settings::read_settings(&rt.settings_path);
    let was_enabled = is_plugin_enabled(&settings, &id, false);

    // 1. 从设置移除并写盘。
    let mut s = settings;
    s.plugins.enabled.remove(&id);
    if let Err(e) = shell_core::settings::write_settings(&rt.settings_path, &s) {
        eprintln!("[plugin] write settings failed: {e}");
        return false;
    }

    // 2. 删 junction（remove_dir 只删链接不删真身）。
    let junction = rt
        .app_data
        .join("dsh-home")
        .join("node_modules")
        .join(&id);
    if junction.exists() {
        if let Err(e) = std::fs::remove_dir(&junction) {
            eprintln!("[plugin] remove junction failed (will retry next restart): {e}");
        }
    }

    // 3. 目录 → plugin-trash/<id>-<ts>。
    let dir = rt.user_plugins_dir().join(&id);
    if dir.exists() {
        let trash_root = rt.app_data.join("plugin-trash");
        let _ = std::fs::create_dir_all(&trash_root);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let trash_dir = trash_root.join(format!("{id}-{ts}"));
        if let Err(e) = std::fs::rename(&dir, &trash_dir) {
            eprintln!("[plugin] move to trash failed: {e}");
            // 移动失败不回滚设置：插件已禁用，重启后一致（目录残留下次可再移）。
        }
    }

    // 4. 启用中被移除 → 重启内核生效；Roxy 特殊同步托盘。
    if id == "dsh-pet-roxy" {
        if let Some(tray) = app.try_state::<TrayState>() {
            let _ = tray.roxy_item.set_checked(false);
        }
    }
    if was_enabled {
        settings_ui::request_kernel_restart(&rt);
    }
    let _ = app.emit("plugin://changed", serde_json::json!({ "removed": id }));
    true
}

/// 递归复制目录（导入插件用）。
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), target)?;
        }
        // 符号链接跳过（插件目录不应含链接；有也是多余的）。
    }
    Ok(())
}
