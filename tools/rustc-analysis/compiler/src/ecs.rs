//! 从 rustc 的声明、类型检查结果和 MIR 提取事实；显示名不参与身份解析。
use crate::identity::Identities;
use analysis_contract::facts::*;
use anyhow::Result;
use rustc_ast::BinOpKind;
use rustc_hir::{
    Expr, ExprKind, UnOp,
    def::DefKind,
    def_id::{CRATE_DEF_ID, DefId, LOCAL_CRATE},
    intravisit::{self, Visitor},
};
use rustc_infer::infer::TyCtxtInferExt;
use rustc_middle::{
    middle::exported_symbols::ExportedSymbol,
    mir::{Body, Place, PlaceRef, ProjectionElem, StatementKind, TerminatorKind},
    mono::MonoItem,
    ty::{self, GenericArgsRef, Instance, Ty, TyCtxt, TypeVisitableExt, TypeckResults, TypingEnv},
};
use rustc_span::Span;
use rustc_trait_selection::infer::InferCtxtExt;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fs,
};

const TRAITS: &[(&str, &str)] = &[
    ("bevy_ecs::component::Component", "Component"),
    ("bevy_ecs::resource::Resource", "Resource"),
    ("bevy_ecs::message::Message", "Message"),
    ("bevy_ecs::event::Event", "Event"),
    ("bevy_ecs::event::EventPattern", "EventPattern"),
    ("bevy_ecs::event::EntityEvent", "EntityEvent"),
    ("bevy_ecs::bundle::Bundle", "Bundle"),
    ("bevy_ecs::system::system_param::SystemParam", "SystemParam"),
    ("bevy_ecs::system::system::System", "System"),
    ("bevy_ecs::query::fetch::QueryData", "QueryData"),
    ("bevy_ecs::query::world_query::WorldQuery", "WorldQuery"),
    ("bevy_ecs::query::filter::QueryFilter", "QueryFilter"),
    ("bevy_ecs::schedule::set::SystemSet", "SystemSet"),
    ("bevy_ecs::schedule::set::ScheduleLabel", "ScheduleLabel"),
    ("bevy_ecs::relationship::Relationship", "Relationship"),
    (
        "bevy_ecs::relationship::RelationshipTarget",
        "RelationshipTarget",
    ),
    ("bevy_scene::scene::Scene", "Scene"),
    ("bevy_scene::scene_list::SceneList", "SceneList"),
    ("bevy_ecs::template::Template", "Template"),
    ("bevy_app::plugin::Plugin", "Plugin"),
    ("bevy_app::plugin_group::PluginGroup", "PluginGroup"),
];

pub const SOURCE_PREVIEW_CHAR_LIMIT: usize = 512;

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn full_path(tcx: TyCtxt<'_>, id: DefId) -> String {
    format!(
        "{}{}",
        tcx.crate_name(id.krate),
        tcx.def_path(id).to_string_no_crate_verbose()
    )
}

fn alias_definition(alias: ty::AliasTy<'_>) -> DefId {
    match alias.kind {
        ty::AliasTyKind::Projection { def_id }
        | ty::AliasTyKind::Inherent { def_id }
        | ty::AliasTyKind::Opaque { def_id }
        | ty::AliasTyKind::Free { def_id } => def_id,
    }
}

/// 每个实际编译单元独立产生报告；条件编译和宏处理完全由当前编译器负责。
pub fn extract(tcx: TyCtxt<'_>) -> Result<UnitFacts> {
    extract_with_origins(tcx, &[])
}

pub fn extract_with_origins(
    tcx: TyCtxt<'_>,
    origins: &[analysis_contract::PackageOrigin],
) -> Result<UnitFacts> {
    let traits = tcx
        .all_traits_including_private()
        .filter_map(|id| {
            let path = full_path(tcx, id);
            TRAITS
                .iter()
                .find(|(expected, _)| *expected == path)
                .map(|(_, role)| (id, *role))
        })
        .collect();
    let mut collector = Collector {
        tcx,
        identities: Identities::new(tcx, origins)?,
        declarations: BTreeMap::new(),
        types: BTreeMap::new(),
        callables: BTreeMap::new(),
        trait_ids: traits,
        role_cache: HashMap::new(),
        generic_owner: CRATE_DEF_ID.to_def_id(),
        source_files: BTreeMap::new(),
        source_fingerprints: HashMap::new(),
        hir_call_conditions: HashMap::new(),
        hir_operation_templates: HashMap::new(),
        facts: UnitFacts {
            schema_version: FACT_SCHEMA_VERSION,
            crate_name: tcx.crate_name(LOCAL_CRATE).to_string(),
            crate_identity: format!("{:?}", tcx.stable_crate_id(LOCAL_CRATE)),
            ..UnitFacts::default()
        },
        pending: VecDeque::new(),
        mir_seen: HashSet::new(),
        runtime_roots: HashSet::new(),
        assignments: HashMap::new(),
        bundle_engine: crate::entity::analysis::resolver(tcx, true),
    };
    if collector.trait_ids.is_empty() && std::env::var_os("CARGO_PRIMARY_PACKAGE").is_none() {
        for file in tcx.sess.source_map().files().iter() {
            collector.fingerprint(&file.name.prefer_local_unconditionally().to_string());
        }
        collector.facts.source_files = collector
            .source_files
            .into_iter()
            .map(|(path, sha256)| SourceFile { path, sha256 })
            .collect();
        collector.facts.gaps.extend(collector.identities.gaps());
        return Ok(collector.facts);
    }
    // HIR 是当前 crate 的真实声明，不扫描未加载的目录或未启用的文件。
    for item in tcx.hir_crate_items(()).definitions() {
        let id = item.to_def_id();
        collector.generic_owner = id;
        collector.declaration(id);
        if matches!(
            tcx.def_kind(id),
            DefKind::Struct | DefKind::Enum | DefKind::Union | DefKind::TyAlias
        ) {
            let env = TypingEnv::post_analysis(tcx, id);
            let ty =
                collector.normalize(tcx.type_of(id).instantiate_identity().skip_norm_wip(), env);
            collector.type_id(ty, env, 0);
        }
    }
    for owner in tcx.hir_body_owners() {
        let id = owner.to_def_id();
        collector.generic_owner = id;
        if !matches!(
            tcx.def_kind(id),
            DefKind::Fn | DefKind::AssocFn | DefKind::Closure
        ) {
            continue;
        }
        let env = TypingEnv::post_analysis(tcx, id);
        let args = if tcx.def_kind(id) == DefKind::Closure {
            match collector
                .normalize(tcx.type_of(id).instantiate_identity().skip_norm_wip(), env)
                .kind()
            {
                ty::Closure(_, args) => *args,
                _ => continue,
            }
        } else {
            ty::GenericArgs::identity_for_item(tcx, id)
        };
        let callable = collector.callable(id, args, env);
        let types = tcx.typeck(owner);
        let body = tcx.hir_body_owned_by(owner);
        BodyVisitor {
            collector: &mut collector,
            types,
            env,
            owner: callable.clone(),
            definition: id,
            deferred: false,
            existence_check: false,
            conditions: vec![],
        }
        .visit_body(body);
        if !args.has_non_region_param() {
            collector
                .pending
                .push_back((Instance::new_raw(id, args), 0));
        }
    }
    collector.index_hir_templates();
    collector.seed_native_system_instances();
    collector.collect_mir_instances();
    collector.collect_entity_templates()?;
    // include!、过程宏实际加载的文件也参与内容指纹，不能只枚举 src/。
    for file in tcx.sess.source_map().files().iter() {
        let filename = file.name.prefer_local_unconditionally().to_string();
        collector.fingerprint(&filename);
    }
    collector.facts.source_files = collector
        .source_files
        .into_iter()
        .map(|(path, sha256)| SourceFile { path, sha256 })
        .collect();
    collector.facts.declarations = collector.declarations.into_values().collect();
    collector.facts.types = collector.types.into_values().collect();
    collector.facts.callables = collector.callables.into_values().collect();
    collector.facts.gaps.extend(collector.identities.gaps());
    sort_facts(&mut collector.facts);
    compact_source_previews(&mut collector.facts);
    Ok(collector.facts)
}

// snippet 只作为展示预览：完整证据由文件 SHA 与跨度定位。
// 所有条件字段与守卫原文完整保留；其余片段最多 512 个 Unicode 标量值。
fn compact_source_previews(facts: &mut UnitFacts) {
    fn source(source: &mut SourceEvidence) {
        if matches!(
            source.role.as_str(),
            "condition" | "unless" | "match-value" | "match-arm"
        ) {
            return;
        }
        if let Some((end, _)) = source.snippet.char_indices().nth(SOURCE_PREVIEW_CHAR_LIMIT) {
            source.snippet.truncate(end);
        }
    }
    fn optional(evidence: &mut Option<SourceEvidence>) {
        if let Some(evidence) = evidence {
            source(evidence);
        }
    }
    for declaration in &mut facts.declarations {
        optional(&mut declaration.source);
    }
    for instance in &mut facts.types {
        for field in &mut instance.fields {
            optional(&mut field.source);
        }
    }
    for callable in &mut facts.callables {
        for parameter in &mut callable.parameters {
            optional(&mut parameter.source);
        }
    }
    for access in &mut facts.accesses {
        optional(&mut access.source);
    }
    for operation in &mut facts.operations {
        optional(&mut operation.source);
        for evidence in &mut operation.call_chain {
            source(evidence);
        }
    }
    for call in &mut facts.calls {
        optional(&mut call.source);
    }
    for entity in &mut facts.entities {
        optional(&mut entity.source);
        for evidence in &mut entity.source_evidence {
            source(evidence);
        }
        for group in &mut entity.alternatives {
            optional(&mut group.source);
        }
        for gap in &mut entity.gaps {
            optional(&mut gap.source);
        }
    }
    for registration in &mut facts.registrations {
        optional(&mut registration.source);
    }
    for gap in &mut facts.gaps {
        optional(&mut gap.source);
    }
}

