//! 以编译器事实和真实注册快照装配语义图；展示代码不再解析 Rust。
use analysis_contract::{facts::*, runtime::*};
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    schema_version: u32,
    compiler: String,
    configuration: Value,
    workspace: String,
    packages: Vec<Value>,
    #[serde(default)]
    source_origins: Vec<Value>,
    units: Vec<UnitFacts>,
    runtime_sha256: String,
}

struct Model {
    root: PathBuf,
    source_cache: SourceCache,
    declarations: BTreeMap<String, Declaration>,
    annotation_keys: BTreeMap<String, String>,
    types: BTreeMap<String, TypeInstance>,
    callables: BTreeMap<String, Callable>,
    declaration_callables: BTreeMap<String, Vec<String>>,
    runtime_callables: BTreeMap<String, BTreeSet<String>>,
    runtime_types: BTreeMap<String, Vec<String>>,
    call_edges: BTreeMap<String, BTreeSet<String>>,
    body_proofs: BTreeMap<String, BTreeSet<PurposeCrateView>>,
    unproven_calls: BTreeMap<String, Vec<UnprovenCall>>,
    purpose_work_gaps: BTreeMap<String, BTreeSet<String>>,
    behavior_hashes: BTreeMap<String, String>,
    behavior_context: Option<String>,
    purpose_inventories: Vec<PurposeInventory>,
    purpose_dependencies: BTreeMap<PurposeDependency, std::result::Result<String, String>>,
    purpose_certified: usize,
    purpose_fallback: usize,
    purpose_fallbacks: BTreeMap<String, Value>,
    annotation_hits: BTreeSet<String>,
    objects: BTreeMap<String, Value>,
    relations: BTreeMap<String, Value>,
    features: BTreeMap<String, Value>,
    pending: BTreeMap<String, Value>,
    rejected_types: BTreeMap<String, Value>,
    annotations: Value,
    fatal: Vec<String>,
}

#[derive(Clone)]
struct UnprovenCall {
    declaration: Option<String>,
    reason: String,
    allow_purpose_dependency: bool,
}

fn parameter_relation_evidence(
    access: &AccessFact,
    owner: &str,
    direct_root: bool,
    sources: &[Value],
) -> Value {
    json!({"evidence":"parameter","parameterAccesses":[{
        "callableId":access.owner,"registeredOwner":owner,"directRoot":direct_root,
        "parameter":access.parameter,"scope":access.scope,"storage":access.storage,"typeInstanceId":access.type_id,
        "sourceEntries":sources
    }]})
}

fn finish_parameter_relations(relations: &mut BTreeMap<String, Value>) {
    fn ordered_unique(values: Vec<Value>) -> Vec<Value> {
        values
            .into_iter()
            .map(|value| (serde_json::to_string(&value).unwrap(), value))
            .collect::<BTreeMap<_, _>>()
            .into_values()
            .collect()
    }
    for relation in relations.values_mut() {
        let Some(mut accesses) = relation["parameterAccesses"].as_array().cloned() else {
            continue;
        };
        for access in &mut accesses {
            let sources = access["sourceEntries"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            access["sourceEntries"] = json!(ordered_unique(sources));
        }
        let accesses = ordered_unique(accesses);
        // helper 的 current 是相对于其原生参数，未证明其接收的 World 来自入口。
        // 不把多个原生观测折成一个由到达顺序决定的入口 scope/parameter。
        let direct =
            !accesses.is_empty() && accesses.iter().all(|access| access["directRoot"] == true);
        let local = accesses.iter().all(|access| access["storage"] == "Local");
        for field in ["scope", "parameter"] {
            let values: BTreeSet<_> = accesses
                .iter()
                .filter_map(|access| access[field].as_str())
                .collect();
            let scalar = if direct && field == "scope" && local {
                Some("local")
            } else if direct && values.len() == 1 && !local {
                Some(*values.first().unwrap())
            } else {
                None
            };
            if let Some(value) = scalar {
                relation[field] = json!(value);
            } else {
                relation.as_object_mut().unwrap().remove(field);
            }
        }
        relation["parameterAccesses"] = json!(accesses);
        let sources = relation["sourceEntries"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        relation["sourceEntries"] = json!(ordered_unique(sources));
    }
}

fn finish_feature_overviews(
    features: &mut BTreeMap<String, Value>,
    objects: &BTreeMap<String, Value>,
) {
    // BTreeMap 按真实对象 ID 选择代表；显式配置的入口或标签不由自动推导覆盖。
    for (id, object) in objects {
        if !matches!(object["kind"].as_str(), Some("Plugin" | "PluginGroup")) {
            continue;
        }
        let feature = object["feature"].as_str().expect("Plugin has a feature");
        let entry = features.get_mut(feature).expect("Feature was inserted");
        if entry.get("overviewNode").is_none()
            && entry.get("plugin").is_none_or(|value| value == feature)
        {
            let name = object["name"].as_str().expect("Plugin has a name");
            entry["plugin"] = json!(name.rsplit("::").next().unwrap_or(name));
            entry["overviewNode"] = json!(id);
        }
    }
}

struct SourceRoot {
    root: PathBuf,
    dependency: Value,
}

// 精确 trait 身份和每个实际 crate 的覆盖证据共同决定是否可以缩小用途失效范围。
fn purpose_dependency_proof(
    inventories: &[PurposeInventory],
    root: &PurposeDependency,
) -> std::result::Result<String, String> {
    if inventories.is_empty() {
        return Err("missing-inventory: 没有实际编译单元的用途覆盖证书".into());
    }
    if inventories
        .iter()
        .any(|unit| unit.crate_identity.is_empty() || unit.metadata_hash.is_empty())
    {
        return Err("missing-view: 编译单元缺少精确 crate 身份或实际 metadata 视图".into());
    }
    let mut required = BTreeSet::new();
    for unit in inventories {
        let own = PurposeCrateView {
            crate_identity: unit.crate_identity.clone(),
            metadata_hash: unit.metadata_hash.clone(),
        };
        if !unit.required_views.contains(&own)
            || unit.required_crates.iter().any(|id| {
                !unit
                    .required_views
                    .iter()
                    .any(|view| &view.crate_identity == id)
            })
        {
            return Err(format!(
                "missing-view: {} 没有列全自身或依赖的实际 metadata 视图",
                unit.crate_identity
            ));
        }
        if unit.coverage.iter().any(|coverage| {
            !unit.required_views.contains(&PurposeCrateView {
                crate_identity: coverage.crate_identity.clone(),
                metadata_hash: coverage.metadata_hash.clone(),
            })
        }) {
            return Err(format!(
                "unbound-certificate: {} 的覆盖证书不属于该报告实际加载的视图",
                unit.crate_identity
            ));
        }
        for view in &unit.required_views {
            if view.crate_identity.is_empty() || view.metadata_hash.is_empty() {
                return Err("missing-view: 依赖视图的 crate 身份或 metadata hash 为空".into());
            }
            required.insert(view.clone());
        }
    }
    let mut pending = vec![root.clone()];
    let mut seen = BTreeSet::new();
    let mut evidence = BTreeMap::new();
    while let Some(dependency) = pending.pop() {
        if dependency.trait_id.is_empty() || dependency.member_id.is_empty() {
            return Err("unknown-member: 关联引用没有确切 trait 或成员身份".into());
        }
        if !seen.insert(dependency.clone()) {
            continue;
        }
        let covers = |coverage: &PurposeCoverage| {
            coverage
                .traits
                .as_ref()
                .is_none_or(|traits| traits.contains(&dependency.trait_id))
        };
        // 一条实际记录不能被另一个报告的空清单掩盖；每条记录都须由本报告对应视图证书覆盖。
        for inventory in inventories {
            for (owner, metadata) in inventory
                .traits
                .iter()
                .filter(|row| row.trait_id == dependency.trait_id)
                .map(|row| (&row.owner_crate, &row.metadata_hash))
                .chain(
                    inventory
                        .implementations
                        .iter()
                        .filter(|row| row.trait_id == dependency.trait_id)
                        .map(|row| (&row.owner_crate, &row.metadata_hash)),
                )
            {
                let view = PurposeCrateView {
                    crate_identity: owner.clone(),
                    metadata_hash: metadata.clone(),
                };
                if !inventory.required_views.contains(&view)
                    || !inventory.coverage.iter().any(|c| {
                        c.crate_identity == *owner
                            && c.metadata_hash == *metadata
                            && c.complete
                            && covers(c)
                    })
                {
                    return Err(format!(
                        "unbound-member: trait {} 的成员或实现没有本报告对应视图的完整证书",
                        dependency.trait_id
                    ));
                }
            }
        }
        let mut views_by_crate = BTreeMap::new();
        for view in &required {
            let mut certified = None;
            for inventory in inventories {
                for certificate in inventory.coverage.iter().filter(|c| {
                    c.crate_identity == view.crate_identity
                        && c.metadata_hash == view.metadata_hash
                        && covers(c)
                }) {
                    if !certificate.complete {
                        return Err(format!(
                            "incomplete-certificate: {} / {}：{}",
                            view.crate_identity, dependency.trait_id, certificate.reason
                        ));
                    }
                    let mut traits = BTreeMap::new();
                    let mut implementations = BTreeMap::new();
                    for row in inventory.traits.iter().filter(|row| {
                        row.owner_crate == view.crate_identity
                            && row.metadata_hash == view.metadata_hash
                            && row.trait_id == dependency.trait_id
                    }) {
                        if !row.complete {
                            return Err(format!(
                                "unsupported-trait: {}：{}",
                                row.trait_id, row.reason
                            ));
                        }
                        let mut row = row.clone();
                        row.metadata_hash.clear();
                        row.reason.clear();
                        for member in &mut row.members {
                            member.dependencies.sort();
                            member.dependencies.dedup();
                        }
                        row.members.sort_by(|a, b| a.member_id.cmp(&b.member_id));
                        if traits.insert(row.trait_id.clone(), row).is_some() {
                            return Err(format!(
                                "conflicting-trait: {} 在同一完整视图内重复声明",
                                dependency.trait_id
                            ));
                        }
                    }
                    for row in inventory.implementations.iter().filter(|row| {
                        row.owner_crate == view.crate_identity
                            && row.metadata_hash == view.metadata_hash
                            && row.trait_id == dependency.trait_id
                    }) {
                        if !row.complete {
                            return Err(format!(
                                "incomplete-implementation: {}：{}",
                                row.implementation_id, row.reason
                            ));
                        }
                        let mut row = row.clone();
                        row.metadata_hash.clear();
                        row.reason.clear();
                        for member in &mut row.members {
                            member.dependencies.sort();
                            member.dependencies.dedup();
                        }
                        row.members.sort_by(|a, b| a.member_id.cmp(&b.member_id));
                        if row.implementation_id.is_empty() || row.header_hash.is_empty() {
                            return Err(format!(
                                "incomplete-implementation: trait {} 的实现身份或约束证据缺失",
                                dependency.trait_id
                            ));
                        }
                        if implementations
                            .insert(row.implementation_id.clone(), row)
                            .is_some()
                        {
                            return Err(format!(
                                "conflicting-implementation-set: {} 的同一完整视图出现重复 impl",
                                dependency.trait_id
                            ));
                        }
                    }
                    let content = (traits, implementations);
                    if certified.as_ref().is_some_and(|old| old != &content) {
                        return Err(format!(
                            "conflicting-implementation-set: {} / {} 的完整 trait/impl 清单不一致",
                            view.crate_identity, dependency.trait_id
                        ));
                    }
                    certified = Some(content);
                }
            }
            let content = certified.ok_or_else(|| {
                format!(
                    "missing-certificate: {} 的实际视图 {} 没有 trait {} 的完整覆盖证明",
                    view.crate_identity, view.metadata_hash, dependency.trait_id
                )
            })?;
            if views_by_crate
                .insert(view.crate_identity.clone(), content.clone())
                .is_some_and(|old| old != content)
            {
                return Err(format!(
                    "conflicting-implementation-set: {} 的不同实际视图对 trait {} 给出不同完整清单",
                    view.crate_identity, dependency.trait_id
                ));
            }
        }
        let mut trait_definition: Option<PurposeTrait> = None;
        let mut implementations = BTreeMap::<String, PurposeImplementation>::new();
        for (traits, rows) in views_by_crate.values() {
            for definition in traits.values() {
                if trait_definition
                    .as_ref()
                    .is_some_and(|old| old != definition)
                {
                    return Err(format!(
                        "conflicting-trait: {} 的定义证据不一致",
                        dependency.trait_id
                    ));
                }
                trait_definition = Some(definition.clone());
            }
            for (id, implementation) in rows {
                if implementations
                    .insert(id.clone(), implementation.clone())
                    .is_some_and(|old| old != *implementation)
                {
                    return Err(format!(
                        "conflicting-implementation-set: impl {id} 在不同来源中的证据不一致"
                    ));
                }
            }
        }
        let definition = trait_definition.ok_or_else(|| {
            format!(
                "missing-trait: trait {} 的完整声明与默认成员证据缺失",
                dependency.trait_id
            )
        })?;
        let mut defaults = BTreeMap::new();
        for member in &definition.members {
            if member.unresolved_behavior {
                return Err(format!(
                    "default-helper: trait 默认成员 {} 的初始化体或 helper 行为证据不完整",
                    member.member_id
                ));
            }
            if member.trait_id != dependency.trait_id
                || member.member_id.is_empty()
                || member.implementation_member_id.is_some()
                || member.evidence_hash.is_empty()
                || defaults.insert(member.member_id.clone(), member).is_some()
            {
                return Err(format!(
                    "incomplete-default: trait {} 的默认成员身份、签名或唯一性证据缺失",
                    dependency.trait_id
                ));
            }
            pending.extend(member.dependencies.iter().cloned());
        }
        if !defaults.contains_key(&dependency.member_id) {
            return Err(format!(
                "unknown-member: trait {} 不含引用的确切成员 {}",
                dependency.trait_id, dependency.member_id
            ));
        }
        for implementation in implementations.values() {
            let mut members = BTreeMap::new();
            for member in &implementation.members {
                if member.unresolved_behavior {
                    return Err(format!(
                        "implementation-helper: impl {} 的成员 {} 初始化体或 helper 行为证据不完整",
                        implementation.implementation_id, member.member_id
                    ));
                }
                if member.trait_id != dependency.trait_id
                    || !defaults.contains_key(&member.member_id)
                    || member
                        .implementation_member_id
                        .as_deref()
                        .is_none_or(str::is_empty)
                    || !member.has_value
                    || member.evidence_hash.is_empty()
                    || members.insert(member.member_id.clone(), member).is_some()
                {
                    return Err(format!(
                        "incomplete-member: impl {} 的成员映射、值或唯一性证据缺失",
                        implementation.implementation_id
                    ));
                }
                pending.extend(member.dependencies.iter().cloned());
            }
            if let Some((id, _)) = defaults
                .iter()
                .find(|(id, default)| !members.contains_key(*id) && !default.has_value)
            {
                return Err(format!(
                    "missing-default: impl {} 缺少必需成员 {id}，trait 也没有默认体",
                    implementation.implementation_id
                ));
            }
        }
        evidence.insert(dependency, (definition, implementations));
    }
    Ok(digest(
        serde_json::to_vec(&(
            "purpose-trait-universe-v1",
            evidence.into_iter().collect::<Vec<_>>(),
        ))
        .map_err(|error| format!("invalid-purpose-evidence: {error}"))?,
    ))
}

#[cfg(test)]
fn purpose_dependency_hash(
    inventories: &[PurposeInventory],
    root: &PurposeDependency,
) -> Option<String> {
    purpose_dependency_proof(inventories, root).ok()
}

struct ResolvedSource {
    relative: String,
    key: String,
    dependency: Option<Value>,
    raw_hash: String,
    lf_hash: String,
}

impl ResolvedSource {
    fn accepts_hash(&self, hash: &str) -> bool {
        hash.is_empty() || hash == self.raw_hash || hash == self.lf_hash
    }
}

struct SourceCache {
    workspace: PathBuf,
    packages: Vec<SourceRoot>,
    compiler_origins: Vec<SourceRoot>,
    filenames: BTreeMap<String, std::result::Result<PathBuf, String>>,
    files: BTreeMap<PathBuf, ResolvedSource>,
    snapshots: BTreeMap<String, Value>,
}

impl SourceCache {
    fn new(workspace: PathBuf, packages: Vec<Value>, origins: Vec<Value>) -> Self {
        // 同深度时保留原来 max_by_key 的末项优先规则，之后按最长目录前缀匹配。
        let mut packages: Vec<_> = packages.iter().rev().filter_map(|package| {
            let manifest = Path::new(package["manifest_path"].as_str()?);
            let root = manifest.parent()?.canonicalize().ok()?;
            let dependency = json!({"name":package["name"],"version":package["version"],"root":root.to_string_lossy().replace('\\',"/")});
            Some(SourceRoot {root, dependency})
        }).collect();
        packages.sort_by_key(|package| std::cmp::Reverse(package.root.components().count()));
        let compiler_origins = origins
            .into_iter()
            .filter_map(|mut origin| {
                let root = Path::new(origin["root"].as_str()?).canonicalize().ok()?;
                origin["root"] = json!(root.to_string_lossy().replace('\\', "/"));
                Some(SourceRoot {
                    root,
                    dependency: origin,
                })
            })
            .collect();
        Self {
            workspace,
            packages,
            compiler_origins,
            filenames: BTreeMap::new(),
            files: BTreeMap::new(),
            snapshots: BTreeMap::new(),
        }
    }

    fn resolve(&mut self, filename: &str) -> std::result::Result<&ResolvedSource, String> {
        if !self.filenames.contains_key(filename) {
            let result = self.load(filename);
            self.filenames.insert(filename.to_owned(), result);
        }
        match self
            .filenames
            .get(filename)
            .expect("Resolved input filename")
        {
            Ok(path) => Ok(self.files.get(path).expect("Resolved source file")),
            Err(error) => Err(error.clone()),
        }
    }

    fn load(&mut self, filename: &str) -> std::result::Result<PathBuf, String> {
        let absolute = Path::new(filename)
            .canonicalize()
            .map_err(|_| format!("Compiler source is unavailable: {filename}"))?;
        if self.files.contains_key(&absolute) {
            return Ok(absolute);
        }
        let (relative, dependency, key) =
            if let Ok(relative) = absolute.strip_prefix(&self.workspace) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                (relative.clone(), None, relative)
            } else {
                let located =
                    self.packages
                        .iter()
                        .chain(&self.compiler_origins)
                        .find_map(|origin| {
                            let relative = absolute
                                .strip_prefix(&origin.root)
                                .ok()?
                                .to_string_lossy()
                                .replace('\\', "/");
                            Some((relative, origin.dependency.clone()))
                        });
                let (relative, dependency) = located.ok_or_else(|| {
                    format!("Compiler source has no package or compiler origin: {filename}")
                })?;
                let key = format!(
                    "cargo/{}-{}/{}",
                    dependency["name"].as_str().unwrap_or("unknown"),
                    dependency["version"].as_str().unwrap_or("unknown"),
                    relative
                );
                (relative, Some(dependency), key)
            };
        let content = fs::read_to_string(&absolute)
            .map_err(|_| format!("Compiler source is unreadable: {filename}"))?;
        let raw_hash = digest(content.as_bytes());
        let lf_hash = if content.contains("\r\n") {
            digest(content.replace("\r\n", "\n"))
        } else {
            raw_hash.clone()
        };
        let resolved = ResolvedSource {
            relative,
            key,
            dependency,
            raw_hash,
            lf_hash,
        };
        let mut snapshot = json!({"path":resolved.relative,"sha256":resolved.raw_hash});
        snapshot["content"] = Value::String(content);
        if let Some(dependency) = &resolved.dependency {
            snapshot["dependency"] = dependency.clone();
        }
        self.snapshots
            .entry(resolved.key.clone())
            .or_insert(snapshot);
        self.files.insert(absolute.clone(), resolved);
        Ok(absolute)
    }
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn identifier(kind: &str, value: impl serde::Serialize) -> String {
    format!(
        "{kind}-{}",
        &digest(serde_json::to_vec(&value).expect("Serializable identity"))[..24]
    )
}

fn entity_purpose_hash(entity: &EntityTemplate, creator_behavior: &str) -> String {
    let components: BTreeSet<_> = entity.components.iter().collect();
    let required: BTreeSet<_> = entity.required_components.iter().collect();
    let gaps: BTreeSet<_> = entity
        .gaps
        .iter()
        .map(|gap| (&gap.kind, &gap.reason))
        .collect();
    let alternatives: Vec<_> = entity.alternatives.iter().map(|group| {
        json!({"id":group.id,"candidates":group.candidates,"selection":group.selection})
    }).collect();
    // 完整文件 SHA 继续约束源码快照；用途只依赖装配结构与创建函数/可达 helper 行为。
    // 行列、宏调用位置和展示片段不能使初始化语义未变的模板用途失效。
    digest(serde_json::to_vec(&json!({"version":"entity-purpose-v2","creatorBehavior":creator_behavior,
        "creator":entity.creator,"components":components,"requiredComponents":required,"children":entity.children,
        "gaps":gaps,"alternatives":alternatives,"alternativeGroup":entity.alternative_group,
        "alternativeSelection":entity.alternative_selection,"alternativeContext":entity.alternative_context,"possible":entity.possible})).expect("Entity semantic evidence"))
}
fn unique(values: Vec<Value>) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_string()))
        .collect()
}

