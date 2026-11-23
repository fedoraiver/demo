//! 为各入口提供仓库路径和 Windows 链接清单。

use std::{env, path::Path};

#[path = "../build_configuration.rs"]
mod build_configuration;

fn main() {
    // 共享源码会检查各入口的 feature，本次编译启用哪些仍由各包清单决定。
    println!("cargo::rustc-check-cfg=cfg(feature, values(\"acceptance-test\", \"inspector\"))");
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR").unwrap();
    let workspace_root = Path::new(&manifest_dir)
        .parent()
        .and_then(Path::parent)
        .expect("Application package must be under apps/");
    println!(
        "cargo::rustc-env=DEMO_WORKSPACE_ROOT={}",
        workspace_root.display()
    );
    println!("cargo::rerun-if-changed=../build.rs");
    println!("cargo::rerun-if-changed=../../build_configuration.rs");
    build_configuration::emit_build_configuration();
}
