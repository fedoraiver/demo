//! 旧命令入口委托共享编译器宿主，不保留独立编译器实现。
#![feature(rustc_private)]
fn main() -> std::process::ExitCode {
    analysis_compiler::driver::main()
}
