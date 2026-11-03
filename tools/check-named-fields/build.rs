//! 编译器宿主与运行时必须使用同一 rustc ABI。
use std::{env, fs, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../../rust-toolchain.toml");
    let toolchain = fs::read_to_string("../../rust-toolchain.toml").unwrap();
    let channel = toolchain
        .lines()
        .find(|line| line.starts_with("channel ="))
        .and_then(|line| line.split('"').nth(1))
        .unwrap();
    println!("cargo:rustc-env=NAMED_FIELDS_TOOLCHAIN={channel}");
    let output = Command::new(env::var_os("RUSTC").unwrap())
        .arg("-vV")
        .output()
        .unwrap();
    assert!(output.status.success());
    let version = String::from_utf8(output.stdout).unwrap();
    let commit = version
        .lines()
        .find_map(|line| line.strip_prefix("commit-hash: "))
        .unwrap();
    println!("cargo:rustc-env=NAMED_FIELDS_RUSTC={commit}");
}