fn sort_facts(facts: &mut UnitFacts) {
    facts.accesses.sort_by_key(|fact| {
        (
            fact.owner.clone(),
            fact.parameter.clone(),
            fact.type_id.clone(),
            fact.mode.clone(),
            fact.scope.clone(),
        )
    });
    facts.accesses.dedup_by(|a, b| {
        a.owner == b.owner
            && a.parameter == b.parameter
            && a.type_id == b.type_id
            && a.mode == b.mode
            && a.scope == b.scope
    });
    facts.operations.sort_by(|a, b| a.id.cmp(&b.id));
    facts.operations.dedup_by(|a, b| a.id == b.id);
    facts.calls.sort_by_key(|fact| {
        (
            fact.caller.clone(),
            fact.callee.clone(),
            fact.declaration.clone(),
            fact.unresolved_reason.clone(),
            fact.source
                .as_ref()
                .map(|s| (s.path.clone(), s.line, s.column)),
        )
    });
    facts.calls.dedup_by(|a, b| {
        a.caller == b.caller
            && a.callee == b.callee
            && a.declaration == b.declaration
            && a.unresolved_reason == b.unresolved_reason
            && a.source == b.source
            && a.deferred == b.deferred
            && a.conditions == b.conditions
    });
    facts.entities.sort_by(|a, b| a.id.cmp(&b.id));
    facts.entities.dedup_by(|a, b| a.id == b.id);
    facts
        .gaps
        .sort_by_key(|gap| (gap.owner.clone(), gap.kind.clone(), gap.reason.clone()));
    facts.gaps.dedup_by(|a, b| {
        a.owner == b.owner && a.kind == b.kind && a.reason == b.reason && a.source == b.source
    });
}

struct Collector<'tcx> {
    tcx: TyCtxt<'tcx>,
    identities: Identities<'tcx>,
    declarations: BTreeMap<String, Declaration>,
    types: BTreeMap<String, TypeInstance>,
    callables: BTreeMap<String, Callable>,
    trait_ids: Vec<(DefId, &'static str)>,
    role_cache: HashMap<(Ty<'tcx>, TypingEnv<'tcx>), Vec<String>>,
    generic_owner: DefId,
    source_files: BTreeMap<String, String>,
    source_fingerprints: HashMap<String, Option<(String, String)>>,
    hir_call_conditions: HashMap<HirSiteKey, Vec<SourceEvidence>>,
    hir_operation_templates: HashMap<HirSiteKey, HirOperationTemplate>,
    facts: UnitFacts,
    pending: VecDeque<(Instance<'tcx>, usize)>,
    mir_seen: HashSet<Instance<'tcx>>,
    runtime_roots: HashSet<Instance<'tcx>>,
    assignments: HashMap<DefId, Vec<AssignmentEvidence>>,
    bundle_engine: crate::entity::analysis::Engine<'tcx>,
}

type HirSiteKey = (String, String, String, usize, usize);

#[derive(Clone)]
struct HirOperationTemplate {
    is_filter: bool,
    conditions: Vec<SourceEvidence>,
}

#[derive(Clone)]
struct AssignmentEvidence {
    span: Span,
    conditions: Vec<SourceEvidence>,
    deferred: bool,
}

#[derive(Clone, Copy)]
enum ResolutionFailure {
    Unresolved,
    Virtual,
}

impl ResolutionFailure {
    fn kind(self) -> &'static str {
        match self {
            Self::Unresolved => "unresolved-call",
            Self::Virtual => "unresolved-dynamic-dispatch",
        }
    }
    fn reason(self) -> &'static str {
        match self {
            Self::Unresolved => "调用实例不能由当前 rustc 类型环境唯一解析，未连接到候选实现。",
            Self::Virtual => {
                "rustc 将调用解析为 Virtual：真实实现由运行时虚表选择，没有可查询的实例 MIR。"
            }
        }
    }
}

impl<'tcx> Collector<'tcx> {
    fn fingerprint(&mut self, filename: &str) -> Option<(String, String)> {
        if let Some(cached) = self.source_fingerprints.get(filename) {
            return cached.clone();
        }
        let fingerprint = self.read_fingerprint(filename);
        self.source_fingerprints
            .insert(filename.into(), fingerprint.clone());
        fingerprint
    }

    fn read_fingerprint(&mut self, filename: &str) -> Option<(String, String)> {
        let normalized = filename.replace('\\', "/");
        let absolute = fs::canonicalize(filename)
            .or_else(|error| {
                if let Some((_, library)) = normalized.split_once("/library/") {
                    let source = self
                        .tcx
                        .sess
                        .opts
                        .sysroot
                        .path()
                        .join("lib/rustlib/src/rust/library")
                        .join(library);
                    return fs::canonicalize(source);
                }
                Err(error)
            })
            .ok()?;
        let filename = absolute
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/");
        if let Some(hash) = self.source_files.get(&filename) {
            return Some((filename, hash.clone()));
        }
        let hash = digest(fs::read(absolute).ok()?);
        self.source_files.insert(filename.clone(), hash.clone());
        Some((filename, hash))
    }

    fn hir_site_key(
        &self,
        caller: &str,
        callee_declaration: &str,
        source: Option<&SourceEvidence>,
    ) -> Option<HirSiteKey> {
        let declaration = &self.callables.get(caller)?.declaration;
        let source = source?;
        Some((
            declaration.clone(),
            callee_declaration.into(),
            source.path.clone(),
            source.line,
            source.column,
        ))
    }

    // HIR 证据固定后建立索引；新生成的 MIR 事实不能反过来成为后续实例的证据。
    fn index_hir_templates(&mut self) {
        for call in &self.facts.calls {
            if let Some(declaration) = &call.declaration
                && let Some(key) =
                    self.hir_site_key(&call.caller, declaration, call.source.as_ref())
            {
                self.hir_call_conditions
                    .entry(key)
                    .or_insert_with(|| call.conditions.clone());
            }
        }
        for operation in &self.facts.operations {
            if let Some(key) = self.hir_site_key(
                &operation.owner,
                &operation.method,
                operation.source.as_ref(),
            ) {
                self.hir_operation_templates
                    .entry(key)
                    .or_insert_with(|| HirOperationTemplate {
                        is_filter: operation.kind == "filter",
                        conditions: operation.conditions.clone(),
                    });
            }
        }
    }

