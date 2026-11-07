//! 编译器会话之外使用的声明、类型、调用与证据；不保存 rustc 的借用或数字索引。
use serde::{Deserialize, Serialize};

pub const FACT_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitFacts {
    pub schema_version: u32,
    pub crate_name: String,
    pub crate_identity: String,
    #[serde(default)]
    pub behavior_hash: String,
    #[serde(default)]
    pub purpose_inventory: PurposeInventory,
    pub source_files: Vec<SourceFile>,
    pub declarations: Vec<Declaration>,
    pub types: Vec<TypeInstance>,
    pub callables: Vec<Callable>,
    pub accesses: Vec<AccessFact>,
    pub operations: Vec<OperationFact>,
    pub calls: Vec<CallFact>,
    /// 用途闭包审计的内部调用；不作为业务传播或公开调用图的条件证据。
    pub purpose_calls: Vec<CallFact>,
    pub entities: Vec<EntityTemplate>,
    pub registrations: Vec<RegistrationFact>,
    pub gaps: Vec<Gap>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFile {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceEvidence {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub role: String,
    pub sha256: String,
    pub snippet: String,
    pub expansions: Vec<Expansion>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expansion {
    pub name: String,
    pub path: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Declaration {
    pub id: String,
    #[serde(default)]
    pub local: bool,
    pub full_name: String,
    pub name: String,
    pub crate_name: String,
    pub kind: String,
    pub source: Option<SourceEvidence>,
    pub docs: String,
    pub evidence_hash: String,
    #[serde(default)]
    pub unresolved_behavior: bool,
    #[serde(default)]
    pub purpose_dependencies: Vec<PurposeDependency>,
}

/// 未静态绑定的关联项依赖；身份始终指向 trait 声明成员，不是显示名称。
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeDependency {
    pub trait_id: String,
    pub member_id: String,
}

/// 本单元依赖闭包不是全构建闭包；消费方还必须校验所有实际 owning 单元的证书。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeInventory {
    pub crate_identity: String,
    pub metadata_hash: String,
    pub required_crates: Vec<String>,
    pub required_views: Vec<PurposeCrateView>,
    pub coverage: Vec<PurposeCoverage>,
    pub traits: Vec<PurposeTrait>,
    pub implementations: Vec<PurposeImplementation>,
}

/// 原生 hash 只认证 owning/导入 metadata 为同一视图，不参与便携用途散列。
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeCrateView {
    pub crate_identity: String,
    pub metadata_hash: String,
}

/// complete 证明该 crate 的 trait/impl 枚举完整；不证明某 trait 没有内建实现。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeCoverage {
    pub crate_identity: String,
    pub metadata_hash: String,
    pub complete: bool,
    pub reason: String,
    /// None 覆盖该 crate 全部 trait；Some 只覆盖列明 trait，空列表不证明任何 trait。
    pub traits: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeTrait {
    pub owner_crate: String,
    pub metadata_hash: String,
    pub trait_id: String,
    pub complete: bool,
    pub reason: String,
    pub members: Vec<PurposeMember>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeImplementation {
    pub owner_crate: String,
    pub metadata_hash: String,
    pub trait_id: String,
    pub implementation_id: String,
    pub header_hash: String,
    pub complete: bool,
    pub reason: String,
    /// 仅显式实现成员；缺项只能回到已证明 has_value 的 trait default。
    pub members: Vec<PurposeMember>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurposeMember {
    pub trait_id: String,
    pub member_id: String,
    pub implementation_member_id: Option<String>,
    /// false 明确表示没有默认体，不能与成员信息缺失混同。
    pub has_value: bool,
    pub evidence_hash: String,
    pub dependencies: Vec<PurposeDependency>,
    pub unresolved_behavior: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeInstance {
    pub id: String,
    pub declaration: Option<String>,
    pub display: String,
    pub kind: String,
    pub arguments: Vec<TypeArgument>,
    pub roles: Vec<String>,
    pub fields: Vec<TypeField>,
    pub runtime_type_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeArgument {
    pub kind: String,
    pub value: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeField {
    pub name: String,
    pub type_id: String,
    pub source: Option<SourceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Callable {
    pub id: String,
    pub declaration: String,
    #[serde(default)]
    pub body_analyzed: bool,
    pub display: String,
    pub arguments: Vec<TypeArgument>,
    pub parameters: Vec<Parameter>,
    pub output: String,
    pub runtime_type_id: Option<String>,
    pub system_type_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub slot: String,
    pub type_id: String,
    pub source: Option<SourceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessFact {
    pub owner: String,
    pub type_id: String,
    pub mode: String,
    pub storage: String,
    pub scope: String,
    pub parameter: String,
    pub source: Option<SourceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationFact {
    pub id: String,
    pub owner: String,
    pub method: String,
    pub target_type: Option<String>,
    pub kind: String,
    pub deferred: bool,
    pub scope: String,
    pub source: Option<SourceEvidence>,
    pub call_chain: Vec<SourceEvidence>,
    pub conditions: Vec<SourceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallFact {
    pub caller: String,
    pub callee: Option<String>,
    pub declaration: Option<String>,
    /// 与本条调用绑定的原生解析缺口；不能按同一函数的其他调用推断。
    #[serde(default)]
    pub unresolved_reason: Option<String>,
    pub source: Option<SourceEvidence>,
    pub deferred: bool,
    #[serde(default)]
    pub conditions: Vec<SourceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityTemplate {
    pub id: String,
    pub creator: String,
    pub source: Option<SourceEvidence>,
    pub components: Vec<String>,
    pub required_components: Vec<String>,
    pub children: Vec<String>,
    pub gaps: Vec<Gap>,
    #[serde(default)]
    pub alternatives: Vec<EntityAlternativeGroup>,
    #[serde(default)]
    pub alternative_group: Option<String>,
    #[serde(default)]
    pub alternative_selection: Option<String>,
    #[serde(default)]
    pub alternative_context: Vec<String>,
    #[serde(default)]
    pub possible: bool,
    #[serde(default)]
    pub source_evidence: Vec<SourceEvidence>,
    #[serde(default)]
    pub name_candidates: Vec<EntityNameCandidate>,
}

/// 同一创建模板的可达名称；表达式来自编译器确认的 Name 赋值位置。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityNameCandidate {
    pub value: Option<String>,
    pub expression: Option<SourceEvidence>,
    pub reason: Option<String>,
}

/// 同一实体模板的结构候选，不表示额外子实体或同时存在的结构。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityAlternativeGroup {
    pub id: String,
    pub candidates: Vec<String>,
    pub source: Option<SourceEvidence>,
    /// one-of 来自单次协议调用的分支；unresolved 不推断互斥或同时存在。
    pub selection: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationFact {
    pub owner: String,
    pub kind: String,
    pub target: Option<String>,
    pub type_id: Option<String>,
    pub source: Option<SourceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Gap {
    pub owner: String,
    pub kind: String,
    pub reason: String,
    pub source: Option<SourceEvidence>,
}
