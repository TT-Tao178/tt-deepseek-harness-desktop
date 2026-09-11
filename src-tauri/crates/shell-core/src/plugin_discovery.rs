//! 插件发现：扫描内置（bundled）与用户导入（user）两个目录，产出
//! [`PluginInfo`] 清单。坏插件只标红（valid=false + 原因），绝不阻塞启动。
//!
//! id 规则 = npm 包名白名单（拒绝路径分隔符 / `..` / 大写），防 junction
//! 逃逸；同名冲突时内置优先，用户侧副本标记 invalid（duplicate）。

use std::fs;
use std::path::{Path, PathBuf};

/// 插件来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginSource {
    /// 随安装包分发的内置插件（`<安装目录>/plugins/`）。
    Bundled,
    /// 用户通过「导入本地插件」放入（`<userData>/plugins/`）。
    User,
}

/// 扫描得到的单个插件信息。
#[derive(Debug, Clone)]
pub struct PluginInfo {
    /// 包名（来自 package.json 的 name）。
    pub id: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub source: PluginSource,
    /// 插件真身目录（junction 的目标）。
    pub dir: PathBuf,
    /// `cordis.patch.yml` 路径。
    pub patch_path: PathBuf,
    /// 校验通过（可挂载）。
    pub valid: bool,
    /// invalid 时的原因（展示用）。
    pub invalid_reason: Option<String>,
}

/// npm 包名白名单：scope 可选，全小写，拒绝路径分隔符与 `..`。
pub fn is_valid_plugin_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 214 {
        return false;
    }
    let (scope, name) = match id.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((s, n)) => (Some(s), n),
            None => return false,
        },
        None => (None, id),
    };
    let seg_ok = |s: &str| {
        !s.is_empty()
            && s.chars().all(|c| {
                matches!(c, 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~')
            })
            && !s.starts_with('.')
            && !s.starts_with('-')
    };
    match scope {
        Some(s) => seg_ok(s) && seg_ok(name),
        None => seg_ok(name),
    }
}

/// 扫描两个目录并合并去重。每个候选子目录必须含 package.json 才算插件；
/// cordis.patch.yml 缺失 → invalid；同 id 冲突时 Bundled 优先，
/// User 副本 invalid（duplicate）。
pub fn discover_plugins(bundled_dir: &Path, user_dir: &Path) -> Vec<PluginInfo> {
    let mut all = Vec::new();
    for (dir, source) in [(bundled_dir, PluginSource::Bundled), (user_dir, PluginSource::User)] {
        for info in scan_one_dir(dir, source) {
            all.push(info);
        }
    }
    // 同 id 去重：Bundled 优先；其余（User）标记 duplicate。
    let mut seen_bundled: Vec<String> = all
        .iter()
        .filter(|p| p.source == PluginSource::Bundled && p.valid)
        .map(|p| p.id.clone())
        .collect();
    seen_bundled.sort();
    seen_bundled.dedup();
    for p in all.iter_mut() {
        if p.source == PluginSource::User && seen_bundled.binary_search(&p.id).is_ok() {
            p.valid = false;
            p.invalid_reason = Some("duplicate: 内置插件已包含同名插件".to_string());
        }
    }
    // 稳定排序：内置在前，各自按 id 字母序（--patch 顺序可复现）。
    all.sort_by(|a, b| {
        (a.source as usize)
            .cmp(&(b.source as usize))
            .then_with(|| a.id.cmp(&b.id))
    });
    all
}

/// 当前生效的 --patch 参数序列：valid ∧ enabled 的插件按发现顺序拼接。
pub fn resolve_enabled_patch_args(
    plugins: &[PluginInfo],
    is_enabled: impl Fn(&PluginInfo) -> bool,
) -> Vec<String> {
    let mut args = Vec::new();
    for p in plugins {
        if p.valid && is_enabled(p) {
            args.push("--patch".to_string());
            args.push(p.patch_path.to_string_lossy().into_owned());
        }
    }
    args
}

/// 所有 valid 插件的 (id, dir) junction 清单（含 disabled 的，保持
/// dsh-home/node_modules 完整；disabled 只是 --patch 不挂）。
pub fn junction_targets(plugins: &[PluginInfo]) -> Vec<(String, PathBuf)> {
    plugins
        .iter()
        .filter(|p| p.valid)
        .map(|p| (p.id.clone(), p.dir.clone()))
        .collect()
}

/// 扫描单个目录的子目录。
fn scan_one_dir(dir: &Path, source: PluginSource) -> Vec<PluginInfo> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out, // 目录不存在/不可读 → 该来源为空
    };
    let mut subdirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    subdirs.sort();
    for sub in subdirs {
        if let Some(info) = inspect_plugin_dir(&sub, source) {
            out.push(info);
        }
    }
    out
}

