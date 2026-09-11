use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Ordered candidate locations for a plugin's source directory:
/// 1. `<app>/plugins/<name>`
/// 2. `<app>/node_modules/<name>`
/// 3. `<resources>/<name>`
pub fn plugin_src_candidates(app_path: &Path, resources_path: &Path, name: &str) -> Vec<PathBuf> {
    vec![
        app_path.join("plugins").join(name),
        app_path.join("node_modules").join(name),
        resources_path.join(name),
    ]
}

/// Return the first candidate that exists and carries a `package.json`.
pub fn find_plugin_src(app_path: &Path, resources_path: &Path, name: &str) -> Option<PathBuf> {
    plugin_src_candidates(app_path, resources_path, name)
        .into_iter()
        .find(|candidate| candidate.join("package.json").is_file())
}

/// Path of the patch file that lives inside a plugin directory.
pub fn plugin_patch_path(plugin_dir: &Path) -> PathBuf {
    plugin_dir.join("cordis.patch.yml")
}

/// Make sure every `(name, src)` pair has a junction at
/// `<home_node_modules>/<name>` pointing at `src` (Windows only).
///
/// Idempotent: existing, resolving targets are left untouched. A junction
/// that was created but does not resolve (e.g. the source was missing) is
/// reported as invalid. Failures never panic; each one is collected as a
/// message in the returned `Vec<String>`.
pub fn ensure_junctions(home_node_modules: &Path, links: &[(String, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();

    for (name, src) in links {
        let target = home_node_modules.join(name);
        if target.exists() {
            // Already linked (or at least present): skip, keeping idempotency.
            continue;
        }
        // Scoped names (`@scope/pkg`) need the scope directory to exist.
        if let Some(parent) = target.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                errors.push(format!(
                    "failed to create parent dir for junction '{}': {e}",
                    target.to_string_lossy()
                ));
                continue;
            }
        }
        if !cfg!(windows) {
            errors.push(format!(
                "cannot create junction '{}': junction creation is only supported on Windows",
                target.to_string_lossy()
            ));
            continue;
        }
        let target_str = target.to_string_lossy();
        let src_str = src.to_string_lossy();
        let output = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&*target_str)
            .arg(&*src_str)
            .output();
        match output {
            Ok(output) => {
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let detail = if stderr.trim().is_empty() {
                        stdout.trim().to_string()
                    } else {
                        stderr.trim().to_string()
                    };
                    errors.push(format!(
                        "failed to create junction '{}' -> '{}': {}",
                        target_str, src_str, detail
                    ));
                } else if !target.exists() {
                    // mklink /J does not require the source to exist, so a
                    // junction to a missing source is still "created" — flag
                    // it as invalid instead of silently accepting it.
                    errors.push(format!(
                        "junction '{}' -> '{}' was created but does not resolve: source is missing",
                        target_str, src_str
                    ));
                }
            }
            Err(e) => errors.push(format!(
                "failed to run mklink for '{}' -> '{}': {}",
                target_str, src_str, e
            )),
        }
    }

    errors
}

