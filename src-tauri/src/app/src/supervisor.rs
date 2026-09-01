//! 内核进程 supervisor：spawn → 健康轮询 → ready；退出 → 指数退避重启 → exhausted。
//!
//! 本模块不依赖 tauri，进程操作通过 [`KernelOps`] 抽象注入，可用假实现单测
//! 完整的状态机序列。进程退出的检测由外部（exit 监听线程）负责：调用
//! [`Supervisor::on_exit`] 标记，下一次 [`Supervisor::poll_health`] 消费该标记
//! 并做退避决策。

use kernel_process::crash_loop::Backoff;

/// 内核生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelState {
    /// 已 spawn，等待健康检查通过。
    Starting,
    /// 健康检查通过，内核对外可用。
    Ready,
    /// 进程已退出，等待退避延迟后重启。
    Crashed,
    /// 手动停止。
    Stopped,
    /// 退避耗尽，不再自动重启。
    Exhausted,
}

/// 内核进程操作抽象（可注入假实现用于单测）。
pub trait KernelOps: Send {
    /// 启动内核进程，返回其 pid。
    fn spawn(&mut self) -> Result<u32, String>;
    /// 探测内核是否健康（例如端口可连通）。
    fn is_healthy(&self) -> bool;
    /// 终止 pid 对应的整个进程树。
    fn kill(&self, pid: u32);
}

/// 一次健康轮询的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthResult {
    /// 健康检查通过，内核已就绪。
    Ready,
    /// 仍在启动中（尚未健康，也未退出）。
    StillStarting,
    /// 进程已退出，退避决策为等待后重启。
    Crashed,
    /// 进程已退出，退避耗尽，不再重启。
    Exhausted,
}

/// 内核生命周期管理器。
pub struct Supervisor {
    state: KernelState,
    ops: Box<dyn KernelOps>,
    backoff: Backoff,
    pid: Option<u32>,
    ready_port: Option<u16>,
    /// 外部 exit 监听线程标记的“进程已退出”，由下一次 poll_health 消费。
    exited: bool,
    /// 最近一次崩溃后的退避延迟（毫秒），restart 前等待。
    pending_delay_ms: Option<u64>,
}

impl Supervisor {
    pub fn new(ops: Box<dyn KernelOps>) -> Self {
        Supervisor {
            state: KernelState::Stopped,
            ops,
            backoff: Backoff::new(),
            pid: None,
            ready_port: None,
            exited: false,
            pending_delay_ms: None,
        }
    }

    pub fn state(&self) -> KernelState {
        self.state
    }

    /// 记录内核监听端口（由装配层在启动前设置）。
    pub fn set_ready_port(&mut self, port: u16) {
        self.ready_port = Some(port);
    }

    pub fn ready_port(&self) -> Option<u16> {
        self.ready_port
    }

    /// 启动内核：spawn 成功 → Starting 并记录 pid。
    ///
    /// 已在 Starting/Ready 时幂等返回 Ok(())；spawn 失败返回 Err 且状态不变。
    pub fn start(&mut self) -> Result<(), String> {
        if matches!(self.state, KernelState::Starting | KernelState::Ready) {
            return Ok(());
        }
        let pid = self.ops.spawn()?;
        self.pid = Some(pid);
        self.state = KernelState::Starting;
        self.exited = false;
        self.pending_delay_ms = None;
        Ok(())
    }

    /// 健康轮询。优先消费 on_exit 标记做退避决策（Some → Crashed，None → Exhausted）；
    /// 否则在 Starting 时探测健康，通过则转 Ready。
    pub fn poll_health(&mut self) -> HealthResult {
        if self.exited {
            self.exited = false;
            self.pid = None;
            match self.backoff.next_delay_ms() {
                Some(delay) => {
                    self.state = KernelState::Crashed;
                    self.pending_delay_ms = Some(delay);
                    HealthResult::Crashed
                }
                None => {
                    self.state = KernelState::Exhausted;
                    HealthResult::Exhausted
                }
            }
        } else {
            match self.state {
                KernelState::Starting => {
                    if self.ops.is_healthy() {
                        self.state = KernelState::Ready;
                        HealthResult::Ready
                    } else {
                        HealthResult::StillStarting
                    }
                }
                KernelState::Ready => HealthResult::Ready,
                KernelState::Crashed => HealthResult::Crashed,
                KernelState::Exhausted => HealthResult::Exhausted,
                KernelState::Stopped => HealthResult::StillStarting,
            }
        }
    }

