//! 固定宿主与目标编译器 ABI，供普通运行层和内部驱动共同核验。
use std::{env, fs, process::Command};

fn main() {
    let manifest = std::path::PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let mut directory = manifest.as_path();
    let toolchain = loop {
        let candidate = directory.join("rust-toolchain.toml");
        if candidate.is_file() {
            break candidate;
        }
        directory = directory.parent().expect("Missing repository toolchain");
    };
    println!("cargo:rerun-if-changed={}", toolchain.display());
    let text = fs::read_to_string(toolchain).unwrap();
    let channel = text
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("channel =")
                .and_then(|value| value.split('"').nth(1))
        })
        .unwrap();
    let output = Command::new(env::var_os("RUSTC").unwrap())
        .arg("-vV")
        .output()
        .unwrap();
    assert!(output.status.success(), "Cannot identify build compiler");
    let version = String::from_utf8(output.stdout).unwrap();
    let commit = version
        .lines()
        .find_map(|line| line.strip_prefix("commit-hash: "))
        .unwrap();
    println!("cargo:rustc-env=ANALYSIS_TOOLCHAIN={channel}");
    println!("cargo:rustc-env=ANALYSIS_COMPILER={commit}");
}