    fn native_system_self(
        &self,
        definition: DefId,
        args: GenericArgsRef<'tcx>,
        system_trait: DefId,
    ) -> Option<Ty<'tcx>> {
        if self.tcx.def_kind(definition) != DefKind::AssocFn {
            return None;
        }
        let trait_item = self
            .tcx
            .associated_item(definition)
            .trait_item_def_id()
            .unwrap_or(definition);
        if self.tcx.trait_of_assoc(trait_item) != Some(system_trait) {
            return None;
        }
        let env = TypingEnv::fully_monomorphized();
        let self_ty = if let Some(implementation) = self.tcx.impl_of_assoc(definition) {
            self.tcx
                .type_of(implementation)
                .instantiate(self.tcx, args)
                .skip_norm_wip()
        } else {
            args.types().next()?
        };
        let self_ty = self
            .tcx
            .erase_and_anonymize_regions(self.normalize(self_ty, env));
        (!self_ty.has_non_region_param() && !self_ty.has_aliases() && !self_ty.has_infer())
            .then_some(self_ty)
    }

    fn seed_native_system_instances(&mut self) {
        let Some(system_trait) = self
            .trait_ids
            .iter()
            .find(|(_, role)| *role == "System")
            .map(|(definition, _)| *definition)
        else {
            return;
        };
        if self
            .tcx
            .associated_items(system_trait)
            .in_definition_order()
            .next()
            .is_none()
        {
            return;
        }
        let mut systems = HashSet::new();
        // 只收集真实 System 方法实例的 Self；不把全部单态化函数当作分析入口。
        for unit in self.tcx.collect_and_partition_mono_items(()).codegen_units {
            for item in unit.items().keys() {
                if let MonoItem::Fn(instance) = item
                    && let Some(self_ty) =
                        self.native_system_self(instance.def_id(), instance.args, system_trait)
                {
                    systems.insert(self_ty);
                }
            }
        }
        // 已由上游生成并共享的实例不会出现在本地 CGU 中，直接读取编译器的导出实例元数据。
        for crate_number in self.tcx.crates(()).iter().copied() {
            for (symbol, _) in self.tcx.exported_generic_symbols(crate_number) {
                if let ExportedSymbol::Generic(definition, args) = symbol
                    && let Some(self_ty) = self.native_system_self(*definition, args, system_trait)
                {
                    systems.insert(self_ty);
                }
            }
        }
        let mut systems: Vec<_> = systems.into_iter().collect();
        systems.sort_by_cached_key(|self_ty| self.type_key(*self_ty, 0));
        for self_ty in systems {
            self.type_id(self_ty, TypingEnv::fully_monomorphized(), 0);
        }
    }

    fn source(&mut self, span: Span, role: &str) -> Option<SourceEvidence> {
        self.source_at(span, span.source_callsite(), role)
    }

    fn source_at(&mut self, span: Span, site: Span, role: &str) -> Option<SourceEvidence> {
        if span.is_dummy() {
            return None;
        }
        let map = self.tcx.sess.source_map();
        let start = map.lookup_char_pos(site.lo());
        let end = map.lookup_char_pos(site.hi());
        let filename = start.file.name.prefer_local_unconditionally().to_string();
        let (path, sha256) = self
            .fingerprint(&filename)
            .unwrap_or_else(|| (filename.replace('\\', "/"), String::new()));
        let expansions = span
            .macro_backtrace()
            .map(|entry| {
                let point = map.lookup_char_pos(entry.call_site.source_callsite().lo());
                Expansion {
                    name: entry.kind.descr().to_string(),
                    path: point
                        .file
                        .name
                        .prefer_local_unconditionally()
                        .to_string()
                        .replace('\\', "/"),
                    line: point.line,
                    column: point.col_display + 1,
                }
            })
            .collect();
        Some(SourceEvidence {
            path,
            line: start.line,
            column: start.col_display + 1,
            end_line: end.line,
            end_column: end.col_display + 1,
            role: role.into(),
            sha256,
            snippet: map.span_to_snippet(site).unwrap_or_default(),
            expansions,
        })
    }

    fn declaration(&mut self, id: DefId) -> String {
        let key = format!("decl-{}", self.identities.definition(id));
        if self.declarations.contains_key(&key) {
            return key;
        }
        let span = if let Some(local) = id.as_local()
            && self.tcx.def_kind(id) != DefKind::SyntheticCoroutineBody
        {
            let hir_id = self.tcx.local_def_id_to_hir_id(local);
            if matches!(self.tcx.hir_node(hir_id), rustc_hir::Node::Synthetic) {
                self.tcx.def_span(id)
            } else {
                self.tcx.hir_span_with_body(hir_id)
            }
        } else {
            self.tcx.def_span(id)
        };
        let source = self.source(span, "definition");
        let full_name = full_path(self.tcx, id);
        self.declarations.insert(
            key.clone(),
            Declaration {
                id: key.clone(),
                local: id.is_local(),
                name: self
                    .tcx
                    .opt_item_name(id)
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| full_name.rsplit("::").next().unwrap_or(&full_name).into()),
                full_name,
                crate_name: self.tcx.crate_name(id.krate).to_string(),
                kind: format!("{:?}", self.tcx.def_kind(id)),
                source,
            },
        );
        key
    }

    fn roles(&mut self, ty: Ty<'tcx>, env: TypingEnv<'tcx>) -> Vec<String> {
        if ty.has_escaping_bound_vars() {
            return vec![];
        }
        if let Some(roles) = self.role_cache.get(&(ty, env)) {
            return roles.clone();
        }
        let mut roles = vec![];
        // 函数、引用和原始指针不是组件声明；避免对每个临时借用重复运行 trait solver。
        if matches!(
            ty.kind(),
            ty::Adt(..) | ty::Tuple(_) | ty::Param(_) | ty::Alias(..)
        ) {
            let (context, parameter_env) = self.tcx.infer_ctxt().build_with_typing_env(env);
            for (id, role) in &self.trait_ids {
                if context
                    .type_implements_trait(*id, [ty], parameter_env)
                    .must_apply_modulo_regions()
                {
                    roles.push((*role).into());
                }
            }
        }
        self.role_cache.insert((ty, env), roles.clone());
        roles
    }

    fn normalize(&self, ty: Ty<'tcx>, env: TypingEnv<'tcx>) -> Ty<'tcx> {
        self.tcx
            .try_normalize_erasing_regions(env, ty::Unnormalized::new_wip(ty))
            .unwrap_or(ty)
    }

    fn resolve_instance(
        &self,
        id: DefId,
        args: GenericArgsRef<'tcx>,
        env: TypingEnv<'tcx>,
    ) -> std::result::Result<Instance<'tcx>, ResolutionFailure> {
        let args = self
            .tcx
            .try_normalize_erasing_regions(env, ty::Unnormalized::new_wip(args))
            .map_err(|_| ResolutionFailure::Unresolved)?;
        if args.has_escaping_bound_vars() || args.has_infer() {
            return Err(ResolutionFailure::Unresolved);
        }
        let instance = Instance::try_resolve(self.tcx, env, id, args)
            .ok()
            .flatten()
            .ok_or(ResolutionFailure::Unresolved)?;
        if matches!(instance.def, ty::InstanceKind::Virtual(..)) {
            return Err(ResolutionFailure::Virtual);
        }
        Ok(instance)
    }

    fn arguments(
        &mut self,
        args: GenericArgsRef<'tcx>,
        env: TypingEnv<'tcx>,
        depth: usize,
    ) -> Vec<TypeArgument> {
        args.iter()
            .filter_map(|arg| match arg.kind() {
                ty::GenericArgKind::Type(ty) => Some(TypeArgument {
                    kind: "type".into(),
                    value: self.type_id(ty, env, depth + 1),
                }),
                ty::GenericArgKind::Const(value) => Some(TypeArgument {
                    kind: "const".into(),
                    value: value.to_string(),
                }),
                ty::GenericArgKind::Lifetime(_) => None,
            })
            .collect()
    }

    fn type_id(&mut self, raw: Ty<'tcx>, env: TypingEnv<'tcx>, depth: usize) -> String {
        let ty = self
            .tcx
            .erase_and_anonymize_regions(self.normalize(raw, env));
        let structural = self.type_key(ty, 0);
        let key = format!("type-{}", digest(structural));
        if self.types.contains_key(&key) {
            return key;
        }
        let declaration = match ty.kind() {
            ty::Adt(adt, _) => Some(self.declaration(adt.did())),
            ty::FnDef(id, _) | ty::Closure(id, _) => Some(self.declaration(*id)),
            ty::Alias(_, alias) => Some(self.declaration(alias_definition(*alias))),
            _ => None,
        };
        let roles = self.roles(ty, env);
        let runtime_type_id = if !ty.has_non_region_param() && !ty.has_aliases() && !ty.has_infer()
        {
            Some(format!(
                "TypeId(0x{:032x})",
                self.tcx.type_id_hash(ty).as_u128()
            ))
        } else {
            None
        };
        self.types.insert(
            key.clone(),
            TypeInstance {
                id: key.clone(),
                declaration,
                display: ty.to_string(),
                kind: match ty.kind() {
                    ty::Adt(..) => "adt",
                    ty::FnDef(..) => "function",
                    ty::Closure(..) => "closure",
                    ty::Ref(..) => "reference",
                    ty::Tuple(..) => "tuple",
                    ty::Array(..) => "array",
                    ty::Slice(..) => "slice",
                    ty::Alias(..) => "projection",
                    ty::Param(_) => "parameter",
                    ty::Dynamic(..) => "dynamic",
                    _ => "value",
                }
                .into(),
                roles: roles.clone(),
                runtime_type_id: runtime_type_id.clone(),
                ..TypeInstance::default()
            },
        );
        if depth >= 24 {
            self.gap(
                &key,
                "type-recursion",
                "类型结构达到递归预算，未继续展开字段。",
                None,
            );
            return key;
        }
        let args = match ty.kind() {
            ty::Adt(_, args) | ty::Closure(_, args) => self.arguments(args, env, depth),
            ty::FnDef(_, args) => self.arguments(
                self.tcx.instantiate_bound_regions_with_erased(*args),
                env,
                depth,
            ),
            ty::Alias(_, alias) => self.arguments(alias.args, env, depth),
            ty::Ref(_, inner, _) | ty::Slice(inner) | ty::Array(inner, _) => vec![TypeArgument {
                kind: "type".into(),
                value: self.type_id(*inner, env, depth + 1),
            }],
            ty::Tuple(types) => types
                .iter()
                .map(|item| TypeArgument {
                    kind: "type".into(),
                    value: self.type_id(item, env, depth + 1),
                })
                .collect(),
            _ => vec![],
        };
        let mut fields = vec![];
        if let ty::Adt(adt, args) = ty.kind()
            && (adt.did().is_local()
                || roles.iter().any(|r| {
                    matches!(r.as_str(), "SystemParam" | "QueryData" | "Bundle" | "Scene")
                }))
        {
            for variant in adt.variants() {
                for field in &variant.fields {
                    let field_ty = self.normalize(field.ty(self.tcx, args).skip_norm_wip(), env);
                    let field_id = self.type_id(field_ty, env, depth + 1);
                    fields.push(TypeField {
                        name: if adt.is_enum() {
                            format!("{}::{}", variant.name, field.name)
                        } else {
                            field.name.to_string()
                        },
                        type_id: field_id,
                        source: self.source(self.tcx.def_span(field.did), "field"),
                    });
                }
            }
        }
        if let Some(record) = self.types.get_mut(&key) {
            record.arguments = args;
            record.fields = fields;
        }
        if roles.iter().any(|role| role == "System")
            && let Some(runtime) = runtime_type_id
        {
            let mut functions = self.function_types(ty, 0);
            if functions.is_empty()
                && let Some((trait_id, _)) =
                    self.trait_ids.iter().find(|(_, role)| *role == "System")
                && let Some(method) = self
                    .tcx
                    .associated_items(*trait_id)
                    .in_definition_order()
                    .find(|item| {
                        item.opt_name()
                            .is_some_and(|name| name.as_str() == "run_unsafe")
                    })
                && let Ok(instance) =
                    self.resolve_instance(method.def_id, self.tcx.mk_args(&[ty.into()]), env)
            {
                functions.push((instance.def_id(), instance.args));
            }
            for (id, args) in functions {
                let callable = self.callable(id, args, env);
                let record = self.callables.get_mut(&callable).unwrap();
                if !record.system_type_ids.contains(&runtime) {
                    record.system_type_ids.push(runtime.clone());
                }
                if !args.has_non_region_param()
                    && let Ok(instance) = self.resolve_instance(id, args, env)
                    && self.runtime_roots.insert(instance)
                {
                    self.pending.push_front((instance, 0));
                }
            }
        }
        key
    }

    fn type_key(&self, ty: Ty<'tcx>, depth: usize) -> String {
        if depth >= 40 {
            return format!("recursive:{ty:?}");
        }
        let arguments = |args: GenericArgsRef<'tcx>| {
            args.iter()
                .filter_map(|arg| match arg.kind() {
                    ty::GenericArgKind::Type(value) => Some(self.type_key(value, depth + 1)),
                    ty::GenericArgKind::Const(value) => Some(format!("const:{value}")),
                    ty::GenericArgKind::Lifetime(_) => None,
                })
                .collect::<Vec<_>>()
                .join(",")
        };
        let structure = match ty.kind() {
            ty::Adt(adt, args) => format!(
                "{:?}<{}>",
                self.identities.definition(adt.did()),
                arguments(args)
            ),
            ty::Closure(id, args) => {
                format!("{:?}<{}>", self.identities.definition(*id), arguments(args))
            }
            ty::FnDef(id, args) => format!(
                "{:?}<{}>",
                self.identities.definition(*id),
                arguments(self.tcx.instantiate_bound_regions_with_erased(*args))
            ),
            ty::Alias(kind, alias) => format!(
                "{kind:?}:{:?}<{}>",
                self.identities.definition(alias_definition(*alias)),
                arguments(alias.args)
            ),
            ty::Ref(_, inner, mutability) => {
                format!("&{mutability:?}{}", self.type_key(*inner, depth + 1))
            }
            ty::RawPtr(inner, mutability) => {
                format!("*{mutability:?}{}", self.type_key(*inner, depth + 1))
            }
            ty::Tuple(items) => format!(
                "({})",
                items
                    .iter()
                    .map(|item| self.type_key(item, depth + 1))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            ty::Array(inner, length) => format!("[{};{length}]", self.type_key(*inner, depth + 1)),
            ty::Slice(inner) => format!("[{}]", self.type_key(*inner, depth + 1)),
            _ => format!("{ty:?}"),
        };
        if ty.has_non_region_param() {
            format!(
                "{structure}@{:?}",
                self.identities.definition(self.generic_owner)
            )
        } else {
            structure
        }
    }

    fn function_types(&self, ty: Ty<'tcx>, depth: usize) -> Vec<(DefId, GenericArgsRef<'tcx>)> {
        if depth >= 24 {
            return vec![];
        }
        match ty.kind() {
            ty::FnDef(id, args) => {
                vec![(*id, self.tcx.instantiate_bound_regions_with_erased(*args))]
            }
            ty::Closure(id, args) => vec![(*id, args)],
            ty::Adt(_, args) => args
                .types()
                .flat_map(|ty| self.function_types(ty, depth + 1))
                .collect(),
            ty::Tuple(items) => items
                .iter()
                .flat_map(|ty| self.function_types(ty, depth + 1))
                .collect(),
            ty::Ref(_, ty, _) | ty::Slice(ty) | ty::Array(ty, _) => {
                self.function_types(*ty, depth + 1)
            }
            _ => vec![],
        }
    }

    fn callable(&mut self, id: DefId, args: GenericArgsRef<'tcx>, env: TypingEnv<'tcx>) -> String {
        let declaration = self.declaration(id);
        let arg_key = args
            .iter()
            .filter_map(|arg| match arg.kind() {
                ty::GenericArgKind::Type(value) => Some(self.type_key(value, 0)),
                ty::GenericArgKind::Const(value) => Some(format!("const:{value}")),
                ty::GenericArgKind::Lifetime(_) => None,
            })
            .collect::<Vec<_>>()
            .join(",");
        let key = format!("callable-{}", digest(format!("{declaration}<{arg_key}>")));
        if self.callables.contains_key(&key) {
            return key;
        }
        self.callables.insert(
            key.clone(),
            Callable {
                id: key.clone(),
                declaration,
                display: full_path(self.tcx, id),
                ..Callable::default()
            },
        );
        let arguments = self.arguments(args, env, 0);
        let (inputs, output) = if self.tcx.def_kind(id) == DefKind::Closure {
            let sig = self
                .tcx
                .instantiate_bound_regions_with_erased(args.as_closure().sig());
            (sig.inputs().to_vec(), sig.output())
        } else {
            let signature = self
                .tcx
                .fn_sig(id)
                .instantiate(self.tcx, args)
                .skip_norm_wip();
            let signature = self
                .tcx
                .try_normalize_erasing_regions(env, ty::Unnormalized::new_wip(signature))
                .unwrap_or(signature);
            let signature = self.tcx.instantiate_bound_regions_with_erased(signature);
            (signature.inputs().to_vec(), signature.output())
        };
        let parameters = inputs
            .iter()
            .enumerate()
            .map(|(index, ty)| {
                let slot = id
                    .as_local()
                    .and_then(|local| self.tcx.hir_maybe_body_owned_by(local))
                    .and_then(|body| body.params.get(index))
                    .and_then(|param| match param.pat.kind {
                        rustc_hir::PatKind::Binding(_, _, ident, _) => Some(ident.name.to_string()),
                        _ => None,
                    })
                    .unwrap_or_else(|| format!("arg{index}"));
                let source = id
                    .as_local()
                    .and_then(|local| self.tcx.hir_maybe_body_owned_by(local))
                    .and_then(|body| body.params.get(index))
                    .and_then(|param| self.source(param.span, "parameter"));
                let type_id = self.type_id(*ty, env, 0);
                self.parameter_accesses(
                    &key,
                    *ty,
                    env,
                    &slot,
                    "parameter",
                    "current",
                    source.clone(),
                    0,
                );
                Parameter {
                    slot,
                    type_id,
                    source,
                }
            })
            .collect();
        let output = self.type_id(output, env, 0);
        let runtime_type_id = if !args.has_non_region_param()
            && !args.has_aliases()
            && !args.has_infer()
            && !args.has_escaping_bound_vars()
            && self.tcx.def_kind(id) != DefKind::Closure
        {
            let ty = Ty::new_fn_def(self.tcx, id, ty::Binder::dummy(args));
            Some(format!(
                "TypeId(0x{:032x})",
                self.tcx.type_id_hash(ty).as_u128()
            ))
        } else {
            None
        };
        let record = self.callables.get_mut(&key).unwrap();
        record.arguments = arguments;
        record.parameters = parameters;
        record.output = output;
        record.runtime_type_id = runtime_type_id;
        key
    }

    fn parameter_accesses(
        &mut self,
        owner: &str,
        ty: Ty<'tcx>,
        env: TypingEnv<'tcx>,
        slot: &str,
        mode: &str,
        scope: &str,
        source: Option<SourceEvidence>,
        depth: usize,
    ) {
        let ty = self
            .tcx
            .erase_and_anonymize_regions(self.normalize(ty, env));
        if depth >= 16 {
            self.gap(
                owner,
                "parameter-recursion",
                &format!("参数 {slot} 未能在预算内展开。"),
                source,
            );
            return;
        }
        if let ty::Ref(_, inner, mutability) = ty.kind() {
            if mode == "query" {
                self.access(
                    owner,
                    *inner,
                    env,
                    if mutability.is_mut() {
                        "mutable_access"
                    } else {
                        "read"
                    },
                    "Component",
                    scope,
                    slot,
                    source,
                );
            }
            return;
        }
        if let ty::Tuple(items) = ty.kind() {
            for (index, item) in items.iter().enumerate() {
                self.parameter_accesses(
                    owner,
                    item,
                    env,
                    &format!("{slot}.{index}"),
                    mode,
                    scope,
                    source.clone(),
                    depth + 1,
                );
            }
            return;
        }
        let ty::Adt(adt, args) = ty.kind() else {
            return;
        };
        let path = full_path(self.tcx, adt.did());
        let generic: Vec<_> = args.types().collect();
        let first = generic.first().copied();
        let recurse = |this: &mut Self, next_mode: &str, next_scope: &str| {
            for (index, item) in generic.iter().enumerate() {
                this.parameter_accesses(
                    owner,
                    *item,
                    env,
                    &format!("{slot}.{index}"),
                    next_mode,
                    next_scope,
                    source.clone(),
                    depth + 1,
                );
            }
        };
        match path.as_str() {
            "core::option::Option"
            | "core::result::Result"
            | "bevy_ecs::system::system_param::ParamSet" => recurse(self, mode, scope),
            "bevy_ecs::system::query::Query"
            | "bevy_ecs::system::query::Single"
            | "bevy_ecs::system::query::Populated" => {
                if let Some(data) = first {
                    self.parameter_accesses(
                        owner,
                        data,
                        env,
                        &format!("{slot}.data"),
                        "query",
                        scope,
                        source.clone(),
                        depth + 1,
                    );
                }
                if let Some(filter) = generic.get(1) {
                    self.parameter_accesses(
                        owner,
                        *filter,
                        env,
                        &format!("{slot}.filter"),
                        "filter",
                        scope,
                        source,
                        depth + 1,
                    );
                }
            }
            "bevy_ecs::query::filter::With"
            | "bevy_ecs::query::filter::Without"
            | "bevy_ecs::query::filter::Added"
            | "bevy_ecs::query::filter::Changed"
            | "bevy_ecs::query::fetch::Has" => {
                if let Some(component) = first {
                    self.access(
                        owner,
                        component,
                        env,
                        "filter",
                        "Component",
                        scope,
                        slot,
                        source,
                    );
                }
            }
            "bevy_ecs::query::filter::Or" | "bevy_ecs::query::fetch::AnyOf" => {
                recurse(self, mode, scope)
            }
            "bevy_ecs::change_detection::params::Res"
            | "bevy_ecs::change_detection::params::ResMut"
            | "bevy_ecs::change_detection::params::NonSend"
            | "bevy_ecs::change_detection::params::NonSendMut"
            | "bevy_ecs::system::system_param::Local" => {
                let storage = if path.ends_with("::Local") {
                    "Local"
                } else if path.contains("::NonSend") {
                    "NonSend"
                } else {
                    "Resource"
                };
                if let Some(resource) = first {
                    self.access(
                        owner,
                        resource,
                        env,
                        if path.ends_with("Mut") || path.ends_with("::Local") {
                            "mutable_access"
                        } else {
                            "read"
                        },
                        storage,
                        scope,
                        slot,
                        source,
                    );
                }
            }
            "bevy_ecs::change_detection::params::Ref"
            | "bevy_ecs::change_detection::params::Mut" => {
                if let Some(component) = first {
                    self.access(
                        owner,
                        component,
                        env,
                        if path.ends_with("::Mut") {
                            "mutable_access"
                        } else {
                            "read"
                        },
                        "Component",
                        scope,
                        slot,
                        source,
                    );
                }
            }
            "bevy_extract::extract_param::Extract" => recurse(self, mode, "main"),
            "bevy_ecs::message::message_reader::MessageReader"
            | "bevy_ecs::message::message_writer::MessageWriter"
            | "bevy_ecs::message::message_mutator::MessageMutator" => {
                if let Some(message) = first {
                    self.access(
                        owner,
                        message,
                        env,
                        if path.ends_with("Reader") {
                            "read"
                        } else {
                            "mutable_access"
                        },
                        "Message",
                        scope,
                        slot,
                        source,
                    );
                }
            }
            "bevy_ecs::observer::system_param::On" => {
                if let Some(pattern) = first {
                    let event = self
                        .trait_ids
                        .iter()
                        .find(|(_, role)| *role == "EventPattern")
                        .and_then(|(trait_id, _)| {
                            self.tcx
                                .associated_items(*trait_id)
                                .in_definition_order()
                                .find(|item| {
                                    item.opt_name().is_some_and(|name| name.as_str() == "Event")
                                })
                        })
                        .map(|item| {
                            Ty::new_projection(self.tcx, ty::IsRigid::No, item.def_id, [pattern])
                        })
                        .map(|projection| self.normalize(projection, env));
                    let Some(event) =
                        event.filter(|event| !event.has_aliases() && !event.has_non_region_param())
                    else {
                        self.gap(
                            owner,
                            "event-pattern",
                            &format!("On 参数 {slot} 的 EventPattern::Event 无法具体化。"),
                            source,
                        );
                        return;
                    };
                    let storage = if self
                        .roles(event, env)
                        .iter()
                        .any(|role| role == "EntityEvent")
                    {
                        "EntityEvent"
                    } else {
                        "Event"
                    };
                    self.access(owner, event, env, "event", storage, scope, slot, source);
                }
            }
            _ => {
                let roles = self.roles(ty, env);
                if roles.iter().any(|role| {
                    matches!(role.as_str(), "SystemParam" | "QueryData" | "QueryFilter")
                }) {
                    let next_mode = if mode == "query" {
                        "query"
                    } else {
                        "parameter"
                    };
                    let protocol = if roles.iter().any(|role| role == "SystemParam") {
                        ("SystemParam", "init_access")
                    } else {
                        ("WorldQuery", "update_component_access")
                    };
                    let mut expanded = false;
                    if let Some((delegates, complete)) =
                        self.parameter_delegates(ty, env, protocol.0, protocol.1)
                    {
                        expanded = complete;
                        for (index, field_ty) in delegates.into_iter().enumerate() {
                            self.parameter_accesses(
                                owner,
                                field_ty,
                                env,
                                &format!("{slot}.{index}"),
                                next_mode,
                                scope,
                                source.clone(),
                                depth + 1,
                            );
                        }
                    }
                    if !expanded && !path.starts_with("bevy_ecs::system::commands::") {
                        self.gap(owner, "custom-parameter", &format!("参数 {slot} 的 {path} 需要其 SystemParam/WorldQuery 实现证据，未从存储字段猜测访问。"), source);
                    }
                }
            }
        }
    }

    fn parameter_delegates(
        &self,
        ty: Ty<'tcx>,
        env: TypingEnv<'tcx>,
        role: &str,
        method: &str,
    ) -> Option<(Vec<Ty<'tcx>>, bool)> {
        let trait_id = self
            .trait_ids
            .iter()
            .find(|(_, candidate)| *candidate == role)?
            .0;
        let definition = self
            .tcx
            .associated_items(trait_id)
            .in_definition_order()
            .find(|item| {
                self.tcx
                    .opt_item_name(item.def_id)
                    .is_some_and(|name| name.as_str() == method)
            })?
            .def_id;
        let args = self.tcx.mk_args(&[ty.into()]);
        let instance = self.resolve_instance(definition, args, env).ok()?;
        if !self.tcx.is_mir_available(instance.def_id()) {
            return None;
        }
        let body = self.tcx.instance_mir(instance.def);
        let mut delegates = vec![];
        let mut complete = true;
        for block in body.basic_blocks.iter() {
            if let TerminatorKind::Call { func, .. } = &block.terminator().kind {
                let function = self.normalize(
                    instance.instantiate_mir(
                        self.tcx,
                        ty::EarlyBinder::bind(self.tcx, func.ty(&body.local_decls, self.tcx)),
                    ),
                    env,
                );
                let ty::FnDef(callee, args) = function.kind() else {
                    complete = false;
                    continue;
                };
                let args = self.tcx.instantiate_bound_regions_with_erased(*args);
                let trait_item = (self.tcx.def_kind(*callee) == DefKind::AssocFn).then(|| {
                    self.tcx
                        .associated_item(*callee)
                        .trait_item_def_id()
                        .unwrap_or(*callee)
                });
                if trait_item == Some(definition) {
                    let delegate = if let Some(implementation) = self.tcx.impl_of_assoc(*callee) {
                        Some(
                            self.normalize(
                                self.tcx
                                    .type_of(implementation)
                                    .instantiate(self.tcx, args)
                                    .skip_norm_wip(),
                                env,
                            ),
                        )
                    } else {
                        args.types().next()
                    };
                    if let Some(delegate) = delegate {
                        if delegate != ty {
                            delegates.push(delegate);
                        } else {
                            complete = false;
                        }
                    }
                } else {
                    complete = false;
                }
            }
        }
        Some((delegates, complete))
    }

    fn access(
        &mut self,
        owner: &str,
        ty: Ty<'tcx>,
        env: TypingEnv<'tcx>,
        mode: &str,
        storage: &str,
        scope: &str,
        slot: &str,
        source: Option<SourceEvidence>,
    ) {
        let type_id = self.type_id(ty, env, 0);
        self.facts.accesses.push(AccessFact {
            owner: owner.into(),
            type_id,
            mode: mode.into(),
            storage: storage.into(),
            scope: scope.into(),
            parameter: slot.into(),
            source,
        });
    }

    fn gap(&mut self, owner: &str, kind: &str, reason: &str, source: Option<SourceEvidence>) {
        self.facts.gaps.push(Gap {
            owner: owner.into(),
            kind: kind.into(),
            reason: reason.into(),
            source,
        });
    }

    fn collect_mir_instances(&mut self) {
        while let Some((instance, depth)) = self.pending.pop_front() {
            if matches!(instance.def, ty::InstanceKind::Virtual(..)) {
                let source = self.source(self.tcx.def_span(instance.def_id()), "call");
                self.gap(
                    "unit",
                    ResolutionFailure::Virtual.kind(),
                    ResolutionFailure::Virtual.reason(),
                    source,
                );
                continue;
            }
            if matches!(
                instance.def,
                ty::InstanceKind::Intrinsic(..) | ty::InstanceKind::LlvmIntrinsic(..)
            ) {
                continue;
            }
            if !self.mir_seen.insert(instance) {
                continue;
            }
            if self.mir_seen.len() > 20_000 {
                self.gap(
                    "unit",
                    "instance-budget",
                    "可达 MIR 实例达到分析预算，剩余实例未展开。",
                    None,
                );
                break;
            }
            if !self.tcx.is_mir_available(instance.def_id()) {
                continue;
            }
            let env = TypingEnv::fully_monomorphized();
            self.generic_owner = instance.def_id();
            let body = self.tcx.instance_mir(instance.def);
            let caller = self.callable(instance.def_id(), instance.args, env);
            let tcx = self.tcx;
            let instantiate = |ty| {
                let raw = instance.instantiate_mir(tcx, ty::EarlyBinder::bind(tcx, ty));
                tcx.try_normalize_erasing_regions(env, ty::Unnormalized::new_wip(raw))
                    .unwrap_or(raw)
            };
            for local in &body.local_decls {
                let ty = instantiate(local.ty);
                if !ty.has_non_region_param() {
                    self.type_id(ty, env, 0);
                }
            }
            for block in body.basic_blocks.iter() {
                for statement in &block.statements {
                    let place = match &statement.kind {
                        StatementKind::Assign(assignment) => assignment.0,
                        StatementKind::SetDiscriminant { place, .. } => **place,
                        _ => continue,
                    };
                    self.mir_assignment(
                        instance,
                        &caller,
                        body,
                        place,
                        statement.source_info.span,
                        env,
                    );
                }
                if let TerminatorKind::Call {
                    func,
                    args: arguments,
                    ..
                } = &block.terminator().kind
                {
                    let ty = instantiate(func.ty(&body.local_decls, self.tcx));
                    if let ty::FnDef(id, args) = ty.kind() {
                        let args = self.tcx.instantiate_bound_regions_with_erased(*args);
                        let resolution = self.resolve_instance(*id, args, env);
                        let resolved = resolution.ok();
                        let callee =
                            resolved.map(|next| self.callable(next.def_id(), next.args, env));
                        let source_declaration = self.declaration(*id);
                        let declaration =
                            self.declaration(resolved.map_or(*id, |next| next.def_id()));
                        let source = self.source(block.terminator().source_info.span, "call");
                        let values: Vec<_> = arguments
                            .iter()
                            .map(|argument| {
                                instantiate(argument.node.ty(&body.local_decls, self.tcx))
                            })
                            .collect();
                        self.mir_operation(
                            &caller,
                            *id,
                            args,
                            &values,
                            block.terminator().source_info.span,
                            env,
                        );
                        let conditions = self
                            .hir_site_key(&caller, &source_declaration, source.as_ref())
                            .and_then(|key| self.hir_call_conditions.get(&key))
                            .or_else(|| {
                                self.hir_site_key(&caller, &declaration, source.as_ref())
                                    .and_then(|key| self.hir_call_conditions.get(&key))
                            })
                            .cloned()
                            .unwrap_or_default();
                        if let Err(failure) = resolution {
                            self.gap(&caller, failure.kind(), failure.reason(), source.clone());
                        }
                        self.facts.calls.push(CallFact {
                            caller: caller.clone(),
                            callee,
                            declaration: Some(declaration),
                            unresolved_reason: resolution
                                .err()
                                .map(|failure| failure.kind().into()),
                            source,
                            deferred: false,
                            conditions,
                        });
                        let resolved_id = resolved.map_or(*id, |next| next.def_id());
                        let crate_name = self.tcx.crate_name(resolved_id.krate).to_string();
                        // 仅沿项目 helper 和框架装配协议实例化；不解释分配器、图形驱动或游戏运行。
                        let protocol = matches!(
                            crate_name.as_str(),
                            "bevy_ecs"
                                | "bevy_app"
                                | "bevy_scene"
                                | "bevy_state"
                                | "bevy_enhanced_input"
                        );
                        if depth < 24
                            && (resolved_id.is_local() || protocol)
                            && let Some(next) = resolved
                        {
                            self.pending.push_back((next, depth + 1));
                        }
                    } else {
                        let source = self.source(block.terminator().source_info.span, "call");
                        self.gap(
                            &caller,
                            "dynamic-call",
                            "MIR 调用目标为函数指针或其他擦除类型，不能证明其实际实现。",
                            source.clone(),
                        );
                    }
                }
            }
        }
    }

    fn mir_assignment(
        &mut self,
        instance: Instance<'tcx>,
        owner: &str,
        body: &Body<'tcx>,
        place: Place<'tcx>,
        span: Span,
        env: TypingEnv<'tcx>,
    ) {
        let mut target = None;
        let mut unresolved = None;
        for (index, element) in place.projection.iter().enumerate() {
            if !matches!(element, ProjectionElem::Deref) {
                continue;
            }
            let base = PlaceRef {
                local: place.local,
                projection: &place.projection[..index],
            }
            .ty(&body.local_decls, self.tcx)
            .ty;
            let base = self.normalize(
                instance.instantiate_mir(self.tcx, ty::EarlyBinder::bind(self.tcx, base)),
                env,
            );
            if !matches!(base.kind(), ty::Ref(_, _, mutability) | ty::RawPtr(_, mutability) if mutability.is_mut())
            {
                continue;
            }
            let pointee = PlaceRef {
                local: place.local,
                projection: &place.projection[..=index],
            }
            .ty(&body.local_decls, self.tcx)
            .ty;
            let pointee = self.normalize(
                instance.instantiate_mir(self.tcx, ty::EarlyBinder::bind(self.tcx, pointee)),
                env,
            );
            if pointee.has_non_region_param() || pointee.has_aliases() || pointee.has_infer() {
                unresolved = Some(pointee);
                continue;
            }
            if self
                .roles(pointee, env)
                .iter()
                .any(|role| matches!(role.as_str(), "Component" | "Resource"))
            {
                target = Some(pointee);
                break;
            }
        }
        if target.is_none() && unresolved.is_none() {
            return;
        }
        let template = self
            .assignments
            .get(&instance.def_id())
            .and_then(|assignments| {
                assignments
                    .iter()
                    .filter(|assignment| {
                        assignment.span.contains(span) || span.contains(assignment.span)
                    })
                    .min_by_key(|assignment| assignment.span.hi().0 - assignment.span.lo().0)
            })
            .cloned();
        let evidence_span = template.as_ref().map_or(span, |assignment| assignment.span);
        let source = self.source(evidence_span, "operation");
        let Some(target) = target else {
            if let Some(unresolved) = unresolved {
                self.gap(
                    owner,
                    "unresolved-mutation",
                    &format!("MIR 确认存在写入，但目标类型 {unresolved} 未能在当前实例中具体化。"),
                    source,
                );
            }
            return;
        };
        let target_type = Some(self.type_id(target, env, 0));
        self.gap(
            owner,
            "storage-origin",
            "该赋值证明了组件或资源类型的值被写入，但尚未证明该值来自 ECS World 存储。",
            source.clone(),
        );
        let id = format!(
            "operation-{}",
            digest(serde_json::to_vec(&(owner, &target_type, &source, "modify")).unwrap())
        );
        self.facts.operations.push(OperationFact {
            id,
            owner: owner.into(),
            target_type,
            kind: "modify".into(),
            source,
            scope: "typed-value".into(),
            conditions: template
                .as_ref()
                .map(|assignment| assignment.conditions.clone())
                .unwrap_or_default(),
            deferred: template
                .as_ref()
                .is_some_and(|assignment| assignment.deferred),
            ..OperationFact::default()
        });
    }

    fn mir_operation(
        &mut self,
        owner: &str,
        id: DefId,
        args: GenericArgsRef<'tcx>,
        values: &[Ty<'tcx>],
        span: Span,
        env: TypingEnv<'tcx>,
    ) {
        let crate_name = self.tcx.crate_name(id.krate).to_string();
        if !matches!(crate_name.as_str(), "bevy_ecs" | "bevy_app" | "bevy_scene") {
            return;
        }
        let is_method =
            self.tcx.def_kind(id) == DefKind::AssocFn && self.tcx.associated_item(id).is_method();
        let receiver = if is_method {
            values.first().map(|ty| ty.peel_refs())
        } else {
            None
        };
        let Some(receiver_path) = self.framework_api_owner(id, args, env, receiver) else {
            return;
        };
        let name = self
            .tcx
            .opt_item_name(id)
            .map(|n| n.to_string())
            .unwrap_or_default();
        let payload = values
            .get(usize::from(is_method) + usize::from(name == "spawn_at"))
            .copied();
        let generic = args.types().last();
        let (mut kind, target) = match name.as_str() {
            "insert" | "try_insert" | "insert_if_new" | "insert_resource" => ("insert", payload),
            "remove" | "try_remove" | "remove_resource" | "take" => ("remove", generic),
            "init_resource" => ("initialize", generic),
            "resource" | "get_resource" | "get" => ("read", generic),
            "resource_mut" | "get_resource_mut" | "get_mut" => ("mutable_access", generic),
            "write" | "write_batch" if receiver_path.starts_with("bevy_ecs::message::") => (
                "publish",
                receiver.and_then(|ty| match ty.kind() {
                    ty::Adt(_, args) => args.types().last(),
                    _ => None,
                }),
            ),
            "trigger" | "trigger_targets" => ("trigger", payload),
            "despawn" | "try_despawn" | "despawn_related" => ("despawn", None),
            "spawn"
            | "spawn_at"
            | "spawn_batch"
            | "spawn_scene"
            | "queue_spawn_scene"
            | "spawn_scene_list"
            | "queue_spawn_scene_list"
            | "spawn_empty" => ("create", payload),
            _ => ("", None),
        };
        if !kind.is_empty() {
            let method = self.declaration(id);
            let source = self.source(span, "operation");
            let template = self
                .hir_site_key(owner, &method, source.as_ref())
                .and_then(|key| self.hir_operation_templates.get(&key))
                .cloned();
            if template
                .as_ref()
                .is_some_and(|operation| operation.is_filter)
            {
                kind = "filter";
            }
            let conditions = template
                .map(|operation| operation.conditions)
                .unwrap_or_default();
            let targets = self.operation_targets(owner, target, kind, env, source.clone());
            for target_type in targets {
                let key = format!(
                    "operation-{}",
                    digest(
                        serde_json::to_vec(&(owner, &method, &target_type, &source, kind)).unwrap()
                    )
                );
                self.facts.operations.push(OperationFact {
                    id: key,
                    owner: owner.into(),
                    method: method.clone(),
                    target_type,
                    kind: kind.into(),
                    deferred: receiver_path.starts_with("bevy_ecs::system::commands::")
                        || matches!(
                            name.as_str(),
                            "queue_spawn_scene" | "queue_spawn_scene_list"
                        ),
                    scope: "current".into(),
                    source: source.clone(),
                    conditions: conditions.clone(),
                    call_chain: vec![],
                });
            }
        }
        if matches!(
            name.as_str(),
            "add_systems" | "observe" | "add_observer" | "configure_sets" | "add_plugins"
        ) {
            for argument in args.types() {
                for (function, generic) in self.function_types(argument, 0) {
                    let target = self.callable(function, generic, env);
                    let type_id = self.type_id(argument, env, 0);
                    let source = self.source(span, "registration");
                    self.facts.registrations.push(RegistrationFact {
                        owner: owner.into(),
                        kind: name.clone(),
                        target: Some(target),
                        type_id: Some(type_id),
                        source,
                    });
                }
            }
        }
    }

    fn framework_api_owner(
        &self,
        method: DefId,
        args: GenericArgsRef<'tcx>,
        env: TypingEnv<'tcx>,
        receiver: Option<Ty<'tcx>>,
    ) -> Option<String> {
        let receiver = receiver?.peel_refs();
        let ty::Adt(adt, _) = receiver.kind() else {
            return None;
        };
        let path = full_path(self.tcx, adt.did());
        if !matches!(
            path.as_str(),
            "bevy_ecs::world::World"
                | "bevy_ecs::world::deferred_world::DeferredWorld"
                | "bevy_ecs::world::entity_access::world_mut::EntityWorldMut"
                | "bevy_ecs::world::entity_access::entity_mut::EntityMut"
                | "bevy_ecs::world::entity_access::entity_ref::EntityRef"
                | "bevy_ecs::world::entity_access::except::EntityMutExcept"
                | "bevy_ecs::world::entity_access::except::EntityRefExcept"
                | "bevy_ecs::system::commands::Commands"
                | "bevy_ecs::system::commands::EntityCommands"
                | "bevy_ecs::message::messages::Messages"
                | "bevy_ecs::message::message_writer::MessageWriter"
                | "bevy_ecs::message::message_mutator::MessageMutator"
                | "bevy_ecs::schedule::schedule::Schedule"
                | "bevy_ecs::schedule::schedule::Schedules"
                | "bevy_app::app::App"
                | "bevy_app::sub_app::SubApp"
        ) {
            return None;
        }
        if let Some(owner) = self.tcx.impl_of_assoc(method) {
            let owner_ty = self.normalize(
                self.tcx
                    .type_of(owner)
                    .instantiate(self.tcx, args)
                    .skip_norm_wip(),
                env,
            );
            if matches!(owner_ty.kind(), ty::Adt(owner, _) if owner.did() == adt.did()) {
                return Some(path);
            }
        }
        // 扩展方法以实际 trait 的 DefId 为协议入口，不能仅凭接收者和短方法名归类。
        self.tcx.trait_of_assoc(method).filter(|id| {
            matches!(
                full_path(self.tcx, *id).as_str(),
                "bevy_scene::spawn::WorldSceneExt"
                    | "bevy_scene::spawn::CommandsSceneExt"
                    | "bevy_scene::spawn::EntityWorldMutSceneExt"
                    | "bevy_scene::spawn::EntityCommandsSceneExt"
            )
        })?;
        Some(path)
    }

    fn operation_targets(
        &mut self,
        owner: &str,
        target: Option<Ty<'tcx>>,
        kind: &str,
        env: TypingEnv<'tcx>,
        source: Option<SourceEvidence>,
    ) -> Vec<Option<String>> {
        let Some(target) = target else {
            return vec![None];
        };
        let target = self.normalize(target, env);
        if matches!(kind, "insert" | "remove")
            && !target.has_non_region_param()
            && self.roles(target, env).iter().any(|role| role == "Bundle")
        {
            match self.bundle_engine.component_types(target, 0) {
                Ok(types) if !types.is_empty() => {
                    return types
                        .into_iter()
                        .map(|ty| Some(self.type_id(ty, env, 0)))
                        .collect();
                }
                Ok(_) => self.gap(
                    owner,
                    "bundle-operation",
                    &format!("结构操作的 Bundle 尚未展开组件：{target}"),
                    source,
                ),
                Err(error) => self.gap(
                    owner,
                    "bundle-operation",
                    &format!("结构操作的 Bundle MIR 无法解析：{target}；{error:#}"),
                    source,
                ),
            }
        }
        vec![Some(self.type_id(target, env, 0))]
    }

    fn collect_entity_templates(&mut self) -> Result<()> {
        // 名称检查器的值流引擎同时输出结构，确保 BSN、Bundle 与 required 使用同一解释。
        if std::env::var_os("CARGO_PRIMARY_PACKAGE").is_none() {
            return Ok(());
        }
        let structures = crate::entity::analysis::structures(self.tcx)?;
        let mut sites: HashMap<String, HashMap<Span, usize>> = HashMap::new();
        let mut groups: Vec<(
            String,
            Span,
            String,
            Vec<crate::entity::mir_value::EntityStructure<'tcx>>,
        )> = vec![];
        let mut group_indices = HashMap::new();
        for creation in structures {
            let creator = self.callable(
                creation.creator.def_id(),
                creation.creator.args,
                TypingEnv::fully_monomorphized(),
            );
            let owner_sites = sites.entry(creator.clone()).or_default();
            let next = owner_sites.len();
            let index = *owner_sites.entry(creation.span).or_insert(next);
            let next = groups.len();
            let group = *group_indices
                .entry((creator.clone(), creation.span))
                .or_insert(next);
            if group == next {
                groups.push((creator, creation.span, format!("root{index}"), vec![]));
            }
            groups[group].3.push(creation.structure);
        }
        for (creator, span, path, structures) in groups {
            let env = TypingEnv::fully_monomorphized();
            let source = self.source(span, "create");
            let observations = structures.len();
            let candidates = self.merge_entity_observations(&structures, env);
            let group = (candidates.len() > 1).then(|| {
                format!(
                    "alternative-{}",
                    digest(serde_json::to_vec(&(&creator, &path)).unwrap())
                )
            });
            for (index, structure) in candidates.iter().enumerate() {
                let shape = digest(self.entity_shape(structure, false, env).to_string());
                let candidate_path = if group.is_some() {
                    format!("{path}.candidate{index}-{}", &shape[..16])
                } else {
                    path.clone()
                };
                let id = self.entity_structure(
                    &creator,
                    structure,
                    source.clone(),
                    &candidate_path,
                    env,
                    group.clone(),
                    group.is_some(),
                    vec![],
                );
                if let Some(group) = &group {
                    let gap = Gap {
                        owner: id.clone(),
                        kind: "entity-alternative".into(),
                        reason: format!(
                            "同一创建位置保留多个独立结构候选（{group}）；尚未关联具体分支或批量元素，不推断互斥或同时存在。"
                        ),
                        source: source.clone(),
                    };
                    let entity = self
                        .facts
                        .entities
                        .iter_mut()
                        .find(|entity| entity.id == id)
                        .expect("Exported entity");
                    entity.alternative_selection = Some("unresolved".into());
                    entity.gaps.push(gap);
                }
                if observations > candidates.len() {
                    let gap=Gap {owner:id.clone(),kind:"entity-multiplicity".into(),reason:"解释中同一来源的同构结构多次出现，已复用创建模板；该模板不表示运行时实体数量，也不推断这些出现属于同次执行。".into(),source:source.clone()};
                    self.facts
                        .entities
                        .iter_mut()
                        .find(|entity| entity.id == id)
                        .expect("Exported entity")
                        .gaps
                        .push(gap);
                }
            }
        }
        Ok(())
    }

    fn structure_source(
        &mut self,
        structure: &crate::entity::mir_value::EntityStructure<'tcx>,
    ) -> Option<SourceEvidence> {
        structure
            .span
            .and_then(|span| self.source(span, "create"))
            .or_else(|| {
                structure.site.as_ref().map(|site| {
                    let (_, sha256) = self.fingerprint(&site.path).unwrap_or_default();
                    SourceEvidence {
                        path: site.path.clone(),
                        line: site.line,
                        column: site.column,
                        role: "create".into(),
                        sha256,
                        ..SourceEvidence::default()
                    }
                })
            })
    }

    fn entity_shape(
        &mut self,
        structure: &crate::entity::mir_value::EntityStructure<'tcx>,
        sources: bool,
        env: TypingEnv<'tcx>,
    ) -> serde_json::Value {
        let mut components: Vec<_> = structure
            .components
            .iter()
            .map(|ty| self.type_id(*ty, env, 0))
            .collect();
        components.sort();
        components.dedup();
        let mut required: Vec<_> = structure
            .required
            .iter()
            .map(|ty| self.type_id(*ty, env, 0))
            .collect();
        required.sort();
        required.dedup();
        let children: Vec<_> = structure
            .children
            .iter()
            .map(|child| self.entity_shape(child, sources, env))
            .collect();
        let alternatives: Vec<Vec<_>> = structure
            .alternatives
            .iter()
            .map(|group| {
                group
                    .iter()
                    .map(|candidate| self.entity_shape(candidate, sources, env))
                    .collect()
            })
            .collect();
        serde_json::json!({"components":components,"required":required,"children":children,"alternatives":alternatives,"source":if sources {self.structure_source(structure)} else {None},"gaps":if sources {structure.gaps.clone()} else {vec![]}})
    }

    fn merge_entity_observations(
        &mut self,
        structures: &[crate::entity::mir_value::EntityStructure<'tcx>],
        env: TypingEnv<'tcx>,
    ) -> Vec<crate::entity::mir_value::EntityStructure<'tcx>> {
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut candidates: Vec<crate::entity::mir_value::EntityStructure<'tcx>> = vec![];
        for structure in structures {
            let shape = self.entity_shape(structure, true, env).to_string();
            if let Some(&index) = seen.get(&shape) {
                candidates[index].merge_name_candidates(structure);
            } else {
                seen.insert(shape, candidates.len());
                candidates.push(structure.clone());
            }
        }
        candidates
    }

    fn entity_structure(
        &mut self,
        creator: &str,
        structure: &crate::entity::mir_value::EntityStructure<'tcx>,
        source: Option<SourceEvidence>,
        path: &str,
        env: TypingEnv<'tcx>,
        alternative_group: Option<String>,
        possible: bool,
        mut alternative_context: Vec<String>,
    ) -> String {
        if let Some(group) = &alternative_group {
            alternative_context.push(group.clone());
        }
        let id = format!(
            "entity-{}",
            digest(serde_json::to_vec(&(creator, path)).unwrap())
        );
        let components = structure
            .components
            .iter()
            .map(|ty| self.type_id(*ty, env, 0))
            .collect();
        let required_components = structure
            .required
            .iter()
            .map(|ty| self.type_id(*ty, env, 0))
            .collect();
        let children = structure
            .children
            .iter()
            .enumerate()
            .map(|(index, child)| {
                let child_source = self.structure_source(child).or_else(|| source.clone());
                self.entity_structure(
                    creator,
                    child,
                    child_source,
                    &format!("{path}.{index}"),
                    env,
                    None,
                    possible,
                    alternative_context.clone(),
                )
            })
            .collect();
        let mut alternatives = vec![];
        for (group_index, group) in structure.alternatives.iter().enumerate() {
            let group_id = format!(
                "alternative-{}",
                digest(serde_json::to_vec(&(creator, path, group_index)).unwrap())
            );
            let mut candidates = vec![];
            for candidate in self.merge_entity_observations(group, env) {
                let index = candidates.len();
                let candidate_source = self.structure_source(&candidate).or_else(|| source.clone());
                let shape = digest(self.entity_shape(&candidate, false, env).to_string());
                candidates.push(self.entity_structure(
                    creator,
                    &candidate,
                    candidate_source,
                    &format!(
                        "{path}.alternative{group_index}.candidate{index}-{}",
                        &shape[..16]
                    ),
                    env,
                    Some(group_id.clone()),
                    true,
                    alternative_context.clone(),
                ));
            }
            alternatives.push(EntityAlternativeGroup {
                id: group_id,
                candidates,
                source: source.clone(),
                selection: "one-of".into(),
            });
        }
        let gaps = structure
            .gaps
            .iter()
            .map(|reason| Gap {
                owner: id.clone(),
                kind: "entity-structure".into(),
                reason: reason.clone(),
                source: source.clone(),
            })
            .collect();
        let mut gaps: Vec<_> = gaps;
        if !alternatives.is_empty() {
            gaps.push(Gap {owner:id.clone(),kind:"entity-alternative".into(),reason:"各结构候选分别来自原生场景执行分支，尚未导出候选与具体条件的对应；独立候选组不做笛卡尔组合。".into(),source:source.clone()});
        }
        let source_evidence = self
            .structure_source(structure)
            .filter(|evidence| Some(evidence) != source.as_ref())
            .into_iter()
            .collect();
        let mut name_candidates: Vec<_> = structure
            .name_candidates
            .iter()
            .map(|candidate| {
                // Name 表达式保留实参范围，避免 source_callsite 扩大成整段 BSN。
                let expression = candidate
                    .expression
                    .and_then(|span| self.source_at(span, span, "assembly"))
                    .filter(|source| !source.snippet.trim().is_empty());
                let reason = candidate.reason.clone().or_else(|| {
                    (candidate.value.is_none() && expression.is_none())
                        .then(|| "Name 内容及其赋值表达式未能确定。".into())
                });
                EntityNameCandidate {
                    value: candidate.value.clone(),
                    expression,
                    reason,
                }
            })
            .collect();
        name_candidates.sort_by_cached_key(|candidate| {
            serde_json::to_string(candidate).expect("Entity name evidence")
        });
        name_candidates.dedup();
        let record = EntityTemplate {
            id: id.clone(),
            creator: creator.into(),
            source,
            components,
            required_components,
            children,
            gaps,
            alternatives,
            alternative_selection: alternative_group.as_ref().map(|_| "one-of".into()),
            alternative_group,
            alternative_context,
            possible,
            source_evidence,
            name_candidates,
        };
        self.facts.entities.push(record);
        id
    }
}

