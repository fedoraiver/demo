//! 共享 Cargo 编排和独立模型装配，不加载 rustc 内部动态库。
pub mod host;
pub mod model;

pub use analysis_contract::normalized;
pub use host::{Options, check_entity_names, check_named_fields, extract};