fn aggregate_gaps(values: Vec<Value>) -> Vec<Value> {
    let mut grouped = BTreeMap::<String, (Value, BTreeSet<String>)>::new();
    for mut value in values {
        let unit = value.as_object_mut().and_then(|value| value.remove("unit"));
        let units = unit.and_then(|unit| unit.as_str().map(str::to_owned));
        let entry = grouped
            .entry(value.to_string())
            .or_insert_with(|| (value, BTreeSet::new()));
        entry.1.extend(units);
    }
    grouped
        .into_values()
        .map(|(mut value, units)| {
            value["unit"] = json!(units.first());
            value["units"] = json!(units);
            value
        })
        .collect()
}

fn access_proof(access: &AccessFact, sources: &[Value]) -> Value {
    let mut fact = json!(access);
    if let Some(source) = &access.source {
        // 嵌套事实也使用包相对路径；保留完整原生 Span 与预览，沿用统一来源校验。
        let mut normalized = sources.first().cloned().unwrap_or(Value::Null);
        if normalized.is_object() {
            normalized["endLine"] = json!(source.end_line);
            normalized["endColumn"] = json!(source.end_column);
            normalized["snippet"] = json!(source.snippet);
        }
        fact["source"] = normalized;
    }
    fact
}

type CreationSite = (String, String, String, usize, usize);

fn creation_site(creator: &str, source: &SourceEvidence) -> CreationSite {
    (
        creator.to_owned(),
        source.path.clone(),
        source.sha256.clone(),
        source.end_line,
        source.end_column,
    )
}

fn creation_templates(entities: &[EntityTemplate]) -> BTreeMap<CreationSite, Vec<&EntityTemplate>> {
    let children: BTreeSet<_> = entities
        .iter()
        .flat_map(|entity| {
            entity.children.iter().chain(
                entity
                    .alternatives
                    .iter()
                    .flat_map(|group| &group.candidates),
            )
        })
        .collect();
    let mut sites = BTreeMap::<_, Vec<_>>::new();
    for entity in entities {
        if children.contains(&entity.id) {
            continue;
        }
        if let Some(source) = &entity.source {
            sites
                .entry(creation_site(&entity.creator, source))
                .or_default()
                .push(entity);
        }
    }
    sites
}

fn creation_target(
    operation: &OperationFact,
    sites: &BTreeMap<CreationSite, Vec<&EntityTemplate>>,
) -> Option<String> {
    if operation.kind != "create" {
        return None;
    }
    let source = operation.source.as_ref()?;
    if source.sha256.is_empty() || source.end_line == 0 || source.end_column == 0 {
        return None;
    }
    // HIR 包含接收者，MIR fn_span 从方法名开始；只连接同一调用结尾的唯一模板。
    let candidates: BTreeSet<_> = sites
        .get(&creation_site(&operation.owner, source))?
        .iter()
        .filter(|entity| {
            let candidate = entity.source.as_ref().expect("Indexed creation source");
            (source.line, source.column) <= (candidate.line, candidate.column)
                && (candidate.line, candidate.column) <= (source.end_line, source.end_column)
                && candidate.expansions == source.expansions
        })
        .map(|entity| &entity.id)
        .collect();
    (candidates.len() == 1)
        .then(|| identifier("entity", candidates.first().expect("Single template")))
}

