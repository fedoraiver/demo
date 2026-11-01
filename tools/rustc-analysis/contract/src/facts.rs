//! 编译器会话之外使用的声明、类型、调用与证据；不保存 rustc 的借用或数字索引。
use serde::{Deserialize, Serialize};

pub const FACT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitFacts {
    pub schema_version: u32,
    pub crate_name: String,
    pub crate_identity: String,
    pub source_files: Vec<SourceFile>,
    pub declarations: Vec<Declaration>,
    pub types: Vec<TypeInstance>,
    pub callables: Vec<Callable>,
    pub accesses: Vec<AccessFact>,
    pub operations: Vec<OperationFact>,
    pub calls: Vec<CallFact>,
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
