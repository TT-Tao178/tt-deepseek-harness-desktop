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

/// Legacy v7 roxy toggle — read for migration, never written back.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RoxySettings {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// The persisted application settings (v8 schema).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    /// `ask` | `tray` | `quit` — what happens when the window closes.
    #[serde(default = "default_close_behavior")]
    pub close_behavior: String,
    #[serde(default)]
    pub plugins: PluginsSettings,
    /// Legacy v7 field: read (for migration) but skipped on write.
    #[serde(default, skip_serializing)]
    pub roxy: RoxySettings,
    #[serde(default)]
    pub kernel: KernelSettings,
}

fn default_close_behavior() -> String {
    "ask".to_string()
}

fn default_enabled() -> bool {
    true
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

/// The bundled plugin id seeded into `plugins.enabled` on migration from a
/// legacy settings file (v8.0+: tt-bg 已随 0.4.0 移除).
pub const LEGACY_PLUGIN_IDS: [&str; 1] = ["dsh-pet-roxy"];

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

impl Default for RoxySettings {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            close_behavior: default_close_behavior(),
            plugins: PluginsSettings::default(),
            roxy: RoxySettings::default(),
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
    if !valid_registry(&s.kernel.registry) {
        s.kernel.registry = default_registry();
    }
    if !(1..=2).contains(&s.kernel.keep_backups) {
        s.kernel.keep_backups = default_keep_backups();
    }
}

/// One-time migration from the legacy v7 schema:
/// an empty `plugins.enabled` map is seeded from `roxy.enabled`
/// (tt-bg 集成已在 0.4.0 移除，仅迁移 dsh-pet-roxy).
fn migrate(s: &mut AppSettings) {
    if s.plugins.enabled.is_empty() {
        let roxy_on = s.roxy.enabled;
        s.plugins
            .enabled
            .insert("dsh-pet-roxy".to_string(), roxy_on);
    }
}

/// Read settings from `path`. A missing file or a file that fails to parse
/// yields the fully defaulted settings (which, after migration, enable the
/// two bundled plugins); missing fields are filled with defaults;
/// out-of-range values are corrected.
pub fn read_settings(path: &Path) -> AppSettings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return AppSettings::default(),
    };
    let mut settings: AppSettings = match serde_json::from_str(&raw) {
        Ok(settings) => settings,
        Err(_) => return AppSettings::default(),
    };
    migrate(&mut settings);
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

/// Bundled plugin id whose toggle is also mirrored in the system tray
/// ("Roxy 桌宠" / `dsh-pet-roxy`).
pub const ROXY_PLUGIN_ID: &str = "dsh-pet-roxy";

/// Whether the Roxy desktop-pet plugin is enabled.
///
/// The tray check mark and the settings window both read this, so they can
/// never disagree. It must go through [`is_plugin_enabled`] — the legacy
/// `roxy.enabled` field is `skip_serializing` and therefore loses its value
/// on the first write-back, which made a tray built from it show a stale
/// check mark.
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
        assert!(is_plugin_enabled(&s, "dsh-pet-roxy", true));
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
    fn legacy_v7_file_migrates_roxy_into_plugins() {
        let root = test_root("v7migrate");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        // v7 schema: roxy disabled, kernel.channel/mirror present.
        fs::write(
            &p,
            r#"{"close_behavior":"tray","roxy":{"enabled":false},"kernel":{"channel":"stable","mirror":"https://registry.npmmirror.com"}}"#,
        )
        .expect("write v7 json");
        let s = read_settings(&p);
        assert_eq!(s.close_behavior, "tray");
        assert!(!is_plugin_enabled(&s, "dsh-pet-roxy", true), "roxy off must migrate to dsh-pet-roxy off");
        assert!(!s.plugins.enabled.contains_key("tt-bg"), "tt-bg 已移除");
        assert_eq!(s.kernel.registry, "npmmirror", "v7 kernel block falls back to default registry");
        // Writing back produces the v8 schema (no `roxy` key, plugins map present).
        write_settings(&p, &s).expect("write back");
        let raw = fs::read_to_string(&p).expect("read raw");
        assert!(!raw.contains("\"roxy\""), "legacy field must not be written back");
        assert!(raw.contains("\"plugins\""));
        assert!(raw.contains("\"registry\""));

        // Re-reading the migrated file is stable for all live state. The
        // legacy `roxy` field is dead after the first write-back (skipped on
        // serialize, so the second read sees its default) — exclude it.
        let s2 = read_settings(&p);
        let mut a = s.clone();
        let mut b = s2;
        a.roxy = RoxySettings::default();
        b.roxy = RoxySettings::default();
        assert_eq!(b, a, "second read must be stable (modulo legacy roxy)");
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

    /// P22 回归：托盘的 Roxy 勾选必须来自 plugins.enabled。
    ///
    /// 旧实现读 `settings.roxy.enabled`，而该字段 `skip_serializing`——
    /// 首次写回后它就永远是默认值 true，于是「取消宠物」后重启又变成勾选。
    #[test]
    fn roxy_enabled_reads_plugins_map_not_legacy_field() {
        let mut s = AppSettings::default();
        assert!(roxy_enabled(&s), "缺省（内置插件）应为启用");

        set_plugin_enabled(&mut s, ROXY_PLUGIN_ID, false);
        assert!(!roxy_enabled(&s), "显式禁用必须生效");
        // 即便 legacy 字段仍是默认 true，也不得影响判定。
        assert!(s.roxy.enabled, "legacy 字段保持默认，仅用于迁移读取");

        // 写回再读（legacy 字段在磁盘上消失）后仍然稳定。
        let root = test_root("roxy-domain");
        let p = root.join("settings.json");
        write_settings(&p, &s).expect("write settings");
        assert!(!roxy_enabled(&read_settings(&p)), "写回后仍为禁用");

        set_plugin_enabled(&mut s, ROXY_PLUGIN_ID, true);
        write_settings(&p, &s).expect("write settings");
        assert!(roxy_enabled(&read_settings(&p)), "写回后恢复启用");
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
