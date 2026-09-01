use std::path::{Path, PathBuf};

/// Central place that derives every fixed path used by the shell layer.
#[derive(Debug, Clone)]
pub struct DshPaths {
    app_data: PathBuf,
    home: PathBuf,
    kernel: PathBuf,
    plugins: PathBuf,
    logs: PathBuf,
}

impl DshPaths {
    /// Build the path set from the app-data root plus the fixed project
    /// directories that hold the kernel and the plugins.
    pub fn new(app_data: PathBuf, kernel_dir: PathBuf, plugins_dir: PathBuf) -> Self {
        Self {
            home: app_data.join("dsh-home"),
            logs: app_data.join("logs"),
            kernel: kernel_dir,
            plugins: plugins_dir,
            app_data,
        }
    }

    /// The app-data root itself.
    pub fn app_data(&self) -> &Path {
        &self.app_data
    }

    /// The per-user home directory (`<app_data>/dsh-home`).
    pub fn home_dsh(&self) -> &Path {
        &self.home
    }

    /// `<home>/node_modules` — where plugin junctions are linked.
    pub fn home_node_modules(&self) -> PathBuf {
        self.home.join("node_modules")
    }

    /// The directory that contains the kernel runtime.
    pub fn kernel_dir(&self) -> &Path {
        &self.kernel
    }

    /// The kernel's Node.js executable (`<kernel>/node.exe`).
    pub fn kernel_node(&self) -> PathBuf {
        self.kernel.join("node.exe")
    }

    /// The kernel's entry script
    /// (`<kernel>/node_modules/@deepseek-ai/dsh/lib/bin.js`).
    pub fn kernel_bin_js(&self) -> PathBuf {
        self.kernel
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
    }

    /// The directory that contains the project plugins.
    pub fn plugins_dir(&self) -> &Path {
        &self.plugins
    }

    /// `<logs>/kernel.log` — where the kernel writes its log.
    pub fn kernel_log(&self) -> PathBuf {
        self.logs.join("kernel.log")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DshPaths {
        DshPaths::new(
            PathBuf::from("app-data"),
            PathBuf::from("kernel"),
            PathBuf::from("plugins"),
        )
    }

    /// Fold components with `.join()` so the expectation is separator-agnostic
    /// on both Windows (`\`) and Unix (`/`).
    fn p(parts: &[&str]) -> PathBuf {
        parts
            .iter()
            .fold(PathBuf::new(), |acc, part| acc.join(part))
    }

    #[test]
    fn path_assembly() {
        let paths = sample();

        assert_eq!(paths.app_data(), Path::new("app-data"));
        assert_eq!(paths.home_dsh(), p(&["app-data", "dsh-home"]));
        assert_eq!(paths.home_node_modules(), p(&["app-data", "dsh-home", "node_modules"]));
        assert_eq!(paths.kernel_dir(), Path::new("kernel"));
        assert_eq!(paths.kernel_node(), p(&["kernel", "node.exe"]));
        assert_eq!(
            paths.kernel_bin_js(),
            p(&["kernel", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"])
        );
        assert_eq!(paths.plugins_dir(), Path::new("plugins"));
        assert_eq!(paths.kernel_log(), p(&["app-data", "logs", "kernel.log"]));
    }

    #[test]
    fn paths_are_independent_of_input_mutation() {
        let mut app_data = PathBuf::from("app-data");
        let kernel = PathBuf::from("kernel");
        let plugins = PathBuf::from("plugins");
        let paths = DshPaths::new(app_data.clone(), kernel.clone(), plugins.clone());

        // Mutating the inputs afterwards must not affect the derived paths.
        app_data.push("changed");
        assert_eq!(paths.home_dsh(), p(&["app-data", "dsh-home"]));
        assert_eq!(paths.kernel_node(), p(&["kernel", "node.exe"]));
    }
}
