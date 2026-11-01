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
    behavior_hashes: BTreeMap<String, String>,
    objects: BTreeMap<String, Value>,
    relations: BTreeMap<String, Value>,
    features: BTreeMap<String, Value>,
    pending: BTreeMap<String, Value>,
    annotations: Value,
    fatal: Vec<String>,
}

struct SourceRoot {
    root: PathBuf,
    dependency: Value,
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
fn unique(values: Vec<Value>) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_string()))
        .collect()
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
        while let Some(callable) = pending.pop() {
            if !seen.insert(callable.clone()) {
                continue;
            }
            if let Some(definition) = self
                .callables
                .get(&callable)
                .and_then(|callable| self.declarations.get(&callable.declaration))
            {
                definitions.insert(definition.id.clone(), definition.evidence_hash.clone());
            }
            if let Some(callees) = self.call_edges.get(&callable) {
                pending.extend(callees.iter().cloned());
            }
        }
        let hash = if definitions.len() == 1 {
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
            .map(|declaration| declaration.evidence_hash.as_str())
            .unwrap_or("");
        let docs = declaration
            .as_ref()
            .map(|declaration| declaration.docs.as_str())
            .unwrap_or("");
        let (description, summary) = self.purpose(
            &purpose_key,
            &ty.display,
            kind,
            evidence_hash,
            docs,
            &sources,
        );
        let object = json!({"id":id,"name":ty.display,"fullName":ty.display,"rust_type":ty.display,"kind":kind,"feature":feature,
            "description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":[],"declarationId":ty.declaration,"typeInstanceId":type_id});
        self.objects.insert(id.clone(), object);
        if kind == "Plugin" || kind == "PluginGroup" {
            let entry = self
                .features
                .get_mut(&feature)
                .expect("Feature was inserted");
            entry["plugin"] = json!(ty.display.rsplit("::").next().unwrap_or(&ty.display));
            entry["overviewNode"] = json!(id);
        }
        Some(id)
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
        bundle.schema_version == 1 && runtime_data.schema_version == 1,
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
        behavior_hashes: BTreeMap::new(),
        objects: BTreeMap::new(),
        relations: BTreeMap::new(),
        features: BTreeMap::new(),
        pending: BTreeMap::new(),
        annotations,
        fatal: vec![],
    };
    let mut accesses = vec![];
    let mut operations = vec![];
    let mut entities = vec![];
    let mut registrations = vec![];
    let mut calls = vec![];
    let mut gaps = vec![];
    let mut fact_sources = BTreeMap::new();
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
        for declaration in unit.declarations {
            match model.declarations.entry(declaration.id.clone()) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(declaration);
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    if declaration.local && !entry.get().local {
                        entry.insert(declaration);
                    }
                }
            }
        }
        for ty in unit.types {
            model.types.entry(ty.id.clone()).or_insert(ty);
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
        if let Some(callee) = &call.callee {
            model
                .call_edges
                .entry(call.caller.clone())
                .or_default()
                .insert(callee.clone());
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
                model.purpose(
                    &model.purpose_key(declaration),
                    &set.label,
                    "SystemSet",
                    &declaration.evidence_hash,
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
                    json!({"evidence":"parameter","scope":"local"}),
                );
            }
            continue;
        }
        if let Some(target) = model.type_object_as(&access.type_id, Some(&access.storage)) {
            let sources = model.source(&access.source, "parameter");
            let read = matches!(access.mode.as_str(), "read" | "filter" | "event");
            for owner in owners {
                model.link(if read {&target}else{&owner},if read {&owner}else{&target},&access.mode,&access.mode,sources.clone(),json!({"evidence":"parameter","scope":access.scope,"parameter":access.parameter}));
            }
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
    for operation in operations {
        let Some(owners) = callable_objects.get(&operation.owner).cloned() else {
            continue;
        };
        let Some(target) = operation
            .target_type
            .as_ref()
            .and_then(|id| model.type_object(id))
        else {
            let sources = model.source(&operation.source, "operation");
            let conditions = model.guard_sources(&operation.conditions);
            let contexts:Vec<_>=call_contexts.range((operation.owner.clone(), String::new(), false)..).take_while(|((callable,_,_),_)|callable==&operation.owner).map(|((_,owner,deferred),_)|json!({"registeredOwner":owner,"deferred":*deferred||operation.deferred})).collect();
            analysis_gaps.push(json!({"unit":"model","owner":operation.owner,"kind":"operation-target","reason":"编译器确认此操作，但未建立其运行时实体目标与创建模板或可见类型对象的连接。","sourceEntries":sources,"operation":{"id":operation.id,"kind":operation.kind,"method":operation.method,"targetType":operation.target_type,"apiDeferred":operation.deferred,"scope":operation.scope,"conditions":conditions,"callContexts":contexts},"registeredOwners":owners}));
            continue;
        };
        let mut sources = model.source(&operation.source, "operation");
        for source in &operation.call_chain {
            sources.extend(model.source(&Some(source.clone()), "operation"));
        }
        for owner in owners {
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
                model.link(if read {&target}else{&owner},if read {&owner}else{&target},&operation.kind,&operation.kind,proof,json!({"evidence":"body","bodyOperations":[{"operationId":operation.id,"callableId":operation.owner,"registeredOwner":owner,"deferred":operation.deferred||deferred,"scope":operation.scope,"conditions":conditions,"callChain":call_chain,"callChainScope":"representative-static-path"}]}));
            }
        }
    }
    eprintln!(
        "Architecture model: projected {} relations; assembling {} entity templates",
        model.relations.len(),
        entities.len()
    );
    for entity in entities {
        let id = identifier("entity", &entity.id);
        let sources = model.source(&entity.source, "create");
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
        let (description, summary) = model.purpose(
            &key,
            &name,
            "Entity",
            &digest(serde_json::to_vec(&entity)?),
            "",
            &sources,
        );
        model.objects.insert(id.clone(),json!({"id":id,"name":name,"kind":"Entity","feature":feature,"description":description,"display_summary":summary,"sourceEntries":sources,"sourceGaps":entity.gaps.iter().map(|gap|gap.reason.clone()).collect::<Vec<_>>() }));
        let assembly_sources = model.source(&entity.source, "create");
        if let Some(owners) = callable_objects.get(&entity.creator) {
            for owner in owners {
                model.link(
                    owner,
                    &id,
                    "create",
                    "创建模板",
                    assembly_sources.clone(),
                    json!({"evidence":"assembly"}),
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
                    json!({"evidence":"assembly","explicit":entity.components.contains(component_type),"required":entity.required_components.contains(component_type)}),
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
                json!({"evidence":"assembly"}),
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
    for (path, hash) in &fact_sources {
        ensure!(
            digest(fs::read(path)?) == *hash,
            "Compiler fact source changed during model generation: {path}"
        );
    }
    fs::create_dir_all(output_parent)?;
    let pending = model.pending.into_values().collect::<Vec<_>>();
    let result = json!({"schemaVersion":1,"compiler":bundle.compiler,"configuration":bundle.configuration,
        "runtimeDirectory":runtime_directory,"inputs":{"sourceFingerprint":runtime_data.source_fingerprint,"factsSha256":facts_hash,"runtimeSha256":digest(&runtime_bytes)},
        "objects":model.objects.into_values().collect::<Vec<_>>(),"relations":model.relations.into_values().collect::<Vec<_>>(),"features":model.features.into_values().collect::<Vec<_>>(),
        "sourceFiles":model.source_cache.snapshots.into_values().collect::<Vec<_>>(),"callGraph":call_graph,"scheduleInteractions":{"schemaVersion":1,"views":bindings},"schedulePluginCatalog":group_catalog.into_values().collect::<Vec<_>>(),"schedulePluginGroups":schedule_groups,
        "annotationsRequired":pending,"bindingErrors":model.fatal,"analysisGaps":unique(analysis_gaps)});
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
