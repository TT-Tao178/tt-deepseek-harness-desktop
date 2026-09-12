//! Windows Job Object:内核进程树的**微秒级**终结 + 孤儿兜底(P43)。
//!
//! - spawn 时把内核进程 assign 进常驻 Job(`assign`);
//! - 杀 = `terminate()`(TerminateJobObject,微秒级,整树瞬灭),
//!   替代 taskkill /T /F 的 264ms+ 同步开销;
//! - Job 设 `KILL_ON_JOB_CLOSE`:壳进程无论正常退出还是被强杀,
//!   句柄表关闭 → OS 自动收割内核树(孤儿内核不可能存活);
//! - 终止后的 Job 仍可继续 assign 新进程(同一壳会话内反复重启内核)。
//!
//! 参考实现:官方 dsh_desktop `kernel-process/src/job_object.rs`
//! (其版本只做 KILL_ON_JOB_CLOSE 兜底、故意泄漏句柄;本项目需要
//! terminate 语义,故持有句柄并提供 `terminate`)。

/// Windows Job 句柄包装(isize 存储以获得 Send;句柄由本结构独占)。
pub struct KillJob {
    handle: isize,
}

// HANDLE 本质是内核句柄整数,跨线程使用安全(全部 API 线程无关)。
unsafe impl Send for KillJob {}

impl KillJob {
    /// 创建带 KILL_ON_JOB_CLOSE 的 Job 对象。
    pub fn create() -> Result<Self, String> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("CreateJobObjectW 失败".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err("SetInformationJobObject(KILL_ON_JOB_CLOSE) 失败".into());
            }
            Ok(KillJob { handle: job as isize })
        }
    }

    fn handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.handle as windows_sys::Win32::Foundation::HANDLE
    }

    /// 把子进程纳入 Job(在子进程句柄被移走之前调用)。
    pub fn assign(&self, child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            if AssignProcessToJobObject(self.handle(), child.as_raw_handle() as _) == 0 {
                return Err("AssignProcessToJobObject 失败".into());
            }
        }
        Ok(())
    }

    /// 微秒级终结 Job 内整个进程树。Job 对象本身仍存活,可继续 assign。
    pub fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.handle(), 0);
        }
    }
}

/// 非 Windows 空实现(本项目仅 Windows,保持编译一致)。
#[cfg(not(windows))]
pub struct KillJob;
#[cfg(not(windows))]
impl KillJob {
    pub fn create() -> Result<Self, String> {
        Ok(KillJob)
    }
    pub fn assign(&self, _child: &std::process::Child) -> Result<(), String> {
        Ok(())
    }
    pub fn terminate(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// P43 回归:assign 进 Job 的进程树必须能被 terminate() 微秒级终结,
    /// 且 Job 在 terminate 后可继续 assign 新进程(壳内反复重启内核)。
    #[cfg(windows)]
    #[test]
    fn terminate_kills_assigned_tree_and_job_stays_usable() {
        let job = KillJob::create().expect("create job");

        // 第一棵树:cmd /C ping(有子进程,验证树终结)。
        let mut child = Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1", ">nul"])
            .spawn()
            .expect("spawn tree");
        job.assign(&child).expect("assign");

        let t0 = Instant::now();
        job.terminate();
        let exited = loop {
            match child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() - t0 < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(30));
                }
                _ => break false,
            }
        };
        let elapsed = t0.elapsed();
        let _ = child.wait();
        assert!(exited, "terminate 后进程树必须退出");
        assert!(
            elapsed < Duration::from_secs(2),
            "terminate 应为微秒级(实测 {elapsed:?})"
        );

        // 第二棵树:同一 Job 继续可用(壳内反复重启内核的场景)。
        let mut child2 = Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1", ">nul"])
            .spawn()
            .expect("spawn tree 2");
        job.assign(&child2).expect("assign after terminate");
        job.terminate();
        let exited2 = loop {
            match child2.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() - t0 < Duration::from_secs(10) => {
                    std::thread::sleep(Duration::from_millis(30));
                }
                _ => break false,
            }
        };
        let _ = child2.wait();
        assert!(exited2, "terminate 后 Job 必须可复用");
    }
}
