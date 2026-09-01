use std::path::PathBuf;
use std::process::Command;

/// Description of how to spawn the kernel process.
pub struct KernelSpec {
    /// Path to the Node.js executable.
    pub node_exe: PathBuf,
    /// Path to the kernel bundle entry JavaScript file.
    pub bin_js: PathBuf,
    /// Port the kernel should listen on.
    pub port: u16,
    /// Extra arguments appended verbatim (e.g. `--patch`, `<path>` pairs).
    pub patch_args: Vec<String>,
    /// Environment variables injected into the spawned process.
    pub env: Vec<(String, String)>,
}

impl KernelSpec {
    /// Builds the [`Command`] for this spec: the node executable, the
    /// argument vector produced by [`Self::args_vec`], and the injected
    /// environment variables.
    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.node_exe);
        cmd.args(self.args_vec());
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        cmd
    }

    /// Produces the full argument vector:
    /// `[bin_js, --profile, web, <patch_args...>, --port, <port>]`.
    pub fn args_vec(&self) -> Vec<String> {
        let mut args = Vec::new();
        args.push(self.bin_js.to_string_lossy().into_owned());
        args.push("--profile".to_string());
        args.push("web".to_string());
        args.extend(self.patch_args.iter().cloned());
        args.push("--port".to_string());
        args.push(self.port.to_string());
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_spec() -> KernelSpec {
        KernelSpec {
            node_exe: PathBuf::from(r"C:\tools\node.exe"),
            bin_js: PathBuf::from(r"C:\kernel\bin.js"),
            port: 8080,
            patch_args: vec![
                "--patch".to_string(),
                r"C:\patches\a.js".to_string(),
                "--patch".to_string(),
                r"C:\patches\b.js".to_string(),
            ],
            env: vec![
                ("KERNEL_TOKEN".to_string(), "secret".to_string()),
                ("KERNEL_DEBUG".to_string(), "1".to_string()),
            ],
        }
    }

    #[test]
    fn args_vec_is_exact_sequence() {
        let spec = sample_spec();
        assert_eq!(
            spec.args_vec(),
            vec![
                r"C:\kernel\bin.js",
                "--profile",
                "web",
                "--patch",
                r"C:\patches\a.js",
                "--patch",
                r"C:\patches\b.js",
                "--port",
                "8080",
            ]
        );
    }

    #[test]
    fn command_args_match_args_vec() {
        let spec = sample_spec();
        let got: Vec<String> = spec
            .command()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(got, spec.args_vec());
    }

    #[test]
    fn command_injects_all_env_vars() {
        let spec = sample_spec();
        let envs: Vec<(String, String)> = spec
            .command()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()).unwrap_or_default(),
                )
            })
            .collect();

        for (key, value) in &spec.env {
            assert!(
                envs.iter().any(|(ek, ev)| ek == key && ev == value),
                "env {key}={value} missing from command"
            );
        }
    }

    #[test]
    fn empty_patch_args_yields_no_patch_flag() {
        let mut spec = sample_spec();
        spec.patch_args = vec![];

        let args = spec.args_vec();
        assert!(!args.iter().any(|arg| arg == "--patch"));
        assert_eq!(args, vec![r"C:\kernel\bin.js", "--profile", "web", "--port", "8080"]);
    }
}
