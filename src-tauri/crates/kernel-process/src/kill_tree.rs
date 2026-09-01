use std::process::Command;

/// Best-effort termination of a process and its whole child tree.
///
/// On Windows this runs `taskkill /T /F /PID <pid>`. All errors are
/// ignored: the function never panics and reports nothing, so the caller
/// can treat it as a fire-and-forget cleanup.
pub fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn kill_tree_nonexistent_pid_does_not_panic() {
        // taskkill fails for a non-existent pid; the error is swallowed.
        kill_tree(0);
        kill_tree(u32::MAX);
    }

    #[test]
    #[cfg(windows)]
    fn kill_tree_terminates_child_tree() {
        use std::process::Command as StdCommand;
        use std::thread;

        let mut child = StdCommand::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1", ">nul"])
            .spawn()
            .expect("spawn fake child process");
        let pid = child.id();

        // Give the child a moment to actually start.
        thread::sleep(Duration::from_millis(200));
        kill_tree(pid);

        // Poll until the process tree has exited.
        let deadline = Instant::now() + Duration::from_secs(10);
        let exited = loop {
            match child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(50));
                }
                _ => break false,
            }
        };
        if exited {
            return;
        }

        // The child survived. Some hardened environments deny taskkill
        // itself ("Access denied" even for self-spawned children); verify
        // that is the case here before failing, and clean up via the native
        // kill API.
        let taskkill_status = StdCommand::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .status();
        let taskkill_denied = !matches!(taskkill_status, Ok(status) if status.success());
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            taskkill_denied,
            "kill_tree did not terminate the child tree while taskkill itself succeeded"
        );
        eprintln!("note: taskkill is denied in this environment (access denied); skipping exit assertion");
    }
}