impl Model {
    fn purpose_key(&self, declaration: &Declaration) -> String {
        self.annotation_keys
            .get(&declaration.id)
            .cloned()
            .unwrap_or_else(|| declaration.full_name.clone())
    }
    fn guard_sources(&mut self, guards: &[SourceEvidence]) -> Vec<Value> {
        guards
            .iter()
            .flat_map(|source| {
                let mut entries = self.source(&Some(source.clone()), "operation");
                for entry in &mut entries {
                    entry["expression"] = json!(source.snippet);
                    entry["guardKind"] = json!(source.role);
                }
                entries
            })
            .collect()
    }

    fn bind_conditions(
        &mut self,
        conditions: &[RuntimeCondition],
        schedule: &RuntimeSchedule,
        native_key: &str,
        targets: &[String],
        scope: &str,
    ) -> Vec<(String, Vec<String>)> {
        let mut roots = vec![];
        for (index, condition) in conditions.iter().enumerate() {
            let id = identifier(
                "condition",
                (&schedule.app, &schedule.id, native_key, index),
            );
            let candidates = self.callable_for_runtime(&condition.type_id);
            if candidates.is_empty() {
                self.fatal.push(format!(
                    "No compiler instance for runtime condition {} / {} / {} / {} ({})",
                    schedule.app, schedule.label, native_key, index, condition.type_id
                ));
            }
            let mut sources = vec![];
            let mut descriptions = vec![];
            let mut summaries = vec![];
            let mut features = BTreeSet::new();
            for candidate in &candidates {
                let Some(declaration) = self
                    .callables
                    .get(candidate)
                    .and_then(|callable| self.declarations.get(&callable.declaration))
                    .cloned()
                else {
                    continue;
                };
                let proof = self.source(&declaration.source, "definition");
                let hash = self.behavior_hash(&declaration);
                let (description, summary) = self.purpose(
                    &self.purpose_key(&declaration),
                    &condition.name,
                    "System",
                    &hash,
                    &declaration.docs,
                    &proof,
                );
                sources.extend(proof);
                descriptions.push(description);
                summaries.push(summary);
                features.insert(self.feature(Some(&declaration)));
            }
            let feature = features
                .into_iter()
                .next()
                .unwrap_or_else(|| "application".into());
            let kind = if candidates.len() > 1 {
                "System group"
            } else {
                "System"
            };
            self.objects.insert(id.clone(),json!({"id":id,"name":condition.name,"kind":kind,"feature":feature,"description":descriptions.join("\n"),"display_summary":summaries.join("；"),"sourceEntries":unique(sources),"sourceGaps":[],"runtimeTypeId":condition.type_id,"callableIds":candidates,"registrationScope":scope,"registrations":[{"application":schedule.app,"schedule":schedule.label,"scope":scope}]}));
            for target in targets {
                self.link(
                    &id,
                    target,
                    "condition",
                    "运行条件",
                    vec![],
                    json!({"evidence":"runtime","scope":scope}),
                );
            }
            roots.push((id, candidates));
        }
        roots
    }

    fn behavior_hash(&mut self, declaration: &Declaration) -> String {
        if let Some(hash) = self.behavior_hashes.get(&declaration.id) {
            return hash.clone();
        }
        let mut pending = self
            .declaration_callables
            .get(&declaration.id)
            .cloned()
            .unwrap_or_default();
        let mut seen = BTreeSet::new();
        let mut definitions =
            BTreeMap::from([(declaration.id.clone(), declaration.evidence_hash.clone())]);
        let mut unresolved = declaration.unresolved_behavior;
        let mut fallback_reasons = BTreeSet::new();
        if !pending.is_empty()
            && !pending
                .iter()
                .any(|callable| self.body_proofs.contains_key(callable))
        {
            unresolved = true;
            fallback_reasons.insert(format!(
                "missing-body-proof: {} 没有与实际 owning 视图绑定的 HIR 函数体覆盖证明",
                declaration.full_name
            ));
        }
        if declaration.unresolved_behavior {
            fallback_reasons.insert(
                "compiler-unresolved: 编译器未证明声明中的动态分派、初始化体或 helper 行为完整"
                    .to_owned(),
            );
            fallback_reasons.extend(
                self.purpose_work_gaps
                    .get(&declaration.id)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
        let mut dependencies: BTreeSet<_> =
            declaration.purpose_dependencies.iter().cloned().collect();
        while let Some(callable) = pending.pop() {
            if !seen.insert(callable.clone()) {
                continue;
            }
            let mut direct_dependencies = vec![];
            if let Some(definition) = self
                .callables
                .get(&callable)
                .and_then(|callable| self.declarations.get(&callable.declaration))
            {
                unresolved |= definition.unresolved_behavior;
                if definition.unresolved_behavior {
                    fallback_reasons.extend(
                        self.purpose_work_gaps
                            .get(&definition.id)
                            .into_iter()
                            .flatten()
                            .cloned(),
                    );
                }
                if definition.unresolved_behavior && definition.id != declaration.id {
                    fallback_reasons.insert(format!(
                        "compiler-helper: 可达 helper {} 的动态分派或初始化行为尚未证明完整",
                        definition.full_name
                    ));
                }
                dependencies.extend(definition.purpose_dependencies.iter().cloned());
                direct_dependencies = definition.purpose_dependencies.clone();
                definitions.insert(definition.id.clone(), definition.evidence_hash.clone());
            }
            for call in self
                .unproven_calls
                .get(&callable)
                .cloned()
                .unwrap_or_default()
            {
                let mut certified = false;
                if call.allow_purpose_dependency
                    && let Some(target) = &call.declaration
                {
                    for dependency in direct_dependencies
                        .iter()
                        .filter(|dependency| &dependency.member_id == target)
                    {
                        if !self.purpose_dependencies.contains_key(dependency) {
                            self.purpose_dependencies.insert(
                                dependency.clone(),
                                purpose_dependency_proof(&self.purpose_inventories, dependency),
                            );
                        }
                        certified |= self
                            .purpose_dependencies
                            .get(dependency)
                            .is_some_and(std::result::Result::is_ok);
                    }
                }
                if !certified {
                    unresolved = true;
                    fallback_reasons.insert(call.reason);
                }
            }
            if let Some(callees) = self.call_edges.get(&callable) {
                pending.extend(callees.iter().cloned());
            }
        }
        let had_dependencies = !dependencies.is_empty();
        let mut dispatch = Vec::new();
        for dependency in dependencies {
            if !self.purpose_dependencies.contains_key(&dependency) {
                let value = purpose_dependency_proof(&self.purpose_inventories, &dependency);
                self.purpose_dependencies.insert(dependency.clone(), value);
            }
            match self
                .purpose_dependencies
                .get(&dependency)
                .expect("Purpose dependency result was collected")
            {
                Ok(hash) => dispatch.push((dependency, hash.clone())),
                Err(reason) => {
                    unresolved = true;
                    fallback_reasons.insert(reason.clone());
                }
            }
        }
        if unresolved {
            self.purpose_fallback += 1;
            if self.behavior_context.is_none() {
                fallback_reasons.insert(
                    "missing-global-context: 保守回退所需的完整 owning 编译单元行为摘要缺失"
                        .to_owned(),
                );
            }
            self.purpose_fallbacks.insert(
                declaration.id.clone(),
                json!({
                    "declaration": declaration.id,
                    "name": declaration.full_name,
                    "reasons": fallback_reasons.into_iter().collect::<Vec<_>>()
                }),
            );
        } else if had_dependencies {
            self.purpose_certified += 1;
        }
        let hash = if unresolved {
            if self.behavior_context.is_none() {
                self.fatal.push(format!("Portable owning-unit behavior evidence is incomplete for unresolved dispatch in {}", declaration.full_name));
            }
            digest(
                serde_json::to_vec(&(
                    "unresolved-behavior-v1",
                    &definitions,
                    &self.behavior_context,
                ))
                .expect("Unresolved behavior evidence"),
            )
        } else if !dispatch.is_empty() {
            digest(
                serde_json::to_vec(&("resolved-purpose-dispatch-v1", &definitions, dispatch))
                    .expect("Purpose dispatch evidence"),
            )
        } else if definitions.len() == 1 {
            declaration.evidence_hash.clone()
        } else {
            digest(serde_json::to_vec(&definitions).expect("Declaration evidence"))
        };
        self.behavior_hashes
            .insert(declaration.id.clone(), hash.clone());
        hash
    }

    fn source(&mut self, source: &Option<SourceEvidence>, role: &str) -> Vec<Value> {
        let Some(source) = source else {
            return vec![];
        };
        let resolved = match self.source_cache.resolve(&source.path) {
            Ok(resolved) => resolved,
            Err(error) => {
                self.fatal.push(error);
                return vec![];
            }
        };
        // 文件内容按装配缓存一次；每个 Span 自己的 SHA 仍必须与缓存的原始或 LF 哈希相符。
        let changed = !resolved.accepts_hash(&source.sha256);
        let label = match role {
            "definition" => "定义位置",
            "registration" => "注册位置",
            "parameter" => "参数位置",
            "create" => "创建位置",
            "assembly" => "装配位置",
            "operation" => "操作位置",
            "call" => "调用位置",
            _ => "源码位置",
        };
        let mut entry = json!({"path":resolved.relative,"line":source.line,"column":source.column,"role":role,"label":label,"sha256":resolved.raw_hash,"expansions":source.expansions});
        if let Some(dependency) = &resolved.dependency {
            entry["dependency"] = dependency.clone();
        }
        if changed {
            self.fatal
                .push(format!("Compiler source evidence changed: {}", source.path));
        }
        vec![entry]
    }

    fn purpose(
        &mut self,
        key: &str,
        name: &str,
        kind: &str,
        evidence_hash: &str,
        docs: &str,
        sources: &[Value],
    ) -> (String, String) {
        let existing = self.annotations["items"].get(key);
        if let Some(existing) = existing {
            let valid = existing["evidenceHash"].as_str() == Some(evidence_hash);
            if valid
                && let Some(description) = existing["description"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
            {
                self.annotation_hits.insert(key.to_owned());
                return (
                    description.to_owned(),
                    existing["summary"]
                        .as_str()
                        .unwrap_or(description)
                        .to_owned(),
                );
            }
        }
        // 项目作者已有的中文文档可直接作为用途；其余由维护 Skill 阅读源码后补写。
        if docs
            .chars()
            .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
            && !docs.trim().is_empty()
        {
            let summary = docs.lines().next().unwrap_or(docs).trim().to_owned();
            return (docs.trim().to_owned(), summary);
        }
        self.pending.entry(key.to_owned()).or_insert(json!({"key":key,"name":name,"kind":kind,"evidenceHash":evidence_hash,"sourceEntries":sources,"sourceDocumentation":docs,"previousDescription":existing.and_then(|entry|entry.get("description")),"previousSummary":existing.and_then(|entry|entry.get("summary"))}));
        (String::new(), String::new())
    }

    fn feature(&mut self, declaration: Option<&Declaration>) -> String {
        let id = declaration
            .map(|declaration| {
                if declaration.crate_name == "demo" {
                    declaration
                        .full_name
                        .split("::")
                        .nth(1)
                        .unwrap_or("application")
                        .to_owned()
                } else {
                    format!("crate:{}", declaration.crate_name)
                }
            })
            .unwrap_or_else(|| "runtime".to_owned());
        self.features
            .entry(id.clone())
            .or_insert_with(|| json!({"id":id,"label":id,"plugin":id}));
        id
    }

    fn type_object(&mut self, type_id: &str) -> Option<String> {
        self.type_object_as(type_id, None)
    }

    fn type_object_as(&mut self, type_id: &str, storage: Option<&str>) -> Option<String> {
        let ty = self.types.get(type_id)?.clone();
        let kind = storage
            .filter(|kind| {
                [
                    "Component",
                    "Resource",
                    "Message",
                    "Event",
                    "EntityEvent",
                    "NonSend",
                    "SystemParam",
                    "QueryData",
                ]
                .contains(kind)
            })
            .or_else(|| {
                // Resource 继承 Component；默认展示更具体的角色，明确的参数访问角色仍优先。
                [
                    "Resource",
                    "Message",
                    "EntityEvent",
                    "Event",
                    "SystemSet",
                    "SystemParam",
                    "QueryData",
                    "Plugin",
                    "PluginGroup",
                    "Component",
                ]
                .into_iter()
                .find(|role| ty.roles.iter().any(|value| value == role))
            });
        let kind = kind?;
        if let Some(unresolved) = self.unresolved_type(type_id) {
            let id = identifier("type-gap", (type_id, kind));
            self.rejected_types.entry(id).or_insert_with(|| json!({"unit":"model","owner":type_id,"kind":"type-resolution","reason":"泛型参数、未归一化投影或类型擦除值不能作为具体 ECS 对象。","sourceEntries":[],"typeInstanceId":type_id,"attemptedKind":kind,"unresolvedType":unresolved,"type":{"kind":ty.kind,"display":ty.display,"arguments":ty.arguments}}));
            return None;
        }
        let id = identifier("type", (type_id, kind));
        if self.objects.contains_key(&id) {
            return Some(id);
        }
        let declaration = ty
            .declaration
            .as_ref()
            .and_then(|id| self.declarations.get(id))
            .cloned();
        let sources = self.source(
            &declaration
                .as_ref()
                .and_then(|declaration| declaration.source.clone()),
            "definition",
        );
        let feature = self.feature(declaration.as_ref());
        let purpose_key = declaration
            .as_ref()
            .map(|declaration| self.purpose_key(declaration))
            .unwrap_or_else(|| ty.display.clone());
        let evidence_hash = declaration
            .as_ref()
            .map(|declaration| self.behavior_hash(declaration))
            .unwrap_or_default();
        let docs = declaration
            .as_ref()
            .map(|declaration| declaration.docs.as_str())
            .unwrap_or("");
        let (description, summary) = self.purpose(
            &purpose_key,
            &ty.display,
            kind,
            &evidence_hash,
            docs,
            &sources,
        );
        let type_identity = declaration.as_ref().map(|declaration| {
            let mut identity = json!({"declarationId":declaration.id,"crateName":declaration.crate_name,
                "defPath":declaration.full_name,"local":declaration.local,"roles":ty.roles});
            if let Some(dependency) = sources.iter().find_map(|source| source.get("dependency")) {
                identity["package"] = json!({"name":dependency["name"],"version":dependency["version"]});
            }
            identity
        });
        let object = json!({"id":id,"name":ty.display,"fullName":ty.display,"rust_type":ty.display,"kind":kind,"feature":feature,
            "description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":[],"declarationId":ty.declaration,"typeInstanceId":type_id,"typeIdentity":type_identity});
        self.objects.insert(id.clone(), object);
        Some(id)
    }

    fn unresolved_type(&self, type_id: &str) -> Option<String> {
        let mut pending = vec![type_id];
        let mut seen = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            let Some(ty) = self.types.get(id) else {
                return Some(id.to_owned());
            };
            if matches!(ty.kind.as_str(), "parameter" | "projection" | "dynamic") {
                return Some(id.to_owned());
            }
            // 原生 TypeId 只对已归一化且无泛型、推断变量的具体类型生成。
            if ty.runtime_type_id.is_some() {
                continue;
            }
            if matches!(ty.kind.as_str(), "value" | "array")
                || ty.arguments.iter().any(|argument| argument.kind == "const")
            {
                return Some(id.to_owned());
            }
            pending.extend(
                ty.arguments
                    .iter()
                    .filter(|argument| argument.kind == "type")
                    .map(|argument| argument.value.as_str()),
            );
        }
        None
    }

    fn tuple_components(&self, type_id: &str) -> (BTreeSet<String>, BTreeSet<String>) {
        let mut pending = vec![type_id.to_owned()];
        let mut seen = BTreeSet::new();
        let mut components = BTreeSet::new();
        let mut unresolved = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(ty) = self.types.get(&id) else {
                unresolved.insert(id);
                continue;
            };
            if ty.roles.iter().any(|role| role == "Component")
                && self.unresolved_type(&id).is_none()
            {
                components.insert(id);
            } else if ty.kind == "tuple" {
                pending.extend(
                    ty.arguments
                        .iter()
                        .filter(|argument| argument.kind == "type")
                        .map(|argument| argument.value.clone()),
                );
            } else {
                // 自定义 Bundle 的字段布局不证明其实际组件，不能据 fields 猜测。
                unresolved.insert(id);
            }
        }
        (components, unresolved)
    }

    fn link(
        &mut self,
        from: &str,
        to: &str,
        kind: &str,
        label: &str,
        sources: Vec<Value>,
        extra: Value,
    ) {
        let label = if label == kind {
            match kind {
                "read" => "读取",
                "filter" => "存在性约束",
                "mutable_access" => "可变访问",
                "modify" => "赋值",
                "insert" => "插入",
                "remove" => "移除",
                "initialize" => "按需初始化",
                "publish" => "写入消息",
                "event" => "接收事件",
                "trigger" => "触发事件",
                "create" => "创建",
                "despawn" => "销毁",
                _ => label,
            }
        } else {
            label
        };
        if from == to {
            return;
        }
        let id = identifier("relation", (from, to, kind, label));
        let entry = self.relations.entry(id.clone()).or_insert_with(|| json!({"id":id,"from":from,"to":to,"kind":kind,"label":label,"sourceEntries":[],"sourceGaps":[]}));
        let previous = entry["sourceEntries"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        entry["sourceEntries"] = json!(unique([previous, sources].concat()));
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                if let (Some(previous), Some(values)) =
                    (entry.get(key).and_then(Value::as_array), value.as_array())
                {
                    entry[key] = json!(unique([previous.clone(), values.clone()].concat()));
                } else {
                    entry[key] = value.clone();
                }
            }
        }
    }