    /// 重启：Crashed 时先等退避延迟，再调 ops.spawn()。
    ///
    /// spawn 失败时保持 Crashed（退避不推进），并设置 1s 冷却后重试。
    pub fn restart(&mut self) -> Result<(), String> {
        if self.state != KernelState::Crashed {
            return Err("restart called while kernel is not crashed".to_string());
        }
        if let Some(delay) = self.pending_delay_ms.take() {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
        match self.start() {
            Ok(()) => Ok(()),
            Err(e) => {
                self.state = KernelState::Crashed;
                self.pending_delay_ms = Some(1000);
                Err(e)
            }
        }
    }

    /// 停止：state=Stopped，pid 存在则 kill 进程树，重置退避。
    pub fn stop(&mut self) {
        self.state = KernelState::Stopped;
        self.exited = false;
        self.pending_delay_ms = None;
        if let Some(pid) = self.pid.take() {
            self.ops.kill(pid);
        }
        self.backoff.reset();
    }

    /// 外部（exit 监听线程）通知内核进程已退出。
    ///
    /// 仅在运行中（Starting/Ready/Crashed）接受；Stopped/Exhausted 忽略。
    pub fn on_exit(&mut self) {
        if matches!(self.state, KernelState::Stopped | KernelState::Exhausted) {
            return;
        }
        self.exited = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    /// 可注入的假 ops：spawn 返回递增 pid（可配置失败次数），is_healthy 可切换，
    /// kill 记录调用。
    struct FakeOps {
        next_pid: AtomicU32,
        healthy: Arc<AtomicBool>,
        kills: Arc<Mutex<Vec<u32>>>,
        fail_spawns: Arc<AtomicU32>,
    }

    impl FakeOps {
        fn new() -> Self {
            FakeOps {
                next_pid: AtomicU32::new(100),
                healthy: Arc::new(AtomicBool::new(false)),
                kills: Arc::new(Mutex::new(Vec::new())),
                fail_spawns: Arc::new(AtomicU32::new(0)),
            }
        }
        fn healthy(&self) -> Arc<AtomicBool> {
            self.healthy.clone()
        }
        fn kills(&self) -> Arc<Mutex<Vec<u32>>> {
            self.kills.clone()
        }
        fn fail_spawns(&self) -> Arc<AtomicU32> {
            self.fail_spawns.clone()
        }
    }

    impl KernelOps for FakeOps {
        fn spawn(&mut self) -> Result<u32, String> {
            if self.fail_spawns.load(Ordering::SeqCst) > 0 {
                self.fail_spawns.fetch_sub(1, Ordering::SeqCst);
                return Err("fake spawn failure".to_string());
            }
            Ok(self.next_pid.fetch_add(1, Ordering::SeqCst))
        }
        fn is_healthy(&self) -> bool {
            self.healthy.load(Ordering::SeqCst)
        }
        fn kill(&self, pid: u32) {
            self.kills.lock().unwrap().push(pid);
        }
    }

    #[test]
    fn start_then_healthy_poll_becomes_ready() {
        let ops = FakeOps::new();
        let healthy = ops.healthy();
        let mut sup = Supervisor::new(Box::new(ops));

        sup.start().expect("start");
        assert_eq!(sup.state(), KernelState::Starting);
        assert!(matches!(sup.poll_health(), HealthResult::StillStarting));

        healthy.store(true, Ordering::SeqCst);
        assert!(matches!(sup.poll_health(), HealthResult::Ready));
        assert_eq!(sup.state(), KernelState::Ready);
        assert!(matches!(sup.poll_health(), HealthResult::Ready), "stays ready");
    }

    #[test]
    fn exit_during_start_polls_to_crashed() {
        let ops = FakeOps::new();
        let mut sup = Supervisor::new(Box::new(ops));

        sup.start().expect("start");
        assert_eq!(sup.state(), KernelState::Starting);

        sup.on_exit();
        assert!(matches!(sup.poll_health(), HealthResult::Crashed));
        assert_eq!(sup.state(), KernelState::Crashed);
    }

    #[test]
    fn four_consecutive_exits_exhaust_backoff() {
        let ops = FakeOps::new();
        let mut sup = Supervisor::new(Box::new(ops));

        sup.start().expect("start");
        for _ in 0..3 {
            sup.on_exit();
            assert!(matches!(sup.poll_health(), HealthResult::Crashed));
        }
        sup.on_exit();
        assert!(matches!(sup.poll_health(), HealthResult::Exhausted));
        assert_eq!(sup.state(), KernelState::Exhausted);

        // 耗尽后忽略新的退出通知。
        sup.on_exit();
        assert_eq!(sup.state(), KernelState::Exhausted);
    }

    #[test]
    fn stop_kills_pid_and_resets_backoff() {
        let ops = FakeOps::new();
        let kills = ops.kills();
        let mut sup = Supervisor::new(Box::new(ops));

        // stop 必须 kill 已记录的 pid。
        sup.start().expect("start");
        sup.stop();
        assert_eq!(sup.state(), KernelState::Stopped);
        assert_eq!(kills.lock().unwrap().as_slice(), &[100]);

        // 耗尽退避后再 stop → 新序列应从 1000ms 重新开始（而非仍 Exhausted）。
        sup.start().expect("start");
        for _ in 0..4 {
            sup.on_exit();
            let _ = sup.poll_health();
        }
        assert_eq!(sup.state(), KernelState::Exhausted);
        sup.stop();
        assert_eq!(sup.state(), KernelState::Stopped);

        sup.start().expect("start");
        sup.on_exit();
        assert!(
            matches!(sup.poll_health(), HealthResult::Crashed),
            "backoff must reset after stop"
        );
    }

    #[test]
    fn spawn_failure_then_retry_succeeds() {
        let ops = FakeOps::new();
        ops.fail_spawns().store(1, Ordering::SeqCst);
        let mut sup = Supervisor::new(Box::new(ops));

        let err = sup.start().unwrap_err();
        assert!(err.contains("fake"), "unexpected error: {err}");
        assert_eq!(sup.state(), KernelState::Stopped, "failed start leaves state unchanged");

        sup.start().expect("second start succeeds");
        assert_eq!(sup.state(), KernelState::Starting);
    }

    #[test]
    fn restart_waits_backoff_and_recovers_from_spawn_failure() {
        let ops = FakeOps::new();
        let fail = ops.fail_spawns();
        let mut sup = Supervisor::new(Box::new(ops));

        sup.start().expect("initial start");
        assert_eq!(sup.state(), KernelState::Starting);

        fail.store(1, Ordering::SeqCst);
        sup.on_exit();
        assert!(matches!(sup.poll_health(), HealthResult::Crashed));
        assert_eq!(sup.state(), KernelState::Crashed);

        // 第一次 restart：等退避延迟(1000ms)后 spawn 失败 → 保持 Crashed。
        assert!(sup.restart().is_err(), "restart must surface spawn failure");
        assert_eq!(sup.state(), KernelState::Crashed);

        // 第二次 restart：spawn 成功。
        sup.restart().expect("retry restart succeeds");
        assert_eq!(sup.state(), KernelState::Starting);
    }

    #[test]
    fn restart_outside_crashed_is_rejected() {
        let ops = FakeOps::new();
        let mut sup = Supervisor::new(Box::new(ops));
        assert!(sup.restart().is_err());
    }

    #[test]
    fn start_while_running_is_idempotent() {
        let ops = FakeOps::new();
        let mut sup = Supervisor::new(Box::new(ops));

        sup.start().expect("start");
        sup.start().expect("second start is a no-op");
        assert_eq!(sup.state(), KernelState::Starting);
    }
}
