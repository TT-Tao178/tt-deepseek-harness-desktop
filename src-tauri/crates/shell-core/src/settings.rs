use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Kernel runtime selection.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct KernelSettings {
    /// Release channel, e.g. `stable`.
    #[serde(default = "default_channel")]
    pub channel: String,
    /// npm registry mirror used to resolve packages.
    #[serde(default = "default_mirror")]
    pub mirror: String,
}

/// Proxy / roxy toggle.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RoxySettings {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// Window background image settings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BackgroundSettings {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
}

/// The persisted application settings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    /// `ask` | `tray` | `quit` — what happens when the window closes.
    #[serde(default = "default_close_behavior")]
    pub close_behavior: String,
    #[serde(default)]
    pub roxy: RoxySettings,
    #[serde(default)]
    pub kernel: KernelSettings,
    #[serde(default)]
    pub background: BackgroundSettings,
}

fn default_close_behavior() -> String {
    "ask".to_string()
}

fn default_enabled() -> bool {
    true
}

fn default_channel() -> String {
    "stable".to_string()
}

fn default_mirror() -> String {
    "https://registry.npmmirror.com".to_string()
}

fn default_opacity() -> f64 {
    1.0
}

impl Default for KernelSettings {
    fn default() -> Self {
        Self {
            channel: default_channel(),
            mirror: default_mirror(),
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

impl Default for BackgroundSettings {
    fn default() -> Self {
        Self {
            path: None,
            opacity: default_opacity(),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: default_close_behavior(),
            roxy: RoxySettings::default(),
            kernel: KernelSettings::default(),
            background: BackgroundSettings::default(),
        }
    }
}

/// Whether an opacity value is usable (not NaN, within `[0.0, 1.0]`).
fn valid_opacity(v: f64) -> bool {
    !v.is_nan() && (0.0..=1.0).contains(&v)
}

/// Bring an arbitrary `AppSettings` back to the documented invariants:
/// `close_behavior` restricted to `ask|tray|quit`, opacity within `[0.0, 1.0]`.
fn sanitize(s: &mut AppSettings) {
    if !matches!(s.close_behavior.as_str(), "ask" | "tray" | "quit") {
        s.close_behavior = default_close_behavior();
    }
    if !valid_opacity(s.background.opacity) {
        s.background.opacity = default_opacity();
    }
}

/// Read settings from `path`. A missing file or a file that fails to parse
/// yields the fully defaulted settings; missing fields are filled with their
/// defaults; out-of-range values are corrected.
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

/// Enable or disable the roxy feature.
pub fn set_roxy_enabled(s: &mut AppSettings, enabled: bool) {
    s.roxy.enabled = enabled;
}

/// Set the close behavior; values other than `ask`/`tray`/`quit` are ignored.
pub fn set_close_behavior(s: &mut AppSettings, v: &str) {
    if matches!(v, "ask" | "tray" | "quit") {
        s.close_behavior = v.to_string();
    }
}

/// Merge a background update: `None` keeps the current value, `Some` overwrites;
/// an invalid opacity is replaced with `1.0`.
pub fn set_background(s: &mut AppSettings, path: Option<String>, opacity: Option<f64>) {
    if let Some(path) = path {
        s.background.path = Some(path);
    }
    if let Some(opacity) = opacity {
        s.background.opacity = if valid_opacity(opacity) { opacity } else { default_opacity() };
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
    fn missing_file_returns_defaults() {
        let root = test_root("missing");
        let s = read_settings(&root.join("settings.json"));
        assert_eq!(s, AppSettings::default());
        assert_eq!(s.close_behavior, "ask");
        assert!(s.roxy.enabled);
        assert_eq!(s.kernel.channel, "stable");
        assert_eq!(s.kernel.mirror, "https://registry.npmmirror.com");
        assert_eq!(s.background.path, None);
        assert_eq!(s.background.opacity, 1.0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_json_returns_defaults() {
        let root = test_root("badjson");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(&p, "{ not valid json !!!").expect("write bad json");
        let s = read_settings(&p);
        assert_eq!(s, AppSettings::default());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_file_returns_defaults() {
        let root = test_root("empty");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(&p, "").expect("write empty file");
        let s = read_settings(&p);
        assert_eq!(s, AppSettings::default());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_fields_fill_defaults() {
        let root = test_root("missingfields");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(&p, r#"{"close_behavior":"tray","kernel":{"channel":"beta"}}"#)
            .expect("write json");
        let s = read_settings(&p);
        assert_eq!(s.close_behavior, "tray");
        assert!(s.roxy.enabled, "missing roxy should default to enabled");
        assert_eq!(s.kernel.channel, "beta");
        assert_eq!(s.kernel.mirror, "https://registry.npmmirror.com");
        assert_eq!(s.background.path, None);
        assert_eq!(s.background.opacity, 1.0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_values_are_sanitized() {
        let root = test_root("sanitize");
        let p = root.join("settings.json");
        fs::create_dir_all(&root).expect("create temp dir");
        fs::write(&p, r#"{"close_behavior":"minimize","background":{"opacity":2.5}}"#)
            .expect("write json");
        let s = read_settings(&p);
        assert_eq!(s.close_behavior, "ask", "unknown close_behavior must fall back to ask");
        assert_eq!(s.background.opacity, 1.0, "out-of-range opacity must fall back to 1.0");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nan_opacity_is_sanitized() {
        let mut s = AppSettings::default();
        s.background.opacity = f64::NAN;
        sanitize(&mut s);
        assert_eq!(s.background.opacity, 1.0);
    }

    #[test]
    fn write_read_roundtrip() {
        let root = test_root("roundtrip");
        let p = root.join("nested").join("settings.json");
        let mut s = AppSettings::default();
        s.close_behavior = "tray".to_string();
        s.roxy.enabled = false;
        s.kernel.channel = "nightly".to_string();
        s.kernel.mirror = "https://registry.npmjs.org".to_string();
        s.background.path = Some("C:\\wallpaper.png".to_string());
        s.background.opacity = 0.42;
        write_settings(&p, &s).expect("write settings");
        let back = read_settings(&p);
        assert_eq!(back, s, "read-back must equal what was written");
        let raw = fs::read_to_string(&p).expect("read raw json");
        assert!(raw.contains('\n'), "stored json should be pretty-printed");
        assert!(!raw.starts_with('\u{feff}'), "stored json must not have a BOM");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn setters_merge_semantics() {
        let mut s = AppSettings::default();

        set_roxy_enabled(&mut s, false);
        assert!(!s.roxy.enabled);
        set_roxy_enabled(&mut s, true);
        assert!(s.roxy.enabled);

        set_close_behavior(&mut s, "tray");
        assert_eq!(s.close_behavior, "tray");
        set_close_behavior(&mut s, "bogus");
        assert_eq!(s.close_behavior, "tray", "invalid close_behavior must be ignored");
        set_close_behavior(&mut s, "quit");
        assert_eq!(s.close_behavior, "quit");
        set_close_behavior(&mut s, "ask");
        assert_eq!(s.close_behavior, "ask");

        // path: None keeps the old value, Some overwrites
        assert_eq!(s.background.path, None);
        set_background(&mut s, Some("a.png".to_string()), None);
        assert_eq!(s.background.path.as_deref(), Some("a.png"));
        set_background(&mut s, None, None);
        assert_eq!(s.background.path.as_deref(), Some("a.png"), "None path must not clear it");
        set_background(&mut s, Some("b.png".to_string()), None);
        assert_eq!(s.background.path.as_deref(), Some("b.png"), "Some path must overwrite");

        // opacity: valid values stick, invalid ones become 1.0
        set_background(&mut s, None, Some(0.5));
        assert_eq!(s.background.opacity, 0.5);
        set_background(&mut s, None, Some(1.5));
        assert_eq!(s.background.opacity, 1.0, "opacity > 1.0 must be reset");
        set_background(&mut s, None, Some(-0.1));
        assert_eq!(s.background.opacity, 1.0, "opacity < 0.0 must be reset");
        set_background(&mut s, None, Some(f64::NAN));
        assert_eq!(s.background.opacity, 1.0, "NaN opacity must be reset");
        // None opacity keeps the current value
        set_background(&mut s, None, Some(0.25));
        set_background(&mut s, None, None);
        assert_eq!(s.background.opacity, 0.25);
    }
}
