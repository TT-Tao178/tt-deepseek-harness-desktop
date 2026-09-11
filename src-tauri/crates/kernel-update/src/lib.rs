//! 内核更新管线（纯逻辑层，零 tauri 依赖）：
//! - [`plan`]：semver 解析/比较、升级判定；
//! - [`update_state`]：更新任务状态机（合法迁移表）；
//! - [`swap`]：目录换名（staging 换入 / 备份轮换 / 回滚 / 预检）；
//! - [`installer_bridge`]：spawn Node 安装器并解析进度事件。
//!
//! 网络与解压在 Node 侧（installer 脚本）；本 crate 只做编排与纯逻辑，
//! 保证 cargo test 可全覆盖。

pub mod installer_bridge;
pub mod plan;
pub mod swap;
pub mod update_state;

/// 安装器脚本默认位置（相对 app 根）。
pub fn installer_script_path(app_root: &std::path::Path) -> std::path::PathBuf {
    app_root
        .join("resources")
        .join("installer")
        .join("install-kernel.cjs")
}
