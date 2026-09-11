//! 更新状态机：阶段枚举 + 合法迁移表（纯逻辑，可注入测试）。
//!
//! 主链：Idle → Resolving → Downloading → Extracting → SelfTest →
//! Swapping → Restarting → Done。
//! 失败：除 Swapping/Restarting（换名后失败要走回滚）外，任何阶段错误
//! → Failed（清理 staging，正式内核未动）。Restarting 健康失败 →
//! Rollback → Restarting → Done(已回滚) / Failed。
//! 取消：仅 Resolving/Downloading 允许（下载期可中断）。

/// 更新任务所处的阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// 无任务。
    Idle,
    /// 解析依赖闭包。
    Resolving,
    /// 下载包（可取消）。
    Downloading,
    /// 解压摊平到 staging。
    Extracting,
    /// staging 内核自检（临时端口自举探活）。
    SelfTest,
    /// 目录换名：正式 → 备份，staging → 正式。
    Swapping,
    /// 重启内核并做健康检查。
    Restarting,
    /// 健康失败，换回备份版本。
    Rollback,
    /// 成功结束（含“已回滚”标记由上层事件表达）。
    Done,
    /// 失败结束。
    Failed,
}

/// 是否允许 from → to 迁移（非法迁移一律拒绝，防状态漂移）。
pub fn can_transition(from: Phase, to: Phase) -> bool {
    use Phase::*;
    matches!(
        (from, to),
        (Idle, Resolving)
            | (Resolving, Downloading)
            | (Resolving, Failed)
            | (Resolving, Idle) // 取消
            | (Downloading, Extracting)
            | (Downloading, Failed)
            | (Downloading, Idle) // 取消
            | (Extracting, SelfTest)
            | (Extracting, Failed)
            | (SelfTest, Swapping)
            | (SelfTest, Failed)
            | (Swapping, Restarting)
            | (Swapping, Failed) // 换名失败（已尽力恢复原状）
            | (Restarting, Done)
            | (Restarting, Rollback)
            | (Rollback, Restarting) // 回滚后再次重启（旧版本）
            | (Rollback, Failed)     // 回滚也失败
            | (Done, Idle)
            | (Failed, Idle)
    )
}

/// 用户点「取消」在当前阶段是否可用（仅下载前两阶段）。
pub fn cancel_allowed(phase: Phase) -> bool {
    matches!(phase, Phase::Resolving | Phase::Downloading)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(from: Phase, to: Phase) -> bool {
        can_transition(from, to)
    }

    #[test]
    fn happy_path_transitions_allowed() {
        let chain = [
            Phase::Idle,
            Phase::Resolving,
            Phase::Downloading,
            Phase::Extracting,
            Phase::SelfTest,
            Phase::Swapping,
            Phase::Restarting,
            Phase::Done,
            Phase::Idle,
        ];
        for w in chain.windows(2) {
            assert!(t(w[0], w[1]), "legal: {:?} -> {:?}", w[0], w[1]);
        }
    }

    #[test]
    fn failure_exits_allowed() {
        assert!(t(Phase::Resolving, Phase::Failed));
        assert!(t(Phase::Downloading, Phase::Failed));
        assert!(t(Phase::Extracting, Phase::Failed));
        assert!(t(Phase::SelfTest, Phase::Failed));
        assert!(t(Phase::Swapping, Phase::Failed));
        assert!(t(Phase::Rollback, Phase::Failed));
        assert!(t(Phase::Failed, Phase::Idle));
    }

    #[test]
    fn rollback_loop_allowed() {
        assert!(t(Phase::Restarting, Phase::Rollback));
        assert!(t(Phase::Rollback, Phase::Restarting));
        assert!(t(Phase::Restarting, Phase::Done));
    }

    #[test]
    fn illegal_transitions_rejected() {
        assert!(!t(Phase::Idle, Phase::Downloading), "不能跳过解析直接下载");
        assert!(!t(Phase::Idle, Phase::Swapping));
        assert!(!t(Phase::Done, Phase::Swapping), "结束态只能回 Idle");
        assert!(!t(Phase::Failed, Phase::Downloading), "失败后必须先回 Idle");
        assert!(!t(Phase::Extracting, Phase::Idle), "解压期不可取消（删除半成品目录之外的状态）");
        assert!(!t(Phase::SelfTest, Phase::Idle));
        assert!(!t(Phase::Restarting, Phase::Idle));
        assert!(!t(Phase::Done, Phase::Done));
    }

    #[test]
    fn cancel_only_before_extract() {
        assert!(cancel_allowed(Phase::Resolving));
        assert!(cancel_allowed(Phase::Downloading));
        assert!(!cancel_allowed(Phase::Extracting));
        assert!(!cancel_allowed(Phase::Idle));
        assert!(!cancel_allowed(Phase::Restarting));
    }
}
