//! 共享 Cargo 编排和独立模型装配，不加载 rustc 内部动态库。
#[cfg(test)]
mod cache_tests;
pub mod host;
pub mod model;
mod report_cache;
mod unit_binding;
mod unit_graph;

pub use analysis_contract::normalized;
pub use host::{Options, check_entity_names, check_named_fields, extract};