struct BodyVisitor<'a, 'tcx> {
    collector: &'a mut Collector<'tcx>,
    types: &'tcx TypeckResults<'tcx>,
    env: TypingEnv<'tcx>,
    owner: String,
    definition: DefId,
    deferred: bool,
    existence_check: bool,
    conditions: Vec<SourceEvidence>,
}

impl<'tcx> BodyVisitor<'_, 'tcx> {
    fn resolved(&self, expr: &Expr<'tcx>) -> Option<(DefId, GenericArgsRef<'tcx>)> {
        match self.types.expr_ty(expr).kind() {
            ty::FnDef(id, args) => Some((
                *id,
                self.collector
                    .tcx
                    .instantiate_bound_regions_with_erased(*args),
            )),
            ty::Closure(id, args) => Some((*id, args)),
            _ => None,
        }
    }

    fn method(
        &mut self,
        expr: &'tcx Expr<'tcx>,
        id: DefId,
        args: GenericArgsRef<'tcx>,
        receiver: Option<&'tcx Expr<'tcx>>,
        arguments: &'tcx [Expr<'tcx>],
    ) {
        let resolution = self.collector.resolve_instance(id, args, self.env);
        let resolved = resolution.ok();
        let callable = resolved.map(|instance| {
            self.collector
                .callable(instance.def_id(), instance.args, self.env)
        });
        let declaration = self.collector.declaration(id);
        let target_declaration = self
            .collector
            .declaration(resolved.map_or(id, |instance| instance.def_id()));
        let source = self.collector.source(expr.span, "operation");
        if let Err(failure) = resolution
            && !args.has_non_region_param()
            && !args.has_aliases()
        {
            self.collector.gap(
                &self.owner,
                failure.kind(),
                failure.reason(),
                source.clone(),
            );
        }
        self.collector.facts.calls.push(CallFact {
            caller: self.owner.clone(),
            callee: callable,
            declaration: Some(target_declaration),
            unresolved_reason: resolution.err().map(|failure| failure.kind().into()),
            source: source.clone(),
            deferred: self.deferred,
            conditions: self.conditions.clone(),
        });
        let crate_name = self.collector.tcx.crate_name(id.krate).to_string();
        if !matches!(crate_name.as_str(), "bevy_ecs" | "bevy_app" | "bevy_scene") {
            return;
        }
        let name = self
            .collector
            .tcx
            .opt_item_name(id)
            .map(|name| name.to_string())
            .unwrap_or_default();
        let is_method = self.collector.tcx.def_kind(id) == DefKind::AssocFn
            && self.collector.tcx.associated_item(id).is_method();
        let receiver_ty = receiver
            .or_else(|| if is_method { arguments.first() } else { None })
            .map(|receiver| self.types.expr_ty_adjusted(receiver).peel_refs());
        let Some(receiver_path) =
            self.collector
                .framework_api_owner(id, args, self.env, receiver_ty)
        else {
            return;
        };
        let commands = receiver_path.starts_with("bevy_ecs::system::commands::");
        let generic: Vec<_> = args.types().collect();
        let offset = usize::from(receiver.is_none() && is_method);
        let payload = arguments
            .get(offset + usize::from(name == "spawn_at"))
            .map(|argument| self.types.expr_ty(argument));
        let (kind, target) = match name.as_str() {
            "insert" | "try_insert" | "insert_if_new" | "insert_resource" => ("insert", payload),
            "remove" | "try_remove" | "remove_resource" | "take" => {
                ("remove", generic.last().copied())
            }
            "init_resource" => ("initialize", generic.last().copied()),
            "resource" | "get_resource" | "get" => ("read", generic.last().copied()),
            "resource_mut" | "get_resource_mut" | "get_mut" => {
                ("mutable_access", generic.last().copied())
            }
            "write" | "write_batch" if receiver_path.starts_with("bevy_ecs::message::") => (
                "publish",
                receiver_ty.and_then(|ty| match ty.kind() {
                    ty::Adt(_, args) => args.types().last(),
                    _ => None,
                }),
            ),
            "trigger" | "trigger_targets" => ("trigger", payload),
            "despawn" | "try_despawn" | "despawn_related" => ("despawn", None),
            "spawn"
            | "spawn_at"
            | "spawn_batch"
            | "spawn_scene"
            | "queue_spawn_scene"
            | "spawn_scene_list"
            | "queue_spawn_scene_list"
            | "spawn_empty" => ("create", payload),
            _ => ("", None),
        };
        let kind = if kind == "read" && self.existence_check {
            "filter"
        } else {
            kind
        };
        if !kind.is_empty() {
            let targets = self.collector.operation_targets(
                &self.owner,
                target,
                kind,
                self.env,
                source.clone(),
            );
            for target_type in targets {
                let op_id = format!(
                    "operation-{}",
                    digest(
                        serde_json::to_vec(&(
                            &self.owner,
                            &declaration,
                            &target_type,
                            &source,
                            kind
                        ))
                        .unwrap()
                    )
                );
                self.collector.facts.operations.push(OperationFact {
                    id: op_id,
                    owner: self.owner.clone(),
                    method: declaration.clone(),
                    target_type,
                    kind: kind.into(),
                    deferred: commands || self.deferred || name.starts_with("queue_"),
                    scope: "current".into(),
                    source: source.clone(),
                    conditions: self.conditions.clone(),
                    call_chain: vec![],
                });
            }
        }
        match name.as_str() {
            "queue" if commands => {
                for argument in arguments {
                    if let Some((closure, closure_args)) = self.resolved(argument) {
                        let target = self.collector.callable(closure, closure_args, self.env);
                        let target_declaration = self.collector.declaration(closure);
                        self.collector.facts.calls.push(CallFact {
                            caller: self.owner.clone(),
                            callee: Some(target),
                            declaration: Some(target_declaration),
                            unresolved_reason: None,
                            source: source.clone(),
                            deferred: true,
                            conditions: self.conditions.clone(),
                        });
                    }
                }
            }
            "add_systems" | "add_observer" | "observe" | "configure_sets" | "add_plugins"
            | "register_type" | "add_message" => {
                let index = offset + usize::from(name == "add_systems");
                if let Some(target) = arguments.get(index) {
                    let functions = self.registration_functions(target);
                    let type_id = self
                        .collector
                        .type_id(self.types.expr_ty(target), self.env, 0);
                    if functions.is_empty() {
                        self.collector.facts.registrations.push(RegistrationFact {
                            owner: self.owner.clone(),
                            kind: name.clone(),
                            target: None,
                            type_id: Some(type_id),
                            source,
                        });
                    } else {
                        for (target_id, target_args) in functions {
                            let target = self.collector.callable(target_id, target_args, self.env);
                            self.collector.facts.registrations.push(RegistrationFact {
                                owner: self.owner.clone(),
                                kind: name.clone(),
                                target: Some(target),
                                type_id: Some(type_id.clone()),
                                source: source.clone(),
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn registration_functions(&self, expr: &'tcx Expr<'tcx>) -> Vec<(DefId, GenericArgsRef<'tcx>)> {
        if let Some(function) = self.resolved(expr) {
            return vec![function];
        }
        match expr.kind {
            ExprKind::Tup(items) | ExprKind::Array(items) => items
                .iter()
                .flat_map(|item| self.registration_functions(item))
                .collect(),
            ExprKind::MethodCall(segment, receiver, args, _) => {
                let mut found = self.registration_functions(receiver);
                if matches!(segment.ident.name.as_str(), "pipe" | "map") {
                    found.extend(args.iter().flat_map(|arg| self.registration_functions(arg)));
                }
                found
            }
            _ => self.collector.function_types(self.types.expr_ty(expr), 0),
        }
    }

    fn mutable_component(&self, expr: &'tcx Expr<'tcx>) -> Option<Ty<'tcx>> {
        let ty = self.types.expr_ty(expr);
        match ty.kind() {
            ty::Ref(_, inner, mutability) if mutability.is_mut() => Some(*inner),
            ty::Adt(adt, args)
                if matches!(
                    full_path(self.collector.tcx, adt.did()).as_str(),
                    "bevy_ecs::change_detection::params::Mut"
                        | "bevy_ecs::change_detection::params::ResMut"
                ) =>
            {
                args.types().next()
            }
            _ => match expr.kind {
                ExprKind::Field(base, _) | ExprKind::Unary(UnOp::Deref, base) => {
                    self.mutable_component(base)
                }
                _ => None,
            },
        }
    }
}

impl<'tcx> Visitor<'tcx> for BodyVisitor<'_, 'tcx> {
    fn visit_expr(&mut self, expr: &'tcx Expr<'tcx>) {
        if let ExprKind::MethodCall(segment, receiver, arguments, _) = expr.kind
            && matches!(segment.ident.name.as_str(), "is_some" | "is_none")
            && matches!(self.types.expr_ty_adjusted(receiver).peel_refs().kind(), ty::Adt(adt, _) if full_path(self.collector.tcx, adt.did()) == "core::option::Option")
        {
            let previous = self.existence_check;
            self.existence_check = true;
            self.visit_expr(receiver);
            self.existence_check = previous;
            for argument in arguments {
                self.visit_expr(argument);
            }
            return;
        }
        match expr.kind {
            ExprKind::MethodCall(_, receiver, arguments, _) => {
                if let Some(id) = self.types.type_dependent_def_id(expr.hir_id) {
                    self.method(
                        expr,
                        id,
                        self.types.node_args(expr.hir_id),
                        Some(receiver),
                        arguments,
                    );
                }
            }
            ExprKind::Call(function, arguments) => {
                if let Some((id, args)) = self.resolved(function) {
                    self.method(expr, id, args, None, arguments);
                } else if !matches!(self.types.expr_ty(function).kind(), ty::Closure(..)) {
                    let source = self.collector.source(expr.span, "call");
                    self.collector.gap(
                        &self.owner,
                        "dynamic-call",
                        "动态调用的目标未能唯一解析，未推断其副作用。",
                        source.clone(),
                    );
                    self.collector.facts.calls.push(CallFact {
                        caller: self.owner.clone(),
                        callee: None,
                        declaration: None,
                        unresolved_reason: Some("dynamic-call".into()),
                        source,
                        deferred: self.deferred,
                        conditions: self.conditions.clone(),
                    });
                }
            }
            ExprKind::InlineAsm(..) => {
                let source = self.collector.source(expr.span, "call");
                self.collector.gap(
                    &self.owner,
                    "inline-assembly",
                    "内联汇编的调用与符号行为未建模，保留显式分析缺口。",
                    source.clone(),
                );
                self.collector.facts.calls.push(CallFact {
                    caller: self.owner.clone(),
                    callee: None,
                    declaration: None,
                    unresolved_reason: Some("inline-assembly".into()),
                    source,
                    deferred: self.deferred,
                    conditions: self.conditions.clone(),
                });
            }
            ExprKind::Assign(left, _, _) | ExprKind::AssignOp(_, left, _) => {
                self.collector
                    .assignments
                    .entry(self.definition)
                    .or_default()
                    .push(AssignmentEvidence {
                        span: expr.span,
                        conditions: self.conditions.clone(),
                        deferred: self.deferred,
                    });
                if let Some(ty) = self.mutable_component(left) {
                    let roles = self.collector.roles(ty, self.env);
                    if roles
                        .iter()
                        .any(|role| matches!(role.as_str(), "Component" | "Resource"))
                    {
                        let target_type = Some(self.collector.type_id(ty, self.env, 0));
                        let source = self.collector.source(expr.span, "operation");
                        self.collector.gap(&self.owner, "storage-origin", "该赋值证明了组件或资源类型的值被写入，但尚未证明该值来自 ECS World 存储。", source.clone());
                        let id = format!(
                            "operation-{}",
                            digest(
                                serde_json::to_vec(&(&self.owner, &target_type, &source, "modify"))
                                    .unwrap()
                            )
                        );
                        self.collector.facts.operations.push(OperationFact {
                            id,
                            owner: self.owner.clone(),
                            target_type,
                            kind: "modify".into(),
                            source,
                            scope: "typed-value".into(),
                            conditions: self.conditions.clone(),
                            ..OperationFact::default()
                        });
                    }
                }
            }
            ExprKind::If(condition, then, otherwise) => {
                self.visit_expr(condition);
                let old = self.conditions.len();
                if let Some(source) = self.collector.source(condition.span, "condition") {
                    self.conditions.push(source);
                }
                self.visit_expr(then);
                self.conditions.truncate(old);
                if let Some(otherwise) = otherwise {
                    if let Some(mut source) = self.collector.source(condition.span, "condition") {
                        source.role = "unless".into();
                        self.conditions.push(source);
                    }
                    self.visit_expr(otherwise);
                    self.conditions.truncate(old);
                }
                return;
            }
            ExprKind::Match(value, arms, _) => {
                self.visit_expr(value);
                let old = self.conditions.len();
                for arm in arms {
                    if let Some(source) = self.collector.source(value.span, "match-value") {
                        self.conditions.push(source);
                    }
                    if let Some(source) = self.collector.source(arm.pat.span, "match-arm") {
                        self.conditions.push(source);
                    }
                    if let Some(guard) = arm.guard {
                        self.visit_expr(guard);
                        if let Some(source) = self.collector.source(guard.span, "condition") {
                            self.conditions.push(source);
                        }
                    }
                    self.visit_expr(arm.body);
                    self.conditions.truncate(old);
                }
                return;
            }
            ExprKind::Binary(op, left, right)
                if matches!(op.node, BinOpKind::And | BinOpKind::Or) =>
            {
                self.visit_expr(left);
                let old = self.conditions.len();
                if let Some(source) = self.collector.source(
                    left.span,
                    if op.node == BinOpKind::And {
                        "condition"
                    } else {
                        "unless"
                    },
                ) {
                    self.conditions.push(source);
                }
                self.visit_expr(right);
                self.conditions.truncate(old);
                return;
            }
            _ => {}
        }
        intravisit::walk_expr(self, expr);
    }
}