/// 检查单个插件目录，产出 PluginInfo（目录缺 package.json 时返回 None）。
/// pub：供导入流程复用同一校验（先验源目录，复制后再验目标）。
pub fn inspect_plugin_dir(dir: &Path, source: PluginSource) -> Option<PluginInfo> {
    let pkg_path = dir.join("package.json");
    if !pkg_path.is_file() {
        return None;
    }
    let patch_path = dir.join("cordis.patch.yml");
    let invalid = |reason: String| {
        Some(PluginInfo {
            id: dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            version: None,
            description: None,
            source,
            dir: dir.to_path_buf(),
            patch_path: patch_path.clone(),
            valid: false,
            invalid_reason: Some(reason),
        })
    };
    let raw = match fs::read_to_string(&pkg_path) {
        Ok(r) => r,
        Err(e) => return invalid(format!("package.json 不可读: {e}")),
    };
    let pkg: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return invalid(format!("package.json 解析失败: {e}")),
    };
    let id = pkg
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !is_valid_plugin_id(&id) {
        return invalid(format!("非法插件 id: {id:?}"));
    }
    if !patch_path.is_file() {
        return invalid("缺少 cordis.patch.yml（不是 dsh 插件结构）".to_string());
    }
    Some(PluginInfo {
        version: pkg
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        description: pkg
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        id,
        source,
        dir: dir.to_path_buf(),
        patch_path,
        valid: true,
        invalid_reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shell-core-discovery-{tag}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn make_plugin(root: &Path, name: &str, id: &str, with_patch: bool) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("mkdir");
        let mut pkg = serde_json::json!({ "name": id, "version": "0.1.0" });
        pkg["description"] = serde_json::json!(format!("{id} desc"));
        fs::write(dir.join("package.json"), pkg.to_string()).expect("write pkg");
        if with_patch {
            fs::write(
                dir.join("cordis.patch.yml"),
                "insert:\n  - id: demo\n    name: demo\n",
            )
            .expect("write patch");
        }
        dir
    }

    #[test]
    fn valid_id_charset() {
        assert!(is_valid_plugin_id("tt-bg"));
        assert!(is_valid_plugin_id("dsh-pet-roxy"));
        assert!(is_valid_plugin_id("@scope/pkg.name"));
        assert!(is_valid_plugin_id("a~_.9"));
        assert!(!is_valid_plugin_id(""));
        assert!(!is_valid_plugin_id("../evil"));
        assert!(!is_valid_plugin_id("a/b")); // 无 scope 的斜杠
        assert!(!is_valid_plugin_id("@onlyscope"));
        assert!(!is_valid_plugin_id("UPPER"));
        assert!(!is_valid_plugin_id("a b"));
        assert!(!is_valid_plugin_id(".hidden"));
        assert!(!is_valid_plugin_id("-lead"));
    }

    #[test]
    fn scans_two_dirs_marks_invalid_and_dedupes() {
        let root = test_root("scan");
        let bundled = root.join("bundled");
        let user = root.join("user");
        fs::create_dir_all(&user).expect("mkdir user");

        // 内置：一个有效 + 一个缺 patch 的坏插件。
        make_plugin(&bundled, "tt-bg", "tt-bg", true);
        make_plugin(&bundled, "bad-one", "bad-one", false);
        // 用户：一个有效 + 与内置同名的副本 + 目录名与 id 不一致（id 以 package.json 为准）。
        make_plugin(&user, "my-plugin", "my-plugin", true);
        make_plugin(&user, "copy-of-ttbg", "tt-bg", true);

        let list = discover_plugins(&bundled, &user);
        let by = |id: &str, src: PluginSource| {
            list.iter()
                .find(|p| p.id == id && p.source == src)
                .cloned()
                .unwrap_or_else(|| panic!("missing {id}"))
        };

        let ttbg = by("tt-bg", PluginSource::Bundled);
        assert!(ttbg.valid);

        let bad = list
            .iter()
            .find(|p| p.id == "bad-one")
            .expect("bad-one listed");
        assert!(!bad.valid);
        assert!(bad.invalid_reason.as_deref().unwrap().contains("cordis.patch.yml"));

        let mine = by("my-plugin", PluginSource::User);
        assert!(mine.valid);

        let dup = by("tt-bg", PluginSource::User);
        assert!(!dup.valid);
        assert!(dup.invalid_reason.as_deref().unwrap().contains("duplicate"));

        // 内置在前，按 id 排序。
        assert!(list.first().unwrap().source == PluginSource::Bundled);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_plugin_dirs_are_ignored() {
        let root = test_root("nonplugin");
        let bundled = root.join("bundled");
        let user = root.join("user");
        fs::create_dir_all(bundled.join("not-a-plugin")).expect("mkdir");
        fs::create_dir_all(bundled.join("empty-dir")).expect("mkdir");
        let list = discover_plugins(&bundled, &user);
        assert!(list.is_empty(), "dirs without package.json must be skipped");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_dirs_yield_empty() {
        let root = test_root("missingdirs");
        let list = discover_plugins(&root.join("nope1"), &root.join("nope2"));
        assert!(list.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_args_follow_enabled_and_valid() {
        let root = test_root("patchargs");
        let bundled = root.join("bundled");
        let user = root.join("user");
        fs::create_dir_all(&user).expect("mkdir");
        make_plugin(&bundled, "a-good", "a-good", true);
        make_plugin(&bundled, "b-bad", "b-bad", false);
        make_plugin(&user, "c-off", "c-off", true);
        let list = discover_plugins(&bundled, &user);

        let args = resolve_enabled_patch_args(&list, |p| p.id != "c-off");
        assert_eq!(args.len(), 2, "only a-good (valid+on) contributes");
        assert_eq!(args[0], "--patch");
        assert!(args[1].ends_with(&format!("a-good{}", std::path::MAIN_SEPARATOR))
            || args[1].contains("a-good"));
        assert!(!args[1].contains("b-bad"));

        // junction 清单包含 valid 的全部（含关闭的 c-off），不含坏插件。
        let targets = junction_targets(&list);
        let ids: Vec<&str> = targets.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"a-good"));
        assert!(ids.contains(&"c-off"));
        assert!(!ids.contains(&"b-bad"));
        let _ = fs::remove_dir_all(&root);
    }
}
