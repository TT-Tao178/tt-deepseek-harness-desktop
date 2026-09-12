use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Kernel update settings (v8).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct KernelSettings {
    /// npm registry selector: `npmmirror` (default) or `npmjs`.
    #[serde(default = "default_registry")]
    pub registry: String,
    /// How many previous kernel versions to keep in kernel-backup/ (1~2).
    #[serde(default = "default_keep_backups")]
    pub keep_backups: u32,
    /// ISO timestamp of the last update check (set by the shell).
    #[serde(default)]
    pub last_checked: Option<String>,
    /// Kernel version currently installed (set by the shell after a
    /// successful update; informational only — the live truth is read from
    /// the kernel directory).
    #[serde(default)]
    pub installed_version: Option<String>,
}

/// Per-plugin enabled map: id -> on/off.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct PluginsSettings {
    #[serde(default)]
    pub enabled: BTreeMap<String, bool>,
}

/// The persisted application settings (v8.2 schema).
///
/// 旧文件里的 legacy `roxy` 键由 serde 忽略（未知字段不报错）；v8.2 起宠物
/// 常开，该字段连同迁移逻辑一起移除。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    /// `ask` | `tray` | `quit` — what happens when the window closes.
    #[serde(default = "default_close_behavior")]
    pub close_behavior: String,
    #[serde(default)]
    pub plugins: PluginsSettings,
    #[serde(default)]
    pub kernel: KernelSettings,
}

fn default_close_behavior() -> String {
    "ask".to_string()
}

fn default_registry() -> String {
    "npmmirror".to_string()
}

fn default_keep_backups() -> u32 {
    1
}

/// Registry ids accepted by the shell (whitelist passed to the installer).
pub const REGISTRY_NPMMIRROR: &str = "npmmirror";
pub const REGISTRY_NPMJS: &str = "npmjs";

/// The bundled plugin id whose toggle is also mirrored in the system tray
/// ("Roxy 桌宠" / `dsh-pet-roxy`).
pub const ROXY_PLUGIN_ID: &str = "dsh-pet-roxy";

impl Default for KernelSettings {
    fn default() -> Self {
        Self {
            registry: default_registry(),
            keep_backups: default_keep_backups(),
            last_checked: None,
            installed_version: None,
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            close_behavior: default_close_behavior(),
            plugins: PluginsSettings::default(),
            kernel: KernelSettings::default(),
        }
    }
}

fn valid_registry(v: &str) -> bool {
    matches!(v, REGISTRY_NPMMIRROR | REGISTRY_NPMJS)
}

/// Bring an arbitrary `AppSettings` back to the documented invariants.
fn sanitize(s: &mut AppSettings) {
    if !matches!(s.close_behavior.as_str(), "ask" | "tray" | "quit") {
        s.close_behavior = default_close_behavior();
    }
    // v8.0：tt-bg 集成已整体移除，剥离历史遗留的开关项。
    s.plugins.enabled.remove("tt-bg");
    // v8.2：页面宠物常开（用户明令，关闭选项已移除）。旧版本（≤0.4.1）
    // 可能把 `dsh-pet-roxy: false` 写进设置——升级后读入时一律剥离，
    // 宠物必然挂载。这是「常开」的第一道防线。
    s.plugins.enabled.remove(ROXY_PLUGIN_ID);
    if !valid_registry(&s.kernel.registry) {
        s.kernel.registry = default_registry();
    }
    if !(1..=2).contains(&s.kernel.keep_backups) {
        s.kernel.keep_backups = default_keep_backups();
    }
}

/// Read settings from `path`. A missing file or a file that fails to parse
/// yields the fully defaulted settings; missing fields are filled with
/// defaults; out-of-range values and revoked toggles are corrected by
/// [`sanitize`] (页面宠物常开)。
pub fn read_settings(path: &Path) -> AppSettings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return AppSettings::default(),
    };
    let mut settings: AppSettings = match serde_json::from_str(&raw) {
        Ok(settings) => settings,
        Err(_) => return AppSettings::default(),
    };
    sanitize(&mut settings);
    settings
}

