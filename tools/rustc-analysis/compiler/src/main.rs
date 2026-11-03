//! Cargo 调用的统一分析驱动入口。
#![feature(rustc_private)]
fn main() -> std::process::ExitCode {
    analysis_compiler::driver::main()
}
