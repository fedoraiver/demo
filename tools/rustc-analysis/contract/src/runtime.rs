//! 真实 Bevy 装配快照；类型哈希仅连接同次构建，不作为跨版本对象身份。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSnapshot {
    pub schema_version: u32,
    pub source_fingerprint: String,
    pub target: String,
    pub features: Vec<String>,
    pub schedules: Vec<RuntimeSchedule>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSchedule {
    pub id: String,
    pub app: String,
    pub label: String,
    pub type_id: String,
    pub dot_filename: String,
    pub dot_sha256: String,
    pub systems: Vec<RuntimeSystem>,
    pub sets: Vec<RuntimeSet>,
    pub hierarchy: Vec<RuntimeEdge>,
    pub dependencies: Vec<RuntimeEdge>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSystem {
    pub key: String,
    pub graph_name: String,
    pub name: String,
    pub type_id: String,
    pub conditions: Vec<RuntimeCondition>,
    pub accesses: Vec<RuntimeAccess>,
    pub access_scope: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCondition {
    pub name: String,
    pub type_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAccess {
    pub type_id: Option<String>,
    pub name: String,
    pub mode: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSet {
    pub key: String,
    pub graph_name: String,
    pub label: String,
    pub type_id: String,
    pub system_type: Option<String>,
    #[serde(default)]
    pub anonymous: bool,
    pub conditions: Vec<RuntimeCondition>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEdge {
    pub from: String,
    pub to: String,
}
