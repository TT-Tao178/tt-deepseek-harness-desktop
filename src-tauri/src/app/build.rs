use std::path::Path;
use std::process::Command;

fn main() {
    tauri_build::build();

    // GNU 工具链下 tauri-winres 只把资源（manifest + icon）链接进 bin target
    // （embed-resource::compile 检测到 crate 有 bin 时走 rustc-link-arg-bins）。
    // 测试二进制因此只有 rustc 默认 manifest，缺少 tauri 模板里的
    // Microsoft.Windows.Common-Controls v6 依赖 —— 激活 comctl32 v6 失败，
    // 导入 TaskDialogIndirect 的测试二进制启动即 0xC0000139。
    // 这里用 windres 单独编译 resource.rc 为独立 .o，再全局链接进所有 target。
    #[cfg(target_os = "windows")]
    {
        let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
        let rc = Path::new(&out_dir).join("resource.rc");
        let test_o = Path::new(&out_dir).join("resource-tests.o");
        if rc.exists() {
            let status = Command::new("windres")
                .args(["--input"])
                .arg(&rc)
                .args(["--output"])
                .arg(&test_o)
                .args(["--include-dir", &out_dir, "--output-format=coff"])
                .status();
            if matches!(status, Ok(s) if s.success()) && test_o.exists() {
                println!("cargo:rustc-link-arg={}", test_o.display());
            } else {
                println!("cargo:warning=windres failed for test resource: {:?}", status);
            }
        }
    }
}
