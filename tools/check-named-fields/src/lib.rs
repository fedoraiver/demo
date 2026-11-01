//! Cargo 编排和报告数据不持有编译器会话中的引用。
pub mod report {
    pub use analysis_contract::named_fields::*;
}
pub mod runner {
    pub use rustc_analysis::{Options, check_named_fields as check, normalized};
}
