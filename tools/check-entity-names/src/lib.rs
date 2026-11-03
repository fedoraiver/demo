//! Cargo 编排和脱离编译器生命周期的检查报告。
pub mod model {
    pub use analysis_contract::entity_names::*;
}
pub mod workspace {
    pub use rustc_analysis::{Options, check_entity_names as check, normalized};
}
