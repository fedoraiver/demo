//! 为各入口声明共享条件编译值和 Windows 链接清单。

#[path = "../build_configuration.rs"]
mod build_configuration;

fn main() {
    // 共享源码会检查各入口的 feature，本次编译启用哪些仍由各包清单决定。
    println!("cargo::rustc-check-cfg=cfg(feature, values(\"acceptance-test\", \"inspector\"))");
    println!("cargo::rerun-if-changed=../build.rs");
    println!("cargo::rerun-if-changed=../../build_configuration.rs");
    build_configuration::emit_build_configuration();
}