    fn callable_for_runtime(&self, runtime_type: &str) -> Vec<String> {
        let mut found = self
            .runtime_callables
            .get(runtime_type)
            .cloned()
            .unwrap_or_default();
        let mut pending = self
            .runtime_types
            .get(runtime_type)
            .cloned()
            .unwrap_or_default();
        let mut seen = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(ty) = self.types.get(&id) {
                if matches!(ty.kind.as_str(), "function" | "closure")
                    && let Some(declaration) = &ty.declaration
                {
                    for callable in self
                        .declaration_callables
                        .get(declaration)
                        .into_iter()
                        .flatten()
                        .filter_map(|id| self.callables.get(id))
                        .filter(|callable| {
                            &callable.declaration == declaration
                                && serde_json::to_value(&callable.arguments).ok()
                                    == serde_json::to_value(&ty.arguments).ok()
                        })
                    {
                        found.insert(callable.id.clone());
                    }
                }
                for argument in &ty.arguments {
                    if argument.kind == "type" {
                        pending.push(argument.value.clone());
                    }
                }
            }
        }
        found.into_iter().collect()
    }

    fn nested_types_with_role(&self, type_id: &str, role: &str) -> Vec<String> {
        let mut pending = vec![type_id.to_owned()];
        let mut seen = BTreeSet::new();
        let mut found = vec![];
        while let Some(id) = pending.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(ty) = self.types.get(&id) {
                if ty.roles.iter().any(|value| value == role) {
                    found.push(id);
                } else if matches!(ty.kind.as_str(), "reference" | "tuple") {
                    pending.extend(
                        ty.arguments
                            .iter()
                            .filter(|argument| argument.kind == "type")
                            .map(|argument| argument.value.clone()),
                    );
                }
            }
        }
        found
    }
}

