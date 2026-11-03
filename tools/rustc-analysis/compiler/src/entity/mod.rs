//! 实体创建值流与名称规则；复用同一编译器类型、常量和 MIR 数据流分析。
pub mod analysis;
pub mod bevy;
pub mod call_graph;
pub mod constants;
pub mod liveness;
pub mod mir_value;