/// Resolve the CLI arguments for applying a plugin patch:
/// enabled -> `["--patch", <path>]`, disabled -> `[]`.
pub fn resolve_patch_args(patch_path: &Path, enabled: bool) -> Vec<String> {
    if enabled {
        vec!["--patch".to_string(), patch_path.to_string_lossy().into_owned()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shell-core-plugins-{tag}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn candidates_in_order() {
        let app = Path::new("app");
        let res = Path::new("res");
        let candidates = plugin_src_candidates(app, res, "my-plugin");
        assert_eq!(candidates.len(), 3);
        assert_eq!(candidates[0], app.join("plugins").join("my-plugin"));
        assert_eq!(candidates[1], app.join("node_modules").join("my-plugin"));
        assert_eq!(candidates[2], res.join("my-plugin"));
    }

    #[test]
    fn find_plugin_src_existence() {
        let root = test_root("find");
        let app = root.join("app");
        let res = root.join("res");

        // No candidate exists at all.
        assert_eq!(find_plugin_src(&app, &res, "p1"), None);

        // Only the node_modules candidate has a package.json -> it wins.
        let nm = app.join("node_modules").join("p2");
        fs::create_dir_all(&nm).expect("create node_modules candidate");
        fs::write(nm.join("package.json"), "{}").expect("write package.json");
        assert_eq!(find_plugin_src(&app, &res, "p2"), Some(nm));

        // plugins candidate exists but lacks package.json -> falls through.
        let pl = app.join("plugins").join("p3");
        fs::create_dir_all(&pl).expect("create plugins candidate");
        let nm3 = app.join("node_modules").join("p3");
        fs::create_dir_all(&nm3).expect("create node_modules candidate");
        fs::write(nm3.join("package.json"), "{}").expect("write package.json");
        assert_eq!(find_plugin_src(&app, &res, "p3"), Some(nm3));

        // plugins candidate wins when it has a package.json (order matters).
        let pl4 = app.join("plugins").join("p4");
        fs::create_dir_all(&pl4).expect("create plugins candidate");
        fs::write(pl4.join("package.json"), "{}").expect("write package.json");
        let nm4 = app.join("node_modules").join("p4");
        fs::create_dir_all(&nm4).expect("create node_modules candidate");
        fs::write(nm4.join("package.json"), "{}").expect("write package.json");
        assert_eq!(find_plugin_src(&app, &res, "p4"), Some(pl4));

        // resources candidate is the last resort.
        let res5 = res.join("p5");
        fs::create_dir_all(&res5).expect("create resources candidate");
        fs::write(res5.join("package.json"), "{}").expect("write package.json");
        assert_eq!(find_plugin_src(&app, &res, "p5"), Some(res5));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_path() {
        assert_eq!(
            plugin_patch_path(Path::new("plugin-dir")),
            Path::new("plugin-dir").join("cordis.patch.yml")
        );
    }

    #[test]
    fn resolve_patch_args_combos() {
        let patch = Path::new("plugin-dir").join("cordis.patch.yml");

        // enabled -> exactly ["--patch", <path>]
        let args = resolve_patch_args(&patch, true);
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "--patch");
        assert_eq!(args[1], patch.to_string_lossy());

        // disabled -> empty, regardless of the path
        assert!(resolve_patch_args(&patch, false).is_empty());
        assert!(resolve_patch_args(Path::new("missing.yml"), false).is_empty());

        // enabled -> path is passed through verbatim, existence is not checked
        let args = resolve_patch_args(Path::new("missing.yml"), true);
        assert_eq!(args, vec!["--patch".to_string(), "missing.yml".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn junctions_idempotent() {
        let root = test_root("junction");
        let src = root.join("src-plugin");
        let home = root.join("home").join("node_modules");
        fs::create_dir_all(&src).expect("create source dir");
        fs::create_dir_all(&home).expect("create home node_modules");

        let links = vec![("dep".to_string(), src.clone())];

        // First call creates the junction.
        let errors = ensure_junctions(&home, &links);
        assert!(errors.is_empty(), "first junction call failed: {errors:?}");
        let target = home.join("dep");
        assert!(target.exists(), "junction target should exist");
        assert!(
            fs::symlink_metadata(&target)
                .expect("stat junction")
                .file_type()
                .is_symlink(),
            "created link should be a junction"
        );

        // Second call is a no-op: no errors, link still valid.
        let errors = ensure_junctions(&home, &links);
        assert!(errors.is_empty(), "second junction call failed: {errors:?}");
        assert!(target.exists(), "junction should still exist after second call");
        assert!(
            fs::symlink_metadata(&target)
                .expect("stat junction")
                .file_type()
                .is_symlink()
        );

        // A missing source produces a junction that does not resolve, which
        // must be reported as an error rather than accepted silently.
        let broken = vec![("bad".to_string(), root.join("no-such-source"))];
        let errors = ensure_junctions(&home, &broken);
        assert_eq!(errors.len(), 1, "missing source should produce one error");
        assert!(!errors[0].is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}