/// Write `settings` to `path` as pretty JSON (no BOM), creating parent
/// directories first. Errors are propagated as `String`.
pub fn write_settings(path: &Path, s: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Plugin enabled lookup: explicit map entry wins; otherwise bundled plugins
/// default to enabled and user (imported) plugins default to disabled.
pub fn is_plugin_enabled(s: &AppSettings, id: &str, bundled: bool) -> bool {
    match s.plugins.enabled.get(id) {
        Some(v) => *v,
        None => bundled,
    }
}

/// Set a plugin's enabled state (no-op persistence happens in the caller).
pub fn set_plugin_enabled(s: &mut AppSettings, id: &str, enabled: bool) {
    s.plugins.enabled.insert(id.to_string(), enabled);
}

/// Whether the Roxy desktop-pet plugin is enabled.
///
/// v8.2 起页面宠物**常开**：设置页与插件列表的开关已移除，[`sanitize`]
/// 会剥掉历史遗留的 `dsh-pet-roxy` 禁用条目，因此经 [`read_settings`]
/// 读到的设置里它恒为 true。函数仍从 `plugins.enabled` 计算而非写死
/// true（P22 的教训：判定必须走唯一事实源）；未过 sanitize 的裸构造
/// 不受此保证，挂载侧另有防线（`compute_mount_plan` 对内置宠物不产出
/// 禁用条目）。
pub fn roxy_enabled(s: &AppSettings) -> bool {
    is_plugin_enabled(s, ROXY_PLUGIN_ID, true)
}

/// Set the close behavior; values other than `ask`/`tray`/`quit` are ignored.
pub fn set_close_behavior(s: &mut AppSettings, v: &str) {
    if matches!(v, "ask" | "tray" | "quit") {
        s.close_behavior = v.to_string();
    }
}

/// Registry URL for a whitelisted registry id (returns None for unknown ids).
pub fn registry_url(registry: &str) -> Option<&'static str> {
    match registry {
        REGISTRY_NPMMIRROR => Some("https://registry.npmmirror.com"),
        REGISTRY_NPMJS => Some("https://registry.npmjs.org"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shell-core-settings-{tag}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn missing_file_returns_defaults_with_bundled_seeded() {
        let root = test_root("missing");
        let s = read_settings(&root.join("settings.json"));
        assert_eq!(s.close_behavior, "ask");
        assert!(!s.plugins.enabled.contains_key("tt-bg"), "tt-bg 已移除，不得再种子");
        assert!(roxy_enabled(&s), "宠物常开：缺省即启用");
        assert_eq!(s.kernel.registry, "npmmirror");
        assert_eq!(s.kernel.keep_backups, 1);
        assert_eq!(s.kernel.last_checked, None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_json_returns_defaults() {
        let root = test_root("badjson");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(&p, "{ not valid json !!!").expect("write bad json");
        let s = read_settings(&p);
        assert_eq!(s.close_behavior, "ask");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_v7_file_ignored_pet_always_on() {
        let root = test_root("v7legacy");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        // v7 schema: roxy disabled + v8 显式禁用条目（≤0.4.1 的开关写入过）。
        // v8.2 起宠物常开：legacy 字段与显式禁用条目都必须失效。
        fs::write(
            &p,
            r#"{"close_behavior":"tray","roxy":{"enabled":false},"plugins":{"enabled":{"dsh-pet-roxy":false}},"kernel":{"channel":"stable","mirror":"https://registry.npmmirror.com"}}"#,
        )
        .expect("write legacy json");
        let s = read_settings(&p);
        assert_eq!(s.close_behavior, "tray");
        assert!(roxy_enabled(&s), "宠物常开：旧关闭态必须被忽略");
        assert!(
            !s.plugins.enabled.contains_key(ROXY_PLUGIN_ID),
            "禁用条目必须被 sanitize 剥离"
        );
        assert_eq!(s.kernel.registry, "npmmirror", "未知内核字段走默认 registry");
        // 写回后是干净 schema：无 roxy 键、无宠物开关条目；再读稳定。
        write_settings(&p, &s).expect("write back");
        let raw = fs::read_to_string(&p).expect("read raw");
        assert!(!raw.contains("\"roxy\""), "legacy field must not be written back");
        assert!(!raw.contains("dsh-pet-roxy"), "pet toggle must not persist");
        let s2 = read_settings(&p);
        assert_eq!(s2, s, "second read must be stable");
        assert!(roxy_enabled(&s2));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_values_are_sanitized() {
        let root = test_root("sanitize");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(
            &p,
            r#"{"close_behavior":"minimize","kernel":{"registry":"http://evil.example","keep_backups":9}}"#,
        )
        .expect("write json");
        let s = read_settings(&p);
        assert_eq!(s.close_behavior, "ask", "unknown close_behavior must fall back to ask");
        assert_eq!(s.kernel.registry, "npmmirror", "non-whitelisted registry must fall back");
        assert_eq!(s.kernel.keep_backups, 1, "keep_backups out of 1..=2 must fall back");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_read_roundtrip_preserves_plugins() {
        let root = test_root("roundtrip");
        let p = root.join("nested").join("settings.json");
        let mut s = AppSettings::default();
        s.close_behavior = "tray".to_string();
        set_plugin_enabled(&mut s, "my-plugin", true);
        s.kernel.registry = "npmjs".to_string();
        s.kernel.installed_version = Some("0.1.0-rc.7".to_string());
        write_settings(&p, &s).expect("write settings");
        let back = read_settings(&p);
        assert_eq!(back, s, "read-back must equal what was written");
        let raw = fs::read_to_string(&p).expect("read raw json");
        assert!(raw.contains('\n'), "stored json should be pretty-printed");
        assert!(!raw.starts_with('\u{feff}'), "stored json must not have a BOM");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn plugin_enabled_lookup_semantics() {
        let mut s = AppSettings::default();
        // Missing entry: bundled -> true, user -> false.
        assert!(is_plugin_enabled(&s, "unknown", true));
        assert!(!is_plugin_enabled(&s, "unknown", false));
        // Explicit entry wins for both.
        set_plugin_enabled(&mut s, "p1", false);
        assert!(!is_plugin_enabled(&s, "p1", true));
        set_plugin_enabled(&mut s, "p2", true);
        assert!(is_plugin_enabled(&s, "p2", false));
    }

    /// P22 回归（v8.2 改写）：判定必须走 `plugins.enabled` 事实源，而不是
    /// legacy 的 `roxy.enabled`（skip_serializing，写回即丢）。v8.2 起宠物
    /// 常开，本测试守住的新不变量是：**含显式禁用条目的设置经写盘→读回后，
    /// 宠物恒为启用**（覆盖 0.4.1 老用户「关过宠物」的升级路径）。
    #[test]
    fn pet_is_always_enabled_after_roundtrip() {
        let mut s = AppSettings::default();
        assert!(roxy_enabled(&s), "缺省（内置插件）应为启用");

        // 旧版开关留下的显式禁用条目：写盘再读回必须被剥离。
        set_plugin_enabled(&mut s, ROXY_PLUGIN_ID, false);
        let root = test_root("roxy-always-on");
        let p = root.join("settings.json");
        write_settings(&p, &s).expect("write settings");
        let back = read_settings(&p);
        assert!(roxy_enabled(&back), "读回后宠物必须为启用（sanitize 剥离禁用条目）");
        assert!(!back.plugins.enabled.contains_key(ROXY_PLUGIN_ID));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn registry_url_whitelist() {
        assert_eq!(
            registry_url("npmmirror"),
            Some("https://registry.npmmirror.com")
        );
        assert_eq!(registry_url("npmjs"), Some("https://registry.npmjs.org"));
        assert_eq!(registry_url("http://evil"), None);
    }

    #[test]
    fn setters_merge_semantics() {
        let mut s = AppSettings::default();
        set_close_behavior(&mut s, "tray");
        set_close_behavior(&mut s, "bogus");
        assert_eq!(s.close_behavior, "tray", "invalid close_behavior must be ignored");

    }
}