/// 仅消费已核实事实；待补用途和无法绑定的注册分别保存，供维护入口恢复。
pub fn build(facts: &Path, runtime: &Path, annotations: &Path, output: &Path) -> Result<()> {
    let summary = output
        .parent()
        .context("Model output has no parent")?
        .join("purpose-summary.json");
    if let Err(error) = fs::remove_file(&summary)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        return Err(error).context("Cannot clear previous purpose summary");
    }
    let facts_hash = crate::host::file_digest(facts)?;
    let runtime_bytes = fs::read(runtime)?;
    let bundle: Bundle = serde_json::from_reader(BufReader::with_capacity(
        1024 * 1024,
        fs::File::open(facts)?,
    ))
    .context("Invalid compiler fact bundle")?;
    let runtime_data: RuntimeSnapshot =
        serde_json::from_slice(&runtime_bytes).context("Invalid runtime snapshot")?;
    eprintln!(
        "Architecture model: loaded {} compiler units and {} runtime schedules",
        bundle.units.len(),
        runtime_data.schedules.len()
    );
    ensure!(
        bundle.schema_version == FACT_SCHEMA_VERSION && runtime_data.schema_version == 1,
        "Unsupported analysis schema"
    );
    ensure!(
        !bundle.compiler.is_empty() && !bundle.units.is_empty(),
        "Compiler provenance is missing"
    );
    ensure!(
        bundle.runtime_sha256 == digest(&runtime_bytes),
        "Compiler/runtime build provenance mismatch"
    );
    let root = PathBuf::from(&bundle.workspace).canonicalize()?;
    ensure!(
        source_fingerprint(&root)? == runtime_data.source_fingerprint,
        "Runtime source fingerprint is stale"
    );
    let annotations: Value = serde_json::from_slice(&fs::read(annotations)?)?;
    ensure!(
        annotations["schemaVersion"] == 1 && annotations["items"].is_object(),
        "Unsupported annotation schema"
    );
    for origin in &bundle.source_origins {
        ensure!(
            origin["compilerCommit"] == bundle.compiler,
            "Compiler source origin commit mismatch"
        );
    }
    let source_cache = SourceCache::new(root.clone(), bundle.packages, bundle.source_origins);
    let behavior_context = bundle
        .units
        .iter()
        .all(|unit| !unit.behavior_hash.is_empty())
        .then(|| {
            let summaries: BTreeSet<_> = bundle
                .units
                .iter()
                .map(|unit| &unit.behavior_hash)
                .collect();
            digest(
                serde_json::to_vec(&(&bundle.compiler, summaries))
                    .expect("Owning-unit semantic context"),
            )
        });
    let mut model = Model {
        root,
        source_cache,
        declarations: BTreeMap::new(),
        annotation_keys: BTreeMap::new(),
        types: BTreeMap::new(),
        callables: BTreeMap::new(),
        declaration_callables: BTreeMap::new(),
        runtime_callables: BTreeMap::new(),
        runtime_types: BTreeMap::new(),
        call_edges: BTreeMap::new(),
        body_proofs: BTreeMap::new(),
        unproven_calls: BTreeMap::new(),
        purpose_work_gaps: BTreeMap::new(),
        behavior_hashes: BTreeMap::new(),
        behavior_context,
        purpose_inventories: bundle
            .units
            .iter()
            .map(|unit| unit.purpose_inventory.clone())
            .collect(),
        purpose_dependencies: BTreeMap::new(),
        purpose_certified: 0,
        purpose_fallback: 0,
        purpose_fallbacks: BTreeMap::new(),
        annotation_hits: BTreeSet::new(),
        objects: BTreeMap::new(),
        relations: BTreeMap::new(),
        features: BTreeMap::new(),
        pending: BTreeMap::new(),
        rejected_types: BTreeMap::new(),
        annotations,
        fatal: vec![],
    };
    let mut accesses = vec![];
    let mut operations = vec![];
    let mut entities = vec![];
    let mut registrations = vec![];
    let mut calls = vec![];
    let mut purpose_calls = vec![];
    let mut gaps = vec![];
    let mut fact_sources = BTreeMap::new();
    let mut unit_views = Vec::<BTreeSet<PurposeCrateView>>::new();
    let mut call_contexts = BTreeMap::<(String, String), BTreeSet<usize>>::new();
    for unit in bundle.units {
        ensure!(
            unit.schema_version == FACT_SCHEMA_VERSION,
            "Unsupported compiler unit schema"
        );
        ensure!(
            !unit.source_files.is_empty(),
            "Compiler unit has no source provenance: {}",
            unit.crate_name
        );
        for source in unit.source_files {
            if let Some(previous) = fact_sources.get(&source.path) {
                ensure!(
                    previous == &source.sha256,
                    "Compiler units contain mixed source versions: {}",
                    source.path
                );
                continue;
            }
            let bytes = fs::read(&source.path)
                .with_context(|| format!("Compiler fact source is unavailable: {}", source.path))?;
            ensure!(
                digest(bytes) == source.sha256,
                "Compiler fact source is stale: {}",
                source.path
            );
            fact_sources.insert(source.path, source.sha256);
        }
        let inventory = &unit.purpose_inventory;
        let own_view = PurposeCrateView {
            crate_identity: inventory.crate_identity.clone(),
            metadata_hash: inventory.metadata_hash.clone(),
        };
        let authenticated_body = !own_view.crate_identity.is_empty()
            && !own_view.metadata_hash.is_empty()
            && inventory.required_views.contains(&own_view)
            && inventory.coverage.iter().any(|coverage| {
                coverage.crate_identity == own_view.crate_identity
                    && coverage.metadata_hash == own_view.metadata_hash
                    && coverage.complete
                    && coverage.traits.is_none()
            });
        if authenticated_body {
            let owning: BTreeSet<_> = unit
                .declarations
                .iter()
                .filter(|declaration| declaration.local)
                .map(|declaration| declaration.id.as_str())
                .collect();
            for callable in unit.callables.iter().filter(|callable| {
                callable.body_analyzed && owning.contains(callable.declaration.as_str())
            }) {
                model
                    .body_proofs
                    .entry(callable.id.clone())
                    .or_default()
                    .insert(own_view.clone());
            }
        }
        let view_index = unit_views.len();
        unit_views.push(inventory.required_views.iter().cloned().collect());
        for call in unit.calls.iter().chain(&unit.purpose_calls) {
            if let Some(callee) = &call.callee {
                call_contexts
                    .entry((call.caller.clone(), callee.clone()))
                    .or_default()
                    .insert(view_index);
            }
        }
        let recorded_reasons: BTreeSet<_> = unit
            .calls
            .iter()
            .chain(&unit.purpose_calls)
            .filter_map(|call| {
                call.unresolved_reason
                    .as_ref()
                    .map(|reason| (call.caller.clone(), reason.clone()))
            })
            .collect();
        for gap in unit
            .gaps
            .iter()
            .filter(|gap| gap.kind == "purpose-work-budget")
        {
            model
                .purpose_work_gaps
                .entry(gap.owner.clone())
                .or_default()
                .insert(format!("{}: {} [{}]", gap.kind, gap.reason, gap.owner));
        }
        for gap in unit.gaps.iter().filter(|gap| {
            matches!(
                gap.kind.as_str(),
                "dynamic-call"
                    | "unresolved-call"
                    | "unresolved-dynamic-dispatch"
                    | "inline-assembly"
                    | "implicit-drop"
                    | "missing-body"
                    | "instance-budget"
            )
        }) {
            if recorded_reasons.contains(&(gap.owner.clone(), gap.kind.clone())) {
                // 同一原生调用已经携带精确原因；按该 CallFact 的成员身份检查，不按 Span 配对。
                continue;
            }
            let owners = if gap.owner == "unit" {
                unit.callables
                    .iter()
                    .map(|callable| callable.id.clone())
                    .collect()
            } else {
                vec![gap.owner.clone()]
            };
            for owner in owners {
                model
                    .unproven_calls
                    .entry(owner)
                    .or_default()
                    .push(UnprovenCall {
                        declaration: None,
                        reason: format!("{}: {}", gap.kind, gap.reason),
                        allow_purpose_dependency: false,
                    });
            }
        }
        for declaration in unit.declarations {
            match model.declarations.entry(declaration.id.clone()) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(declaration);
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    ensure!(
                        !declaration.local
                            || !entry.get().local
                            || (declaration.evidence_hash == entry.get().evidence_hash
                                && declaration.unresolved_behavior
                                    == entry.get().unresolved_behavior
                                && declaration.purpose_dependencies
                                    == entry.get().purpose_dependencies),
                        "Conflicting owning-unit behavior for {} ({}); compiler units with different cfg behavior cannot share one fixed-configuration model",
                        declaration.full_name,
                        declaration.id
                    );
                    if declaration.local && !entry.get().local {
                        entry.insert(declaration);
                    }
                }
            }
        }
        for ty in unit.types {
            // 同一原生类型在 owning/外部视图可打印不同路径；只统一已观察的展示文本。
            model
                .types
                .entry(ty.id.clone())
                .and_modify(|current| {
                    if ty.display < current.display {
                        current.display.clone_from(&ty.display);
                    }
                })
                .or_insert(ty);
        }
        for callable in unit.callables {
            model
                .callables
                .entry(callable.id.clone())
                .or_insert(callable);
        }
        accesses.extend(unit.accesses);
        operations.extend(unit.operations);
        entities.extend(unit.entities);
        registrations.extend(unit.registrations);
        calls.extend(unit.calls);
        purpose_calls.extend(unit.purpose_calls);
        gaps.extend(
            unit.gaps
                .into_iter()
                .map(|gap| (unit.crate_identity.clone(), gap)),
        );
    }
    let mut canonical_names = BTreeMap::<String, usize>::new();
    for declaration in model.declarations.values() {
        *canonical_names
            .entry(declaration.full_name.clone())
            .or_default() += 1;
    }
    for declaration in model.declarations.values() {
        let key = if canonical_names[&declaration.full_name] > 1 {
            format!("{}#{}", declaration.full_name, declaration.id)
        } else {
            declaration.full_name.clone()
        };
        model.annotation_keys.insert(declaration.id.clone(), key);
    }
    for callable in model.callables.values() {
        model
            .declaration_callables
            .entry(callable.declaration.clone())
            .or_default()
            .push(callable.id.clone());
        for runtime in &callable.system_type_ids {
            model
                .runtime_callables
                .entry(runtime.clone())
                .or_default()
                .insert(callable.id.clone());
        }
    }
    for ty in model.types.values() {
        if let Some(runtime) = &ty.runtime_type_id {
            model
                .runtime_types
                .entry(runtime.clone())
                .or_default()
                .push(ty.id.clone());
        }
    }
    let mut calls_by_caller = BTreeMap::<&str, Vec<usize>>::new();
    for (index, call) in calls.iter().enumerate() {
        calls_by_caller
            .entry(call.caller.as_str())
            .or_default()
            .push(index);
    }
    // 用途依赖包含私有 MIR 审计；业务上下文与公开调用图只读取真实条件调用。
    for call in calls.iter().chain(&purpose_calls) {
        if let Some(reason) = &call.unresolved_reason
            && call.callee.is_some()
        {
            model.unproven_calls.entry(call.caller.clone()).or_default().push(UnprovenCall {
                declaration: call.declaration.clone(),
                reason: format!("{reason}: caller {} 的调用同时携带 callee 和未解决原因，不能认证完整调用证据", call.caller),
                allow_purpose_dependency: false,
            });
        }
        if let Some(callee) = &call.callee {
            let complete = model.body_proofs.get(callee).is_some_and(|proofs| {
                call_contexts
                    .get(&(call.caller.clone(), callee.clone()))
                    .is_some_and(|contexts| {
                        contexts.iter().all(|context| {
                            proofs
                                .iter()
                                .any(|proof| unit_views[*context].contains(proof))
                        })
                    })
            });
            if !complete {
                model.unproven_calls.entry(call.caller.clone()).or_default().push(UnprovenCall {
                    declaration: model.callables.get(callee).map(|callable| callable.declaration.clone()).or_else(|| call.declaration.clone()),
                    reason: format!("missing-helper-body: caller {} 的 callee {} 没有对应实际 owning 视图的完整函数体与调用覆盖", call.caller, callee),
                    allow_purpose_dependency: true,
                });
            }
            model
                .call_edges
                .entry(call.caller.clone())
                .or_default()
                .insert(callee.clone());
        } else {
            let reason = call.unresolved_reason.as_deref().unwrap_or("unknown-call");
            model
                .unproven_calls
                .entry(call.caller.clone())
                .or_default()
                .push(UnprovenCall {
                    declaration: call.declaration.clone(),
                    reason: format!(
                        "{reason}: caller {} 的调用未绑定确切 callee（声明 {}）",
                        call.caller,
                        call.declaration.as_deref().unwrap_or("未知")
                    ),
                    allow_purpose_dependency: reason == "unresolved-call"
                        && call.declaration.is_some(),
                });
        }
    }
    // 原生依赖类型由实际访问、操作及装配边引入，避免把库内全部实现细节当作架构对象。
    eprintln!(
        "Architecture model: merged {} declarations, {} types, {} callables and {} call edges",
        model.declarations.len(),
        model.types.len(),
        model.callables.len(),
        calls.len()
    );
    let type_ids: Vec<_> = model
        .types
        .values()
        .filter(|ty| {
            !ty.roles.iter().any(|role| role == "SystemSet")
                && ty
                    .declaration
                    .as_ref()
                    .and_then(|id| model.declarations.get(id))
                    .is_some_and(|declaration| declaration.crate_name == "demo")
        })
        .map(|ty| ty.id.clone())
        .collect();
    for id in type_ids {
        model.type_object(&id);
    }
    model.features.insert(
        "application".into(),
        json!({"id":"application","label":"应用","plugin":"App","overviewNode":"app-main"}),
    );
    model.objects.insert("app-main".into(),json!({"id":"app-main","name":"main / App","kind":"App","feature":"application","description":"装配当前应用的插件，并在专用导出模式记录真实调度快照。","display_summary":"装配应用并导出真实调度。","sourceEntries":[],"sourceGaps":[]}));
    let mut bindings = vec![];
    let mut callable_objects: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut call_contexts: BTreeMap<(String, String, bool), Vec<SourceEvidence>> = BTreeMap::new();
    let mut group_catalog = BTreeMap::<String, Value>::new();
    let mut analysis_gaps = vec![];
    let mut schedule_groups = serde_json::Map::new();
    let runtime_directory = runtime.parent().unwrap_or(Path::new(".")).join("debugdump");
    let manifest_bytes = fs::read(runtime_directory.join("manifest.json"))
        .context("Runtime export has no successful manifest")?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)?;
    ensure!(
        manifest["sourceFingerprint"] == runtime_data.source_fingerprint,
        "Runtime manifest source mismatch"
    );
    let manifest_schedules = manifest["schedules"]
        .as_array()
        .context("Runtime manifest has no schedules")?;
    ensure!(
        manifest_schedules.len() == runtime_data.schedules.len(),
        "Runtime manifest schedule coverage mismatch"
    );
    let mut assembly_owners: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for callable in model.callables.values().cloned().collect::<Vec<_>>() {
        let Some(declaration) = model.declarations.get(&callable.declaration).cloned() else {
            continue;
        };
        if declaration.crate_name == "demo" && declaration.name == "main" {
            assembly_owners
                .entry(callable.id.clone())
                .or_default()
                .insert("app-main".into());
            let sources = model.source(&declaration.source, "assembly");
            model.objects.get_mut("app-main").unwrap()["sourceEntries"] = json!(sources);
        }
        if declaration.name == "build"
            && let Some(parameter) = callable.parameters.first()
        {
            for role in ["Plugin", "PluginGroup"] {
                for ty in model.nested_types_with_role(&parameter.type_id, role) {
                    if let Some(plugin) = model.type_object(&ty) {
                        assembly_owners
                            .entry(callable.id.clone())
                            .or_default()
                            .insert(plugin);
                    }
                }
            }
        }
    }
    let mut assembly_queue: VecDeque<_> = assembly_owners
        .iter()
        .flat_map(|(callable, owners)| {
            owners
                .iter()
                .map(move |owner| (callable.clone(), owner.clone()))
        })
        .collect();
    while let Some((caller, owner)) = assembly_queue.pop_front() {
        for index in calls_by_caller.get(caller.as_str()).into_iter().flatten() {
            let Some(callee) = &calls[*index].callee else {
                continue;
            };
            if assembly_owners
                .entry(callee.clone())
                .or_default()
                .insert(owner.clone())
            {
                assembly_queue.push_back((callee.clone(), owner.clone()));
            }
        }
    }
    eprintln!(
        "Architecture model: propagated {} assembly owner states",
        assembly_owners.values().map(BTreeSet::len).sum::<usize>()
    );
    for registration in &registrations {
        if !matches!(registration.kind.as_str(), "add_observer" | "observe") {
            continue;
        }
        let Some(target) = registration.target.as_ref() else {
            continue;
        };
        let Some(callable) = model.callables.get(target).cloned() else {
            continue;
        };
        let Some(declaration) = model.declarations.get(&callable.declaration).cloned() else {
            continue;
        };
        let id = identifier(
            "observer",
            (&registration.owner, target, &registration.source),
        );
        let mut sources = model.source(&declaration.source, "definition");
        sources.extend(model.source(&registration.source, "registration"));
        let feature = model.feature(Some(&declaration));
        let evidence_hash = model.behavior_hash(&declaration);
        let (description, summary) = model.purpose(
            &model.purpose_key(&declaration),
            &callable.display,
            "Observer",
            &evidence_hash,
            &declaration.docs,
            &sources,
        );
        model.objects.insert(id.clone(),json!({"id":id,"name":callable.display,"kind":"Observer","feature":feature,"description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":[],"registrationScope":"static-callsite","callableIds":[target]}));
        callable_objects
            .entry(target.clone())
            .or_default()
            .push(id.clone());
        call_contexts.insert((target.clone(), id.clone(), false), vec![]);
    }
    for schedule in &runtime_data.schedules {
        eprintln!(
            "Architecture model: binding {}/{} ({} systems, {} sets)",
            schedule.app,
            schedule.label,
            schedule.systems.len(),
            schedule.sets.len()
        );
        ensure!(
            schedule.id == digest(format!("{}\0{}", schedule.app, schedule.label))[..16],
            "Invalid runtime schedule identity"
        );
        ensure!(
            Path::new(&schedule.dot_filename)
                .file_name()
                .and_then(|value| value.to_str())
                == Some(schedule.dot_filename.as_str()),
            "Runtime DOT path escapes export directory"
        );
        ensure!(
            manifest_schedules
                .iter()
                .filter(|entry| entry["id"] == schedule.id
                    && entry["app"] == schedule.app
                    && entry["label"] == schedule.label
                    && entry["filename"] == schedule.dot_filename
                    && entry["sha256"] == schedule.dot_sha256)
                .count()
                == 1,
            "Runtime manifest schedule identity mismatch"
        );
        let dot_path = runtime_directory.join(&schedule.dot_filename);
        ensure!(
            digest(
                fs::read(&dot_path)
                    .with_context(|| format!("Missing runtime DOT {}", dot_path.display()))?
            ) == schedule.dot_sha256,
            "Runtime DOT hash mismatch"
        );
        let view_id = format!("schedule-{}", schedule.id);
        let mut view_bindings = vec![];
        let mut native_objects = BTreeMap::new();
        let mut groups = BTreeMap::<String, Vec<String>>::new();
        for system in &schedule.systems {
            let id = identifier("registration", (&schedule.app, &schedule.id, &system.key));
            let candidates = model.callable_for_runtime(&system.type_id);
            if candidates.is_empty() {
                model.fatal.push(format!(
                    "No compiler instance for runtime system {} / {} / {} ({})",
                    schedule.app, schedule.label, system.key, system.type_id
                ));
            }
            let mut source_entries = vec![];
            let mut descriptions = vec![];
            let mut summaries = vec![];
            let mut features = BTreeSet::new();
            let mut system_groups = BTreeSet::new();
            for candidate in &candidates {
                let Some(callable) = model.callables.get(candidate).cloned() else {
                    continue;
                };
                let Some(declaration) = model.declarations.get(&callable.declaration).cloned()
                else {
                    continue;
                };
                let sources = model.source(&declaration.source, "definition");
                let evidence_hash = model.behavior_hash(&declaration);
                let (description, summary) = model.purpose(
                    &model.purpose_key(&declaration),
                    &callable.display,
                    "System",
                    &evidence_hash,
                    &declaration.docs,
                    &sources,
                );
                descriptions.push(description);
                summaries.push(summary);
                source_entries.extend(sources);
                let feature = model.feature(Some(&declaration));
                features.insert(feature.clone());
                let group = if declaration.crate_name == "demo" {
                    format!("plugin:{feature}")
                } else {
                    format!("crate:{}", declaration.crate_name)
                };
                group_catalog
                    .entry(group.clone())
                    .or_insert(json!({"id":group,"label":feature,"description":"系统定义来源"}));
                system_groups.insert(group);
                callable_objects
                    .entry(candidate.clone())
                    .or_default()
                    .push(id.clone());
                call_contexts.insert((candidate.clone(), id.clone(), false), vec![]);
                let registration_sources: Vec<_> = registrations
                    .iter()
                    .filter(|registration| registration.target.as_ref() == Some(candidate))
                    .filter_map(|registration| registration.source.clone())
                    .collect();
                let registration_sources = unique(
                    registration_sources
                        .iter()
                        .map(|source| serde_json::to_value(source).expect("Source evidence"))
                        .collect(),
                );
                if registration_sources.len() == 1 {
                    let source: SourceEvidence =
                        serde_json::from_value(registration_sources[0].clone())
                            .expect("Source evidence");
                    source_entries.extend(model.source(&Some(source), "registration"));
                }
            }
            for group in system_groups {
                groups.entry(group).or_default().push(system.name.clone());
            }
            let feature = features
                .into_iter()
                .next()
                .unwrap_or_else(|| model.feature(None));
            let kind = if candidates.len() > 1 {
                "System group"
            } else {
                "System"
            };
            let access_gaps =
                if system.access_scope == "unbounded" || system.access_scope == "exclusive" {
                    vec!["该系统可以访问当前 World 的任意数据；有限访问列表不构成完整边界。"]
                } else {
                    vec![]
                };
            model.objects.insert(id.clone(),json!({"id":id,"name":system.name,"kind":kind,"feature":feature,"description":descriptions.join("\n"),"display_summary":summaries.join("；"),"sourceEntries":unique(source_entries),"sourceGaps":access_gaps,"worldAccessScope":system.access_scope,"callableIds":candidates,"runtimeTypeId":system.type_id,"runConditions":system.conditions,"registrations":[{"application":schedule.app,"schedule":schedule.label,"scope":"runtime"}]}));
            for (condition, candidates) in model.bind_conditions(
                &system.conditions,
                schedule,
                &system.key,
                &[id.clone()],
                "runtime-system-condition",
            ) {
                for candidate in candidates {
                    callable_objects
                        .entry(candidate.clone())
                        .or_default()
                        .push(condition.clone());
                    call_contexts.insert((candidate, condition.clone(), false), vec![]);
                }
            }
            native_objects.insert(system.key.clone(), vec![id.clone()]);
            view_bindings.push(json!({"id":identifier("binding",(&view_id,&system.graph_name)),"kind":"system","graphName":system.graph_name,"objectId":id}));
            for access in &system.accesses {
                let type_id = access
                    .type_id
                    .as_ref()
                    .and_then(|runtime| {
                        model
                            .runtime_types
                            .get(runtime)
                            .and_then(|types| types.first())
                    })
                    .cloned();
                let classes: BTreeSet<_> = accesses
                    .iter()
                    .filter(|declared| {
                        candidates.contains(&declared.owner)
                            && Some(&declared.type_id) == type_id.as_ref()
                    })
                    .map(|declared| declared.storage.as_str())
                    .filter(|storage| {
                        matches!(
                            *storage,
                            "Component"
                                | "Resource"
                                | "NonSend"
                                | "Message"
                                | "Event"
                                | "EntityEvent"
                        )
                    })
                    .collect();
                let target = if classes.len() > 1 {
                    None
                } else {
                    type_id
                        .as_ref()
                        .and_then(|type_id| model.type_object_as(type_id, classes.first().copied()))
                };
                if let Some(target) = target {
                    let mode = access.mode.as_str();
                    let read = mode == "read" || mode == "filter";
                    model.link(
                        if read { &target } else { &id },
                        if read { &id } else { &target },
                        mode,
                        mode,
                        vec![],
                        json!({"evidence":"runtime-access","scope":schedule.app}),
                    );
                } else {
                    let reason = format!(
                        "运行时记录了 {} 的 {} 能力，但无法唯一关联其编译器类型与访问角色。",
                        access.name, access.mode
                    );
                    model.objects.get_mut(&id).unwrap()["sourceGaps"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(reason));
                    analysis_gaps.push(json!({"unit":"runtime","owner":id,"kind":"runtime-access-type","reason":reason,"sourceEntries":[],"application":schedule.app,"schedule":schedule.label,"nativeKey":system.key,"access":access}));
                }
            }
        }
        for set in &schedule.sets {
            if let Some(system_type) = &set.system_type {
                let mut members = vec![set.key.clone()];
                let mut visited = BTreeSet::new();
                let mut instances = vec![];
                while let Some(member) = members.pop() {
                    if !visited.insert(member.clone()) {
                        continue;
                    }
                    if let Some(objects) = native_objects.get(&member) {
                        instances.extend(objects.iter().cloned());
                    }
                    members.extend(
                        schedule
                            .hierarchy
                            .iter()
                            .filter(|edge| edge.from == member)
                            .map(|edge| edge.to.clone()),
                    );
                }
                instances.sort();
                instances.dedup();
                if instances.is_empty() {
                    let id = identifier("set", (&schedule.app, &schedule.id, &set.key));
                    model.objects.insert(id.clone(),json!({"id":id,"name":set.label,"kind":"SystemSet","feature":"application","description":"引用一个在当前调度中没有注册实例的系统类型；保留该原生依赖端点。","display_summary":"保留未注册系统类型的依赖端点。","sourceEntries":[],"sourceGaps":["当前 Schedule 没有此系统类型的注册实例；不能把占位端点当作可执行系统。"],"runtimeTypeId":set.type_id,"systemTypeId":system_type}));
                    instances.push(id);
                }
                for (condition, candidates) in model.bind_conditions(
                    &set.conditions,
                    schedule,
                    &set.key,
                    &instances,
                    "runtime-set-condition",
                ) {
                    for candidate in candidates {
                        callable_objects
                            .entry(candidate.clone())
                            .or_default()
                            .push(condition.clone());
                        call_contexts.insert((candidate, condition.clone(), false), vec![]);
                    }
                }
                native_objects.insert(set.key.clone(), instances);
                continue;
            }
            let id = identifier("set", (&schedule.app, &schedule.id, &set.key));
            let ty = model
                .runtime_types
                .get(&set.type_id)
                .and_then(|types| types.first())
                .and_then(|id| model.types.get(id))
                .cloned();
            let declaration = ty
                .as_ref()
                .and_then(|ty| ty.declaration.as_ref())
                .and_then(|id| model.declarations.get(id))
                .cloned();
            let sources = model.source(
                &declaration
                    .as_ref()
                    .and_then(|declaration| declaration.source.clone()),
                "definition",
            );
            let feature = model.feature(declaration.as_ref());
            let (description, summary) = if set.anonymous {
                (
                    "保存这组系统的共同配置；成员、条件和依赖来自真实装配快照。".into(),
                    "保存一组系统的共同配置。".into(),
                )
            } else if let Some(declaration) = &declaration {
                let evidence_hash = model.behavior_hash(declaration);
                model.purpose(
                    &model.purpose_key(declaration),
                    &set.label,
                    "SystemSet",
                    &evidence_hash,
                    &declaration.docs,
                    &sources,
                )
            } else {
                model.fatal.push(format!(
                    "No compiler type for runtime set {} / {} / {}",
                    schedule.app, schedule.label, set.key
                ));
                (String::new(), String::new())
            };
            model.objects.insert(id.clone(),json!({"id":id,"name":set.label,"kind":"SystemSet","feature":feature,"description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":[],"runtimeTypeId":set.type_id,"runConditions":set.conditions}));
            for (condition, candidates) in model.bind_conditions(
                &set.conditions,
                schedule,
                &set.key,
                &[id.clone()],
                "runtime-set-condition",
            ) {
                for candidate in candidates {
                    callable_objects
                        .entry(candidate.clone())
                        .or_default()
                        .push(condition.clone());
                    call_contexts.insert((candidate, condition.clone(), false), vec![]);
                }
            }
            native_objects.insert(set.key.clone(), vec![id.clone()]);
            view_bindings.push(json!({"id":identifier("binding",(&view_id,&set.graph_name)),"kind":"set","graphName":set.graph_name,"objectId":id}));
        }
        for edge in &schedule.hierarchy {
            if schedule
                .sets
                .iter()
                .any(|set| set.key == edge.from && set.system_type.is_some())
            {
                continue;
            }
            if let (Some(from), Some(to)) =
                (native_objects.get(&edge.from), native_objects.get(&edge.to))
            {
                for from in from {
                    for to in to {
                        if from != to {
                            model.link(
                    from,
                    to,
                    "membership",
                    "集合成员",
                    vec![],
                    json!({"evidence":"runtime","nativeFrom":edge.from,"nativeTo":edge.to}),
                );
                        }
                    }
                }
            }
        }
        for edge in &schedule.dependencies {
            if let (Some(from), Some(to)) =
                (native_objects.get(&edge.from), native_objects.get(&edge.to))
            {
                for from in from {
                    for to in to {
                        model.link(
                            from,
                            to,
                            "order",
                            "先于",
                            vec![],
                            json!({"evidence":"runtime","nativeFrom":edge.from,"nativeTo":edge.to}),
                        );
                    }
                }
            }
        }
        bindings.push(
            json!({"viewId":view_id,"dotSha256":schedule.dot_sha256,"bindings":view_bindings}),
        );
        schedule_groups.insert(
            view_id,
            json!(
                groups
                    .into_iter()
                    .map(
                        |(id, names)| json!({"id":id,"systemCount":names.len(),"systemNames":names})
                    )
                    .collect::<Vec<_>>()
            ),
        );
    }
    let registration_roots = callable_objects.clone();
    // helper 调用仅传播已确认的操作归属，不将 helper 标成新的系统注册。
    eprintln!(
        "Architecture model: runtime bindings complete; propagating {} context seeds",
        call_contexts.len()
    );
    let mut context_queue: VecDeque<_> = call_contexts.keys().cloned().collect();
    while let Some(state) = context_queue.pop_front() {
        let (caller, owner, deferred) = &state;
        for index in calls_by_caller.get(caller.as_str()).into_iter().flatten() {
            let call = &calls[*index];
            let Some(callee) = &call.callee else {
                continue;
            };
            let next_deferred = *deferred || call.deferred;
            let next = (callee.clone(), owner.clone(), next_deferred);
            if call_contexts.contains_key(&next) {
                continue;
            }
            // 只在新状态确实需要插入时复制代表路径；每个状态最多入队一次。
            let owner_exists =
                call_contexts.contains_key(&(callee.clone(), owner.clone(), !next_deferred));
            let mut chain = call_contexts
                .get(&state)
                .expect("Queued call context")
                .clone();
            if let Some(source) = &call.source {
                chain.push(source.clone());
            }
            call_contexts.insert(next.clone(), chain);
            if !owner_exists {
                callable_objects
                    .entry(callee.clone())
                    .or_default()
                    .push(owner.clone());
            }
            context_queue.push_back(next);
        }
    }
    eprintln!(
        "Architecture model: propagated {} contexts over {} callables; projecting {} parameter accesses",
        call_contexts.len(),
        callable_objects.len(),
        accesses.len()
    );
    for access in accesses {
        let Some(owners) = callable_objects.get(&access.owner).cloned() else {
            continue;
        };
        if access.storage == "Local" {
            let root_owners = registration_roots
                .get(&access.owner)
                .cloned()
                .unwrap_or_default();
            let (owners, inherited): (Vec<_>, Vec<_>) = owners
                .into_iter()
                .partition(|owner| root_owners.contains(owner));
            if !inherited.is_empty() {
                let sources = model.source(&access.source, "parameter");
                let proof = access_proof(&access, &sources);
                analysis_gaps.push(json!({"unit":"model","owner":access.owner,"kind":"local-origin","reason":"可达 helper 的 Local 包装值不证明新的系统局部存储；现有事实尚未追踪到原始参数槽。","access":proof,"registeredOwners":inherited,"rootOwners":root_owners,"sourceEntries":sources}));
            }
            if owners.is_empty() {
                continue;
            }
            if let Some(unresolved) = model.unresolved_type(&access.type_id) {
                let sources = model.source(&access.source, "parameter");
                let proof = access_proof(&access, &sources);
                analysis_gaps.push(json!({"unit":"model","owner":access.owner,"kind":"access-target","reason":"Local 的具体存储类型尚未确定，保留参数槽与访问事实。","access":proof,"unresolvedType":unresolved,"registeredOwners":owners,"sourceEntries":sources}));
                continue;
            }
            let callable = model.callables.get(&access.owner).cloned();
            let declaration = callable
                .as_ref()
                .and_then(|callable| model.declarations.get(&callable.declaration))
                .cloned();
            let sources = model.source(&access.source, "parameter");
            let feature = model.feature(declaration.as_ref());
            let key = format!(
                "{}|{}",
                declaration
                    .as_ref()
                    .map(|declaration| model.purpose_key(declaration))
                    .unwrap_or_else(|| access.owner.clone()),
                access.parameter
            );
            let evidence_hash = declaration
                .as_ref()
                .map(|declaration| model.behavior_hash(declaration))
                .unwrap_or_default();
            let name = format!("Local · {}", access.parameter);
            let (description, summary) =
                model.purpose(&key, &name, "Local", &evidence_hash, "", &sources);
            for owner in owners {
                let id = identifier("local", (&owner, &access.owner, &access.parameter));
                model.objects.insert(id.clone(),json!({"id":id,"name":name,"kind":"Local","feature":feature,"description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":[],"parameter":access.parameter,"callableId":access.owner,"typeInstanceId":access.type_id}));
                model.link(
                    &owner,
                    &id,
                    &access.mode,
                    &access.mode,
                    sources.clone(),
                    parameter_relation_evidence(&access, &owner, true, &sources),
                );
            }
            continue;
        }
        if let Some(target) = model.type_object_as(&access.type_id, Some(&access.storage)) {
            let sources = model.source(&access.source, "parameter");
            let read = matches!(access.mode.as_str(), "read" | "filter" | "event");
            for owner in owners {
                let direct_root = registration_roots
                    .get(&access.owner)
                    .is_some_and(|roots| roots.contains(&owner));
                model.link(
                    if read { &target } else { &owner },
                    if read { &owner } else { &target },
                    &access.mode,
                    &access.mode,
                    sources.clone(),
                    parameter_relation_evidence(&access, &owner, direct_root, &sources),
                );
            }
        } else {
            let sources = model.source(&access.source, "parameter");
            let proof = access_proof(&access, &sources);
            analysis_gaps.push(json!({"unit":"model","owner":access.owner,"kind":"access-target","reason":"保留编译器确认的参数访问；目标尚不能成为具体 ECS 对象。","access":proof,"registeredOwners":owners,"sourceEntries":sources}));
        }
    }
    for registration in &registrations {
        let Some(owners) = assembly_owners.get(&registration.owner) else {
            continue;
        };
        let sources = model.source(&registration.source, "registration");
        if registration.kind == "add_plugins"
            && let Some(ty) = &registration.type_id
        {
            for role in ["Plugin", "PluginGroup"] {
                for ty in model.nested_types_with_role(ty, role) {
                    if let Some(target) = model.type_object(&ty) {
                        for owner in owners {
                            model.link(
                                owner,
                                &target,
                                "registration",
                                "安装调用",
                                sources.clone(),
                                json!({"evidence":"typed-call","scope":"static-callsite"}),
                            );
                        }
                    }
                }
            }
        }
        if let Some(target) = &registration.target
            && let Some(instances) = registration_roots.get(target)
        {
            for owner in owners {
                for target in instances {
                    model.link(
                        owner,
                        target,
                        "registration",
                        "注册调用",
                        sources.clone(),
                        json!({"evidence":"typed-call","scope":"static-callsite"}),
                    );
                }
            }
        }
    }
    eprintln!(
        "Architecture model: projecting {} body operations",
        operations.len()
    );
    let creation_sites = creation_templates(&entities);
    for operation in operations {
        let Some(owners) = callable_objects.get(&operation.owner).cloned() else {
            continue;
        };
        let mut targets = vec![];
        let mut unresolved_parts = BTreeSet::new();
        if operation.kind == "create" {
            targets.extend(creation_target(&operation, &creation_sites));
        } else if let Some(type_id) = &operation.target_type {
            if matches!(operation.kind.as_str(), "insert" | "remove")
                && model
                    .types
                    .get(type_id)
                    .is_some_and(|ty| ty.kind == "tuple")
            {
                let (components, unresolved) = model.tuple_components(type_id);
                unresolved_parts = unresolved;
                targets.extend(
                    components
                        .iter()
                        .filter_map(|id| model.type_object_as(id, Some("Component"))),
                );
            } else {
                targets.extend(model.type_object(type_id));
            }
        }
        if targets.is_empty() || !unresolved_parts.is_empty() {
            let sources = model.source(&operation.source, "operation");
            let conditions = model.guard_sources(&operation.conditions);
            let contexts:Vec<_>=call_contexts.range((operation.owner.clone(), String::new(), false)..).take_while(|((callable,_,_),_)|callable==&operation.owner).map(|((_,owner,deferred),_)|json!({"registeredOwner":owner,"deferred":*deferred||operation.deferred})).collect();
            let classification = if matches!(operation.kind.as_str(), "create" | "despawn") {
                "entity-template"
            } else if !unresolved_parts.is_empty()
                || operation
                    .target_type
                    .as_deref()
                    .and_then(|id| model.unresolved_type(id))
                    .is_some()
            {
                "unresolved-type"
            } else {
                "non-object-type"
            };
            analysis_gaps.push(json!({"unit":"model","owner":operation.owner,"kind":"operation-target","classification":classification,"reason":"编译器确认此操作，但未建立其运行时实体目标与创建模板或可见类型对象的完整连接。","sourceEntries":sources,"operation":{"id":operation.id,"kind":operation.kind,"method":operation.method,"targetType":operation.target_type,"resolvedTargets":targets,"unresolvedParts":unresolved_parts,"apiDeferred":operation.deferred,"scope":operation.scope,"conditions":conditions,"callContexts":contexts},"registeredOwners":owners}));
        }
        let mut sources = model.source(&operation.source, "operation");
        for source in &operation.call_chain {
            sources.extend(model.source(&Some(source.clone()), "operation"));
        }
        for target in targets {
            for owner in &owners {
                let contexts: Vec<_> = call_contexts
                    .range(
                        (operation.owner.clone(), owner.clone(), false)
                            ..=(operation.owner.clone(), owner.clone(), true),
                    )
                    .map(|((_, _, deferred), chain)| (*deferred, chain.clone()))
                    .collect();
                for (deferred, chain) in contexts {
                    let mut proof = sources.clone();
                    let mut call_chain: Vec<_> = operation
                        .call_chain
                        .iter()
                        .flat_map(|source| model.source(&Some(source.clone()), "call"))
                        .collect();
                    for source in &chain {
                        call_chain.extend(model.source(&Some(source.clone()), "call"));
                    }
                    proof.extend(call_chain.clone());
                    let conditions = model.guard_sources(&operation.conditions);
                    proof.extend(conditions.clone());
                    let read = matches!(operation.kind.as_str(), "read" | "filter");
                    let label = if operation.kind == "create" {
                        "创建模板"
                    } else {
                        &operation.kind
                    };
                    model.link(if read {&target}else{owner},if read {owner}else{&target},&operation.kind,label,proof,json!({"evidence":"body","bodyOperations":[{"operationId":operation.id,"callableId":operation.owner,"registeredOwner":owner,"deferred":operation.deferred||deferred,"scope":operation.scope,"conditions":conditions,"callChain":call_chain,"callChainScope":"representative-static-path"}]}));
                }
            }
        }
    }
    eprintln!(
        "Architecture model: projected {} relations; assembling {} entity templates",
        model.relations.len(),
        entities.len()
    );
    let nested_templates: BTreeSet<_> = entities
        .iter()
        .flat_map(|entity| {
            entity.children.iter().chain(
                entity
                    .alternatives
                    .iter()
                    .flat_map(|group| &group.candidates),
            )
        })
        .cloned()
        .collect();
    for entity in entities {
        let id = identifier("entity", &entity.id);
        let mut sources = model.source(&entity.source, "create");
        for evidence in &entity.source_evidence {
            sources.extend(model.source(&Some(evidence.clone()), "assembly"));
        }
        let sources = unique(sources);
        let declaration = model
            .callables
            .get(&entity.creator)
            .and_then(|callable| model.declarations.get(&callable.declaration))
            .cloned();
        let feature = model.feature(declaration.as_ref());
        let key = format!("entity:{}", entity.id);
        let name = declaration
            .as_ref()
            .map(|declaration| format!("{} · 创建模板", declaration.name))
            .unwrap_or_else(|| "实体创建模板".into());
        let creator_behavior = if let Some(declaration) = &declaration {
            model.behavior_hash(declaration)
        } else {
            model.fatal.push(format!(
                "No compiler declaration for entity creator {}",
                entity.creator
            ));
            String::new()
        };
        let (description, summary) = model.purpose(
            &key,
            &name,
            "Entity",
            &entity_purpose_hash(&entity, &creator_behavior),
            "",
            &sources,
        );
        let mut source_gaps: Vec<_> = entity.gaps.iter().map(|gap| gap.reason.clone()).collect();
        if entity.possible {
            source_gaps.push(
                "此模板位于可能结构上下文；其组件及子实体不表示各候选在同次创建中同时存在。".into(),
            );
        }
        let mut alternative_groups = vec![];
        for group in &entity.alternatives {
            let group_sources = model.source(&group.source, "assembly");
            let candidates: Vec<_> = group
                .candidates
                .iter()
                .map(|candidate| identifier("entity", candidate))
                .collect();
            alternative_groups.push(json!({"id":group.id,"candidates":candidates,"selection":group.selection,"sourceEntries":group_sources}));
            for candidate in candidates {
                let mut context = entity.alternative_context.clone();
                context.push(group.id.clone());
                model.link(&id,&candidate,"alternative","结构候选",group_sources.clone(),json!({"evidence":"assembly","alternativeGroup":group.id,"alternativeContext":context,"selection":group.selection,"possible":true}));
            }
        }
        model.objects.insert(id.clone(),json!({"id":id,"templateId":entity.id,"name":name,"kind":"Entity","feature":feature,"description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":source_gaps,"alternativeGroups":alternative_groups,"alternativeGroup":entity.alternative_group,"alternativeSelection":entity.alternative_selection,"alternativeContext":entity.alternative_context,"possible":entity.possible}));
        for gap in &entity.gaps {
            let gap_sources = model.source(&gap.source, "assembly");
            analysis_gaps.push(json!({"unit":"model","owner":gap.owner,"kind":gap.kind,"reason":gap.reason,"sourceEntries":gap_sources,"entityTemplateId":entity.id,"alternativeGroup":entity.alternative_group,"possible":entity.possible}));
        }
        let assembly_sources = model.source(&entity.source, "create");
        if !nested_templates.contains(&entity.id)
            && let Some(owners) = callable_objects.get(&entity.creator)
        {
            for owner in owners {
                model.link(
                    owner,
                    &id,
                    "create",
                    "创建模板",
                    assembly_sources.clone(),
                    json!({"evidence":"assembly","possible":entity.possible,"alternativeGroup":entity.alternative_group,"alternativeContext":entity.alternative_context}),
                );
            }
        }
        for component_type in entity.components.iter().chain(&entity.required_components) {
            if let Some(component) = model.type_object(component_type) {
                model.link(
                    &id,
                    &component,
                    "contains",
                    "可能包含",
                    assembly_sources.clone(),
                    json!({"evidence":"assembly","explicit":entity.components.contains(component_type),"required":entity.required_components.contains(component_type),"possible":entity.possible,"alternativeGroup":entity.alternative_group,"alternativeContext":entity.alternative_context}),
                );
            }
        }
        for child in entity.children {
            let child = identifier("entity", child);
            model.link(
                &id,
                &child,
                "relationship",
                "子实体",
                vec![],
                json!({"evidence":"assembly","possible":entity.possible,"alternativeGroup":entity.alternative_group,"alternativeContext":entity.alternative_context}),
            );
        }
    }
    for (unit, gap) in gaps {
        let sources = model.source(&gap.source, "related");
        analysis_gaps.push(json!({"unit":unit,"owner":gap.owner,"kind":gap.kind,"reason":gap.reason,"sourceEntries":sources}));
        if let Some(owners) = callable_objects.get(&gap.owner) {
            for owner in owners {
                if let Some(object) = model.objects.get_mut(owner) {
                    object["sourceGaps"]
                        .as_array_mut()
                        .expect("Gap array")
                        .push(json!(gap.reason));
                }
            }
        }
        for object in model
            .objects
            .values_mut()
            .filter(|object| object["typeInstanceId"] == gap.owner)
        {
            object["sourceGaps"]
                .as_array_mut()
                .expect("Gap array")
                .push(json!(gap.reason));
        }
    }
    // 分支及多条调用路径保留为图，不把递归路径展开成不完整的线性调用链。
    let output_parent = output.parent().context("Model output has no parent")?;
    fs::create_dir_all(output_parent)?;
    let call_graph_path = output.with_extension("calls.ndjson");
    let call_graph_name = call_graph_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Call graph output has no UTF-8 filename")?;
    let mut call_graph_writer =
        BufWriter::with_capacity(1024 * 1024, fs::File::create(&call_graph_path)?);
    let mut call_graph_ids = BTreeSet::new();
    for call in &calls {
        let Some(owners) = callable_objects.get(&call.caller) else {
            continue;
        };
        let id = identifier("call", call);
        if !call_graph_ids.insert(id.clone()) {
            continue;
        }
        let sources = model.source(&call.source, "call");
        let conditions = model.guard_sources(&call.conditions);
        let edge = json!({"id":id,"caller":call.caller,"callee":call.callee,"declaration":call.declaration,"registeredOwners":owners,"deferred":call.deferred,"conditions":conditions,"sourceEntries":sources});
        serde_json::to_writer(&mut call_graph_writer, &edge)?;
        call_graph_writer.write_all(b"\n")?;
    }
    call_graph_writer.flush()?;
    drop(call_graph_writer);
    let call_graph = json!({"schemaVersion":2,"format":"ndjson","file":call_graph_name,"sha256":crate::host::file_digest(&call_graph_path)?,"edgeCount":call_graph_ids.len()});
    for object in model.objects.values_mut() {
        object["sourceGaps"] = json!(unique(
            object["sourceGaps"].as_array().cloned().unwrap_or_default()
        ));
        if object["sourceEntries"]
            .as_array()
            .is_some_and(Vec::is_empty)
            && object["sourceGaps"].as_array().is_some_and(Vec::is_empty)
        {
            object["sourceGaps"] = json!([
                "编译器没有提供此对象的独立源码位置；其身份和关系仍来自已记录的编译或运行时事实。"
            ]);
        }
    }
    finish_parameter_relations(&mut model.relations);
    finish_feature_overviews(&mut model.features, &model.objects);
    for relation in model.relations.values() {
        ensure!(
            model
                .objects
                .contains_key(relation["from"].as_str().unwrap_or(""))
                && model
                    .objects
                    .contains_key(relation["to"].as_str().unwrap_or("")),
            "Dangling compiler relationship"
        );
    }
    eprintln!(
        "Architecture model: writing {} objects, {} relations and {} reachable call edges",
        model.objects.len(),
        model.relations.len(),
        call_graph_ids.len()
    );
    eprintln!(
        "Architecture model: purpose dispatch certified {}, conservative fallback {}",
        model.purpose_certified, model.purpose_fallback
    );
    for (path, hash) in &fact_sources {
        ensure!(
            digest(fs::read(path)?) == *hash,
            "Compiler fact source changed during model generation: {path}"
        );
    }
    fs::create_dir_all(output_parent)?;
    let pending = model.pending.into_values().collect::<Vec<_>>();
    analysis_gaps.extend(model.rejected_types.into_values());
    // 此精确 kind 仅由用途 MIR 审计产生；完整记录留在私有报告，业务缺口与对象提示保持原样。
    let (compiler_gaps, analysis_gaps): (Vec<_>, Vec<_>) = aggregate_gaps(analysis_gaps)
        .into_iter()
        .partition(|gap| gap["kind"] == "implicit-drop");
    let mut compiler_gap_kinds = BTreeMap::<String, usize>::new();
    for gap in &compiler_gaps {
        *compiler_gap_kinds
            .entry(gap["kind"].as_str().expect("Compiler gap kind").into())
            .or_default() += 1;
    }
    let result = json!({"schemaVersion":1,"compiler":bundle.compiler,"configuration":bundle.configuration,
        "runtimeDirectory":runtime_directory,"inputs":{"sourceFingerprint":runtime_data.source_fingerprint,"factsSha256":facts_hash,"runtimeSha256":digest(&runtime_bytes)},
        "objects":model.objects.into_values().collect::<Vec<_>>(),"relations":model.relations.into_values().collect::<Vec<_>>(),"features":model.features.into_values().collect::<Vec<_>>(),
        "sourceFiles":model.source_cache.snapshots.into_values().collect::<Vec<_>>(),"callGraph":call_graph,"scheduleInteractions":{"schemaVersion":1,"views":bindings},"schedulePluginCatalog":group_catalog.into_values().collect::<Vec<_>>(),"schedulePluginGroups":schedule_groups,
        "annotationsRequired":pending,"bindingErrors":model.fatal,"analysisGaps":analysis_gaps});
    fs::write(output, serde_json::to_vec_pretty(&result)?)?;
    fs::write(
        output_parent.join("pending-descriptions.json"),
        serde_json::to_vec_pretty(&result["annotationsRequired"])?,
    )?;
    ensure!(
        source_fingerprint(&model.root)? == runtime_data.source_fingerprint,
        "Source changed during model generation"
    );
    ensure!(
        crate::host::file_digest(facts)? == facts_hash,
        "Compiler fact bundle changed during model generation"
    );
    fs::write(
        summary,
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "compiler": result["compiler"],
            "configuration": result["configuration"],
            "inputs": result["inputs"],
            "compilerGapSummary": {"count": compiler_gaps.len(), "byKind": compiler_gap_kinds},
            "compilerGaps": compiler_gaps,
            "certified": model.purpose_certified,
            "fallback": model.purpose_fallback,
            "fallbacks": model.purpose_fallbacks.into_values().collect::<Vec<_>>(),
            "annotationHits": model.annotation_hits.len(),
            "pending": result["annotationsRequired"].as_array().unwrap().len()
        }))?,
    )?;
    eprintln!(
        "Architecture model: output written ({} descriptions pending, {} binding errors)",
        result["annotationsRequired"].as_array().unwrap().len(),
        result["bindingErrors"].as_array().unwrap().len()
    );
    if !result["bindingErrors"].as_array().unwrap().is_empty() {
        bail!("Compiler/runtime binding is incomplete; see model bindingErrors");
    }
    if !result["annotationsRequired"].as_array().unwrap().is_empty() {
        bail!("Chinese descriptions are pending; see pending-descriptions.json");
    }
    Ok(())
}

