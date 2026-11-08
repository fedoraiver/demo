//! 可持久化分析契约；不引用编译器会话或内部库。
pub mod entity_names;
pub mod facts;
pub mod named_fields;
pub mod runtime;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};

/// 请求与报告的版本；旧版缺少通用输入证据，不能参与跨运行复用。
pub const ANALYSIS_SCHEMA_VERSION: u32 = 3;

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
    pub schema_version: u32,
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
    pub schema_version: u32,
    pub rule: Rule,
    /// false 只证明编译输入，不声明该单元通过任何规则检查。
    #[serde(default)]
    pub analyzed: bool,
    pub run: String,
    pub configuration: String,
    pub compiler: String,
    pub target: named_fields::Target,
    pub manifest_dir: String,
    pub package: String,
    pub artifact_tag: String,
    pub crate_types: Vec<String>,
    pub inputs: UnitInputs,
    pub findings: Vec<named_fields::Finding>,
    pub entities: entity_names::Report,
    pub facts: Option<facts::UnitFacts>,
    pub failure: Option<String>,
}

/// 三种分析共用的原生编译输入；不依赖 Architecture 的事实载荷。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UnitInputs {
    pub files: Vec<InputFile>,
    pub aliases: Vec<InputAlias>,
    pub probes: Vec<InputProbe>,
    pub env: Vec<InputEnv>,
    pub externs: Vec<ExternInput>,
    pub binary_paths: Vec<String>,
    pub dep_info: Option<InputFile>,
    pub outputs: Vec<String>,
    pub cfg: Vec<(String, Option<String>)>,
    pub target: String,
    pub rustc_options_hash: String,
    pub incremental: bool,
    pub complete: bool,
    pub gaps: Vec<String>,
}

/// 已读取文件的真实内容；二进制依赖另由 Host 在单轮内去重计算摘要。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputFile {
    pub path: String,
    pub sha256: String,
}

/// 保留逻辑读取路径与实际目标的绑定，避免链接改指后旧目标仍可读取。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputAlias {
    pub path: String,
    pub resolved: String,
}

/// 编译器实际探测过的路径存在性，包含模块查找中的负依赖。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputProbe {
    pub path: String,
    pub exists: bool,
}

/// 环境值只保存摘要；None 表示编译器实际观察到该变量未设置。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputEnv {
    pub name: String,
    pub value_sha256: Option<String>,
}

/// 原生 extern 参数与实际来源，不从 crate 短名猜测 Cargo 包身份。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternInput {
    pub name: String,
    pub paths: Vec<String>,
    pub private: bool,
    pub add_prelude: bool,
    pub nounused: bool,
    pub force: bool,
    pub search_path: bool,
}

/// 统一 Windows 扩展路径和其他平台的真实源码路径。
pub fn normalized(path: &Path) -> std::io::Result<String> {
    Ok(path
        .canonicalize()?
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/"))
}
