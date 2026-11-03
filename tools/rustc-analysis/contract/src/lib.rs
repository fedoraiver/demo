//! 可持久化分析契约；不引用编译器会话或内部库。
pub mod entity_names;
pub mod facts;
pub mod named_fields;
pub mod runtime;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};

/// 编译器每次回调只执行请求中的一种分析。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Rule {
    NamedFields,
    EntityNames,
    Architecture,
}

/// 指定编译单元、配置和输出目录，不把环境状态隐式当作分析输入。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    pub run: String,
    pub configuration: String,
    pub compiler: String,
    pub workspace: String,
    pub rule: Rule,
    pub sources: BTreeSet<String>,
    pub manifest_dirs: BTreeSet<String>,
    #[serde(default)]
    pub package_origins: Vec<PackageOrigin>,
}

/// 包的精确 Cargo 来源与目标源码；路径只负责绑定，不参与可持久化定义身份。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageOrigin {
    pub root: String,
    pub identity: String,
    pub targets: Vec<PackageTargetOrigin>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageTargetOrigin {
    pub source: String,
    pub name: String,
    pub kind: Vec<String>,
}

/// 一个编译单元的结果；错误和缺失报告不能被空结果伪装为成功。
#[derive(Debug, Serialize, Deserialize)]
pub struct UnitReport {
    pub run: String,
    pub configuration: String,
    pub compiler: String,
    pub target: named_fields::Target,
    pub manifest_dir: String,
    pub package: String,
    pub artifact_tag: String,
    pub crate_types: Vec<String>,
    pub findings: Vec<named_fields::Finding>,
    pub entities: entity_names::Report,
    pub facts: Option<facts::UnitFacts>,
    pub failure: Option<String>,
}

/// 统一 Windows 扩展路径和其他平台的真实源码路径。
pub fn normalized(path: &Path) -> std::io::Result<String> {
    Ok(path
        .canonicalize()?
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/"))
}