/// 与专用导出和 Node 加载器共用的生产源码指纹。
pub fn source_fingerprint(root: &Path) -> Result<String> {
    fn collect(root: &Path, relative: &Path, files: &mut Vec<String>) -> Result<()> {
        for entry in fs::read_dir(root.join(relative))? {
            let entry = entry?;
            let path = relative.join(entry.file_name());
            let kind = entry.file_type()?;
            ensure!(
                !kind.is_symlink(),
                "Source fingerprint does not follow symlinks"
            );
            if kind.is_dir() {
                collect(root, &path, files)?;
            } else if kind.is_file() && path.extension().is_some_and(|value| value == "rs") {
                files.push(path.to_string_lossy().replace('\\', "/"));
            }
        }
        Ok(())
    }
    let mut files = vec!["Cargo.toml".to_owned(), "Cargo.lock".to_owned()];
    if root.join("build.rs").exists() {
        files.push("build.rs".into());
    }
    collect(root, Path::new("src"), &mut files)?;
    files.sort();
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.as_bytes());
        hash.update([0]);
        hash.update(fs::read_to_string(root.join(file))?.replace("\r\n", "\n"));
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;

#[cfg(test)]
mod source_cache_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn repeated_filename_reuses_snapshot_but_checks_each_evidence_hash() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/model-source-cache")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("source.rs");
        let text = "fn proof() {}\r\n";
        fs::write(&path, text).unwrap();
        let root = root.canonicalize().unwrap();
        let filename = path.to_string_lossy().into_owned();
        let mut cache = SourceCache::new(root, vec![], vec![]);
        let source = cache.resolve(&filename).unwrap();
        assert!(source.accepts_hash(&digest(text)));
        assert!(source.accepts_hash(&digest(text.replace("\r\n", "\n"))));
        assert!(!source.accepts_hash("different-evidence"));
        // 模型前后另有全量文件校验；此处只验证一次装配内不再次读取或定位同一文件。
        fs::remove_file(&path).unwrap();
        let source = cache.resolve(&filename).unwrap();
        assert!(!source.accepts_hash("different-evidence"));
        assert_eq!(cache.snapshots.len(), 1);
        assert_eq!(cache.snapshots["source.rs"]["content"], text);
    }
}
