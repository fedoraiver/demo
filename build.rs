//! 为 Windows 原生窗口策略声明 Common Controls v6，确保按名称导入的入口可用。

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!(
        "cargo::rustc-env=DEMO_BUILD_TARGET={}",
        std::env::var("TARGET").unwrap()
    );

    // 按编译目标判断平台，避免从 macOS 交叉编译时把宿主平台当作目标平台。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    // GetWindowSubclass 要求 v6；嵌入清单让系统在进入 main 前选择正确的 DLL。
    // 通用链接参数同时覆盖游戏与测试程序，避免测试仍加载默认的旧版入口。
    println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo::rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}
