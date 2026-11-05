//! 定义身份使用精确包与原生消歧路径；编译器 metadata 和物理源码位置只作来源证据。
use analysis_contract::{
    PackageOrigin,
    facts::{Gap, PurposeDependency},
    normalized,
};
use anyhow::{Result, ensure};
use rustc_data_structures::{
    fingerprint::Fingerprint,
    stable_hash::{
        RawDefId, RawSpan, StableHash, StableHashControls, StableHashCtxt, StableHasher,
    },
};
use rustc_hir::{
    Expr, ExprKind, HirId, OwnerId,
    def::DefKind,
    def_id::{CRATE_DEF_INDEX, CrateNum, DefId, LOCAL_CRATE, LocalDefId},
    intravisit::{self, Visitor},
};
use rustc_middle::ty::{self, Instance, TyCtxt, TypeckResults, TypingEnv};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::Path,
    rc::Rc,
};

pub(crate) struct Identities<'tcx> {
    tcx: TyCtxt<'tcx>,
    origins: Vec<PackageOrigin>,
    crates: RefCell<BTreeMap<CrateNum, String>>,
    definitions: RefCell<HashMap<DefId, String>>,
    gaps: RefCell<BTreeMap<String, Gap>>,
    owning_behavior: RefCell<Option<Fingerprint>>,
    requested_traits: RefCell<HashSet<DefId>>,
    behavior: RefCell<HashMap<(LocalDefId, bool), (Fingerprint, bool, Vec<PurposeDependency>)>>,
    member_shapes: RefCell<HashMap<LocalDefId, Fingerprint>>,
    bodies: HashMap<OwnerId, Vec<LocalDefId>>,
}

impl<'tcx> Identities<'tcx> {
    pub(crate) fn new(tcx: TyCtxt<'tcx>, origins: &[PackageOrigin]) -> Result<Self> {
        let mut bodies = HashMap::<_, Vec<_>>::new();
        for local in tcx.hir_body_owners() {
            if tcx.def_kind(local.to_def_id()) != DefKind::SyntheticCoroutineBody {
                bodies
                    .entry(tcx.local_def_id_to_hir_id(local).owner)
                    .or_default()
                    .push(local);
            }
        }
        let identities = Self {
            tcx,
            origins: origins.to_vec(),
            crates: RefCell::new(BTreeMap::new()),
            definitions: RefCell::new(HashMap::new()),
            gaps: RefCell::new(BTreeMap::new()),
            owning_behavior: RefCell::new(None),
            requested_traits: RefCell::new(HashSet::new()),
            behavior: RefCell::new(HashMap::new()),
            member_shapes: RefCell::new(HashMap::new()),
            bodies,
        };
        let local = identities.crate_identity(LOCAL_CRATE);
        ensure!(
            origins.is_empty() || !local.starts_with("native:"),
            "The compiler crate root does not uniquely match a Cargo package target"
        );
        Ok(identities)
    }

    pub(crate) fn crate_identity(&self, krate: CrateNum) -> String {
        if let Some(identity) = self.crates.borrow().get(&krate) {
            return identity.clone();
        }
        let span = self.tcx.def_span(DefId {
            krate,
            index: CRATE_DEF_INDEX,
        });
        let source = (!span.is_dummy()).then(|| {
            self.tcx
                .sess
                .source_map()
                .lookup_char_pos(span.lo())
                .file
                .name
                .prefer_local_unconditionally()
                .to_string()
        });
        let filename = source.as_ref().map(|source| {
            normalized(Path::new(source)).unwrap_or_else(|_| source.replace('\\', "/"))
        });
        let candidates: Vec<_> =
            self.origins
                .iter()
                .flat_map(|origin| {
                    origin.targets.iter().filter_map(|target| {
                        (Some(&target.source) == filename.as_ref()).then(|| {
                            serde_json::json!({
                    "package":origin.identity,"crate":self.tcx.crate_name(krate).as_str(),
                    "target":{"name":target.name,"kind":target.kind}
                }).to_string()
                        })
                    })
                })
                .collect();
        let identity = if self.is_sysroot_binary(krate) {
            // std 捆绑的第三方 crate 可保留构建机 registry 源码路径；实际加载产物认证其归属。
            serde_json::json!({"compiler":env!("ANALYSIS_COMPILER"),"sysrootCrate":self.tcx.crate_name(krate).as_str()}).to_string()
        } else if candidates.len() == 1 {
            candidates[0].clone()
        } else if self.origins.is_empty() && krate == LOCAL_CRATE {
            // extract() 的合成编译器夹具没有 Cargo；真实 driver 始终传入精确来源。
            serde_json::json!({"standalone":self.tcx.crate_name(krate).as_str()}).to_string()
        } else if filename
            .as_ref()
            .is_some_and(|path| self.is_sysroot_source(path))
        {
            serde_json::json!({"compiler":env!("ANALYSIS_COMPILER"),"sysrootCrate":self.tcx.crate_name(krate).as_str()}).to_string()
        } else {
            let native = format!("native:{:?}", self.tcx.stable_crate_id(krate));
            self.gaps.borrow_mut().insert(native.clone(), Gap { owner: native.clone(), kind: "definition-origin".into(), reason: format!("crate {} 的原生根源码 {:?} 未唯一匹配 Cargo 包与目标；保留编译身份，不按名称猜测可复用定义身份。", self.tcx.crate_name(krate), filename), source: None });
            native
        };
        self.crates.borrow_mut().insert(krate, identity.clone());
        identity
    }

    fn is_sysroot_binary(&self, krate: CrateNum) -> bool {
        if krate == LOCAL_CRATE {
            return false;
        }
        let Ok(sysroot) = self.tcx.sess.opts.sysroot.path().canonicalize() else {
            return false;
        };
        let source = self.tcx.used_crate_source(krate);
        let mut paths = source
            .paths()
            .chain(source.sdylib_interface.iter())
            .peekable();
        paths.peek().is_some()
            && paths.all(|path| {
                path.canonicalize()
                    .is_ok_and(|path| path.starts_with(&sysroot))
            })
    }

    fn is_sysroot_source(&self, filename: &str) -> bool {
        if filename.starts_with(&format!("/rustc/{}/library/", env!("ANALYSIS_COMPILER"))) {
            return true;
        }
        let sysroot = normalized(self.tcx.sess.opts.sysroot.path()).unwrap_or_default();
        [
            "lib/rustlib/src/rust/library/",
            "lib/rustlib/rustc-src/rust/library/",
        ]
        .iter()
        .any(|source| filename.starts_with(&format!("{sysroot}/{source}")))
    }

    pub(crate) fn definition(&self, id: DefId) -> String {
        if let Some(key) = self.definitions.borrow().get(&id) {
            return key.clone();
        }
        // 保留命名空间、匿名节点与原生 disambiguator；显示路径不足以区分构造器等定义。
        let path: Vec<_> = self
            .tcx
            .def_path(id)
            .data
            .iter()
            .map(|part| (format!("{:?}", part.data), part.disambiguator))
            .collect();
        let key = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&("definition-v2", self.crate_identity(id.krate), path))
                    .unwrap()
            )
        );
        self.definitions.borrow_mut().insert(id, key.clone());
        key
    }

    pub(crate) fn gaps(&self) -> Vec<Gap> {
        self.gaps.borrow().values().cloned().collect()
    }

    pub(crate) fn tcx(&self) -> TyCtxt<'tcx> {
        self.tcx
    }

    pub(crate) fn requested_traits(&self) -> HashSet<DefId> {
        self.requested_traits.borrow().clone()
    }

    pub(crate) fn local_behavior(
        &self,
        local: LocalDefId,
    ) -> Option<(Fingerprint, bool, Vec<PurposeDependency>)> {
        self.scoped_behavior(local, false)
    }

    pub(crate) fn member_behavior(
        &self,
        local: LocalDefId,
    ) -> Option<(Fingerprint, bool, Vec<PurposeDependency>)> {
        self.scoped_behavior(local, true)
    }

    pub(crate) fn unmodeled_member_behavior(&self, local: LocalDefId) -> Option<Fingerprint> {
        let owner = self.tcx.local_def_id_to_hir_id(local).owner;
        if let Some(hash) = self.member_shapes.borrow().get(&owner.def_id) {
            return Some(*hash);
        }
        let nodes = self.tcx.hir_owner_nodes(owner);
        if matches!(nodes.node(), rustc_hir::OwnerNode::Synthetic) {
            return None;
        }
        let mut context = BehaviorHashContext::unmodeled(self, owner.def_id.to_def_id());
        let mut hasher = StableHasher::new();
        "unmodeled-member-hir-v1".stable_hash(&mut context, &mut hasher);
        self.hash_owner_attributes(owner, &mut context, &mut hasher);
        self.hash_declaration_types(owner.def_id.to_def_id(), &mut context, &mut hasher);
        nodes.node().stable_hash(&mut context, &mut hasher);
        nodes.bodies.stable_hash(&mut context, &mut hasher);
        let hash = hasher.finish();
        self.member_shapes.borrow_mut().insert(owner.def_id, hash);
        Some(hash)
    }

    fn scoped_behavior(
        &self,
        local: LocalDefId,
        require_helper_coverage: bool,
    ) -> Option<(Fingerprint, bool, Vec<PurposeDependency>)> {
        if self.tcx.def_kind(local) == DefKind::SyntheticCoroutineBody {
            return None;
        }
        let owner = self.tcx.local_def_id_to_hir_id(local).owner;
        let anonymous = self.tcx.def_kind(local) == DefKind::AnonConst;
        let key = if anonymous { local } else { owner.def_id };
        if let Some(evidence) = self.behavior.borrow().get(&(key, require_helper_coverage)) {
            return Some(evidence.clone());
        }
        let nodes = self.tcx.hir_owner_nodes(owner);
        if matches!(nodes.node(), rustc_hir::OwnerNode::Synthetic) {
            return None;
        }
        let mut context = BehaviorHashContext::new(self, key.to_def_id());
        context.require_helper_coverage = require_helper_coverage;
        let mut hasher = StableHasher::new();
        self.hash_declaration_types(key.to_def_id(), &mut context, &mut hasher);
        if anonymous {
            self.tcx
                .hir_body_owned_by(local)
                .stable_hash(&mut context, &mut hasher);
            context.hash_body_dependency(local, &mut hasher);
            context.check_body_coverage(self.tcx.hir_body_owned_by(local));
        } else {
            self.hash_owner_attributes(owner, &mut context, &mut hasher);
            nodes.node().stable_hash(&mut context, &mut hasher);
            nodes.bodies.stable_hash(&mut context, &mut hasher);
            context.hash_body_dependencies(owner, &mut hasher);
        }
        let evidence = (
            hasher.finish(),
            context.unresolved_behavior(),
            context.purpose_dependencies(),
        );
        self.behavior
            .borrow_mut()
            .insert((key, require_helper_coverage), evidence.clone());
        Some(evidence)
    }

    fn hash_owner_attributes(
        &self,
        owner: OwnerId,
        context: &mut BehaviorHashContext<'_, 'tcx>,
        hasher: &mut StableHasher,
    ) {
        "owner-attributes-v1".stable_hash(context, hasher);
        // AttributeMap.opt_hash 使用原生缓存；逐条编码属性以保留语义并忽略 Span。
        for (local, attributes) in self.tcx.hir_attr_map(owner).map.iter() {
            local.stable_hash(context, hasher);
            attributes.stable_hash(context, hasher);
        }
    }

    fn hash_declaration_types(
        &self,
        id: DefId,
        context: &mut BehaviorHashContext<'_, 'tcx>,
        hasher: &mut StableHasher,
    ) {
        let tcx = self.tcx;
        match tcx.def_kind(id) {
            DefKind::Struct | DefKind::Enum | DefKind::Union => {
                "resolved-adt-fields-v1".stable_hash(context, hasher);
                // 便携 ADT 编码保留完整 repr/variant 数据；字段类型须另取原生展开结果。
                crate::portable::hash(
                    tcx,
                    &tcx.type_of(id).instantiate_identity().skip_norm_wip(),
                    context,
                    hasher,
                );
                let arguments = ty::GenericArgs::identity_for_item(tcx, id);
                for variant in tcx.adt_def(id).variants() {
                    variant.def_id.stable_hash(context, hasher);
                    for field in &variant.fields {
                        field.did.stable_hash(context, hasher);
                        crate::portable::hash(
                            tcx,
                            &field.ty(tcx, arguments).skip_norm_wip(),
                            context,
                            hasher,
                        );
                    }
                }
            }
            DefKind::TyAlias => {
                "resolved-alias-v1".stable_hash(context, hasher);
                crate::portable::hash(
                    tcx,
                    &tcx.type_of(id).instantiate_identity().skip_norm_wip(),
                    context,
                    hasher,
                );
            }
            DefKind::AssocTy if tcx.defaultness(id).has_value() => {
                "resolved-associated-type-v1".stable_hash(context, hasher);
                crate::portable::hash(
                    tcx,
                    &tcx.type_of(id).instantiate_identity().skip_norm_wip(),
                    context,
                    hasher,
                );
            }
            DefKind::Fn | DefKind::AssocFn => {
                "resolved-signature-v1".stable_hash(context, hasher);
                crate::portable::hash(
                    tcx,
                    &tcx.fn_sig(id).instantiate_identity().skip_norm_wip(),
                    context,
                    hasher,
                );
            }
            _ => {}
        }
    }

    pub(crate) fn owning_behavior(&self) -> Fingerprint {
        if let Some(fingerprint) = *self.owning_behavior.borrow() {
            return fingerprint;
        }
        // 编译单元只输出自己的可移植语义；未知分派的全构建上下文由模型合并。
        let mut owners = BTreeMap::new();
        for local in self.tcx.hir_crate_items(()).definitions() {
            if self.tcx.def_kind(local.to_def_id()) == DefKind::SyntheticCoroutineBody {
                continue;
            }
            let owner = self.tcx.local_def_id_to_hir_id(local).owner;
            if !matches!(
                self.tcx.hir_owner_nodes(owner).node(),
                rustc_hir::OwnerNode::Synthetic
            ) {
                owners.insert(self.definition(owner.def_id.to_def_id()), owner);
            }
        }
        let mut context = BehaviorHashContext {
            identities: self,
            active: Rc::new(RefCell::new(HashSet::new())),
            include_dependencies: false,
            unresolved: Rc::new(Cell::new(false)),
            dependencies: Rc::new(RefCell::new(BTreeSet::new())),
            reference_proofs: Rc::new(RefCell::new(HashSet::new())),
            work: Rc::new(PurposeWork::new(
                DefId {
                    krate: LOCAL_CRATE,
                    index: CRATE_DEF_INDEX,
                },
                false,
            )),
            default_work: Rc::new(PurposeWork::new(
                DefId {
                    krate: LOCAL_CRATE,
                    index: CRATE_DEF_INDEX,
                },
                true,
            )),
            require_helper_coverage: false,
        };
        let mut hasher = StableHasher::new();
        "owning-hir-v2".stable_hash(&mut context, &mut hasher);
        env!("ANALYSIS_COMPILER").stable_hash(&mut context, &mut hasher);
        let session = self.tcx.sess;
        // 只约束实际 Rust 语义配置，不散列含 metadata、输出路径或运行 token 的总选项摘要。
        format!(
            "{:?}",
            (
                session.overflow_checks(),
                session.ub_checks(),
                session.contract_checks(),
                session.panic_strategy(),
                session.opts.optimize,
                session.opts.debug_assertions,
                session.sanitizers(),
                session.edition(),
                session.opts.test,
                (
                    &session.opts.cg.target_cpu,
                    &session.opts.cg.target_feature,
                    &session.opts.unstable_opts.llvm_target_feature
                ),
            )
        )
        .stable_hash(&mut context, &mut hasher);
        format!("{:?}", self.tcx.data_layout).stable_hash(&mut context, &mut hasher);
        self.tcx
            .sess
            .target
            .llvm_target
            .stable_hash(&mut context, &mut hasher);
        let mut cfg: Vec<_> = self
            .tcx
            .sess
            .config
            .iter()
            .map(|(name, value)| (name.to_string(), value.map(|value| value.to_string())))
            .collect();
        cfg.sort();
        cfg.stable_hash(&mut context, &mut hasher);
        for (identity, owner) in owners {
            identity.stable_hash(&mut context, &mut hasher);
            let nodes = self.tcx.hir_owner_nodes(owner);
            self.hash_owner_attributes(owner, &mut context, &mut hasher);
            nodes.node().stable_hash(&mut context, &mut hasher);
            nodes.bodies.stable_hash(&mut context, &mut hasher);
        }
        let fingerprint = hasher.finish();
        *self.owning_behavior.borrow_mut() = Some(fingerprint);
        fingerprint
    }
}

const PURPOSE_DEPENDENCY_WORK_LIMIT: usize = 1024;

struct PurposeWork {
    owner: DefId,
    remaining: Cell<usize>,
    reported: Cell<bool>,
    default_audit: bool,
}

impl PurposeWork {
    fn new(owner: DefId, default_audit: bool) -> Self {
        Self {
            owner,
            remaining: Cell::new(PURPOSE_DEPENDENCY_WORK_LIMIT),
            reported: Cell::new(false),
            default_audit,
        }
    }
}

pub(crate) struct BehaviorHashContext<'a, 'tcx> {
    identities: &'a Identities<'tcx>,
    active: Rc<RefCell<HashSet<DefId>>>,
    include_dependencies: bool,
    unresolved: Rc<Cell<bool>>,
    dependencies: Rc<RefCell<BTreeSet<PurposeDependency>>>,
    reference_proofs: Rc<RefCell<HashSet<(HirId, DefId)>>>,
    work: Rc<PurposeWork>,
    default_work: Rc<PurposeWork>,
    require_helper_coverage: bool,
}

impl<'a, 'tcx> BehaviorHashContext<'a, 'tcx> {
    pub(crate) fn new(identities: &'a Identities<'tcx>, owner: DefId) -> Self {
        Self {
            identities,
            active: Rc::new(RefCell::new(HashSet::from([owner]))),
            include_dependencies: true,
            unresolved: Rc::new(Cell::new(false)),
            dependencies: Rc::new(RefCell::new(BTreeSet::new())),
            reference_proofs: Rc::new(RefCell::new(HashSet::new())),
            work: Rc::new(PurposeWork::new(owner, false)),
            default_work: Rc::new(PurposeWork::new(owner, true)),
            require_helper_coverage: false,
        }
    }

    pub(crate) fn unmodeled(identities: &'a Identities<'tcx>, owner: DefId) -> Self {
        let mut context = Self::new(identities, owner);
        context.include_dependencies = false;
        context.unresolved.set(true);
        context
    }

    fn take_dependency_work(&self) -> bool {
        let remaining = self.work.remaining.get();
        if remaining != 0 {
            self.work.remaining.set(remaining - 1);
            return true;
        }
        self.unresolved.set(true);
        if !self.work.reported.replace(true) {
            self.record_semantic_gap(
                self.work.owner,
                "purpose-work-budget",
                &format!(
                    "{}超过每声明 {} 次依赖展开预算，局部证据未认证完整",
                    if self.work.default_audit {
                        "默认项语义审计"
                    } else {
                        "用途分析"
                    },
                    PURPOSE_DEPENDENCY_WORK_LIMIT
                ),
            );
        }
        false
    }

    pub(crate) fn unresolved_behavior(&self) -> bool {
        self.unresolved.get()
    }

    pub(crate) fn purpose_dependencies(&self) -> Vec<PurposeDependency> {
        self.dependencies.borrow().iter().cloned().collect()
    }

    pub(crate) fn require_helper_coverage(&mut self) {
        self.require_helper_coverage = true;
    }

    pub(crate) fn hash_body_dependencies(&mut self, owner: OwnerId, hasher: &mut StableHasher) {
        let bodies = self
            .identities
            .bodies
            .get(&owner)
            .cloned()
            .unwrap_or_default();
        for local in bodies {
            self.hash_body_dependency(local, hasher);
        }
        self.check_owner_coverage(owner);
    }

    fn hash_body_dependency(&mut self, local: LocalDefId, hasher: &mut StableHasher) {
        let tcx = self.identities.tcx;
        if !tcx.is_mir_available(local.to_def_id()) {
            self.record_semantic_gap(
                local.to_def_id(),
                "typed-behavior",
                "本地初始化或函数体没有可用原生 MIR，无法认证完整 typed 语义",
            );
            return;
        }
        TypedConstantVisitor {
            tcx,
            types: tcx.typeck(local),
            env: TypingEnv::post_analysis(tcx, local.to_def_id()),
            context: self,
            hasher,
        }
        .visit_body(tcx.hir_body_owned_by(local));
        let id = local.to_def_id();
        let body = match tcx.def_kind(id) {
            DefKind::Fn | DefKind::AssocFn
                if tcx.is_const_fn(id) || tcx.is_conditionally_const(id) =>
            {
                tcx.mir_for_ctfe(id)
            }
            DefKind::Fn | DefKind::AssocFn | DefKind::Closure => tcx.optimized_mir(id),
            DefKind::Const | DefKind::AssocConst | DefKind::AnonConst | DefKind::Static { .. } => {
                tcx.mir_for_ctfe(id)
            }
            _ => {
                self.record_semantic_gap(
                    id,
                    "typed-behavior",
                    "当前 HIR body 种类没有已认证的函数或初始化 MIR 入口",
                );
                return;
            }
        };
        "local-typed-mir-v1".stable_hash(self, hasher);
        self.hash_mir(id, body, hasher);
    }

    pub(crate) fn hash_mir(
        &self,
        owner: DefId,
        body: &'tcx rustc_middle::mir::Body<'tcx>,
        hasher: &mut StableHasher,
    ) {
        use rustc_middle::mir::visit::Visitor as _;
        MirSemanticCoverage {
            context: self,
            owner,
        }
        .visit_body(body);
        // 独立编码器忽略 Span、展开真实类型；不读写 rustc 原生 TypeId/StableHash 缓存。
        crate::portable::hash(self.identities.tcx, body, self, hasher);
    }

    pub(crate) fn ctfe_mir_available(&self, id: DefId) -> bool {
        let tcx = self.identities.tcx;
        if id.is_local() {
            return tcx.is_mir_available(id);
        }
        if tcx.is_foreign_item(id)
            || tcx.intrinsic(id).is_some()
            || !tcx.defaultness(id).has_value()
        {
            return false;
        }
        // 此 nightly 的 is_mir_available 只检查外部 optimized_mir 表。
        // 原生 encoder 对有体 const fn 总是编码 CTFE；非平凡常量同样独立编码 CTFE。
        match tcx.def_kind(id) {
            DefKind::Fn | DefKind::AssocFn => tcx.is_const_fn(id),
            DefKind::Const | DefKind::AssocConst | DefKind::AnonConst => {
                tcx.trivial_const(id).is_none()
            }
            _ => false,
        }
    }

    fn audit_trait_default(&self, id: DefId) {
        let tcx = self.identities.tcx;
        if !tcx.defaultness(id).has_value()
            || (tcx.def_kind(id) == DefKind::AssocConst && tcx.trivial_const(id).is_some())
        {
            return;
        }
        if !self.ctfe_mir_available(id) {
            self.record_semantic_gap(
                id,
                "constant-behavior",
                "关联项默认体没有可用原生 MIR，不能认证其编译器与布局依赖",
            );
            return;
        }
        // 默认项正文属于独立 inventory；此处只传播缺证，不混入声明局部用途散列。
        let audit = Self {
            identities: self.identities,
            active: self.active.clone(),
            include_dependencies: true,
            unresolved: self.unresolved.clone(),
            dependencies: Rc::new(RefCell::new(BTreeSet::new())),
            reference_proofs: Rc::new(RefCell::new(HashSet::new())),
            // 所有默认项审计独立于声明正文，但相互及递归共享同一审计预算。
            work: self.default_work.clone(),
            default_work: self.default_work.clone(),
            require_helper_coverage: true,
        };
        if !audit.take_dependency_work() {
            return;
        }
        let mut discarded = StableHasher::new();
        audit.hash_mir(id, tcx.mir_for_ctfe(id), &mut discarded);
    }

    fn record_semantic_gap(&self, owner: DefId, kind: &str, reason: &str) {
        self.unresolved.set(true);
        let owner = format!("decl-{}", self.identities.definition(owner));
        self.identities.gaps.borrow_mut().insert(
            format!("{kind}:{owner}"),
            Gap {
                owner,
                kind: kind.into(),
                reason: format!("{reason}；用途须保守回退。"),
                source: None,
            },
        );
    }

    fn check_owner_coverage(&self, owner: OwnerId) {
        let mut visitor =
            ReferenceCoverage::new(self.identities.tcx, self.reference_proofs.borrow().clone());
        match self.identities.tcx.hir_owner_nodes(owner).node() {
            rustc_hir::OwnerNode::Item(node) => visitor.visit_item(node),
            rustc_hir::OwnerNode::TraitItem(node) => visitor.visit_trait_item(node),
            rustc_hir::OwnerNode::ImplItem(node) => visitor.visit_impl_item(node),
            rustc_hir::OwnerNode::ForeignItem(node) => visitor.visit_foreign_item(node),
            rustc_hir::OwnerNode::Crate(..) | rustc_hir::OwnerNode::Synthetic => {}
        }
        self.record_coverage_gap(owner.def_id, visitor.missing.len());
    }

    fn check_body_coverage(&self, body: &'tcx rustc_hir::Body<'tcx>) {
        let mut visitor =
            ReferenceCoverage::new(self.identities.tcx, self.reference_proofs.borrow().clone());
        visitor.visit_body(body);
        self.record_coverage_gap(
            self.identities.tcx.hir_body_owner_def_id(body.id()),
            visitor.missing.len(),
        );
    }

    fn record_coverage_gap(&self, owner: LocalDefId, missing: usize) {
        if missing == 0 {
            return;
        }
        self.unresolved.set(true);
        let owner = format!("decl-{}", self.identities.definition(owner.to_def_id()));
        self.identities.gaps.borrow_mut().insert(format!("purpose-coverage:{owner}"), Gap {
            owner,
            kind: "purpose-coverage".into(),
            reason: format!("有 {missing} 个关联引用或约束未获得匹配的原生 HIR 身份与完整实参证明；用途须使用完整 owning 编译单元上下文回退。"),
            source: None,
        });
    }
}

/// 独立于采集器的语法位置检查；只在当前编译器会话内比较精确 HIR/DefId。
struct ReferenceCoverage<'tcx> {
    tcx: TyCtxt<'tcx>,
    types: Option<&'tcx TypeckResults<'tcx>>,
    proven: HashSet<(HirId, DefId)>,
    missing: HashSet<HirId>,
}

impl<'tcx> ReferenceCoverage<'tcx> {
    fn new(tcx: TyCtxt<'tcx>, proven: HashSet<(HirId, DefId)>) -> Self {
        Self {
            tcx,
            types: None,
            proven,
            missing: HashSet::new(),
        }
    }

    fn reference(&mut self, hir_id: HirId, kind: DefKind, id: DefId) {
        let required = kind == DefKind::AssocConst
            || (kind == DefKind::AssocFn
                && (self.tcx.is_const_fn(id) || self.tcx.is_conditionally_const(id)));
        if kind == DefKind::AssocTy || (required && !self.proven.contains(&(hir_id, id))) {
            self.missing.insert(hir_id);
        }
    }
}

impl<'tcx> Visitor<'tcx> for ReferenceCoverage<'tcx> {
    type NestedFilter = rustc_middle::hir::nested_filter::OnlyBodies;

    fn maybe_tcx(&mut self) -> Self::MaybeTyCtxt {
        self.tcx
    }

    fn visit_body(&mut self, body: &rustc_hir::Body<'tcx>) {
        let previous = self.types;
        let owner = self.tcx.hir_body_owner_def_id(body.id());
        self.types = self
            .tcx
            .is_mir_available(owner.to_def_id())
            .then(|| self.tcx.typeck(owner));
        if self.types.is_none() {
            self.missing.insert(body.value.hir_id);
        }
        intravisit::walk_body(self, body);
        self.types = previous;
    }

    fn visit_qpath(
        &mut self,
        path: &'tcx rustc_hir::QPath<'tcx>,
        hir_id: HirId,
        _: rustc_span::Span,
    ) {
        match path {
            rustc_hir::QPath::Resolved(_, path) => {
                if let rustc_hir::def::Res::Def(kind, id) = path.res {
                    self.reference(hir_id, kind, id);
                }
            }
            rustc_hir::QPath::TypeRelative(..) => {
                if let Some(types) = self.types.filter(|types| types.hir_owner == hir_id.owner)
                    && let Some((kind, id)) = types.type_dependent_def(hir_id)
                {
                    self.reference(hir_id, kind, id);
                } else if !self
                    .proven
                    .iter()
                    .any(|(proven_id, _)| *proven_id == hir_id)
                {
                    // 签名、const arg 或后续新增语法位置不能借同一行/同名表达式代证。
                    self.missing.insert(hir_id);
                }
            }
        }
        intravisit::walk_qpath(self, path, hir_id);
    }

    fn visit_expr(&mut self, expression: &'tcx Expr<'tcx>) {
        if matches!(expression.kind, ExprKind::MethodCall(..)) {
            if let Some(types) = self
                .types
                .filter(|types| types.hir_owner == expression.hir_id.owner)
                && let Some((kind, id)) = types.type_dependent_def(expression.hir_id)
            {
                self.reference(expression.hir_id, kind, id);
            } else {
                self.missing.insert(expression.hir_id);
            }
        }
        intravisit::walk_expr(self, expression);
    }

    fn visit_assoc_item_constraint(
        &mut self,
        constraint: &'tcx rustc_hir::AssocItemConstraint<'tcx>,
    ) {
        self.missing.insert(constraint.hir_id);
        intravisit::walk_assoc_item_constraint(self, constraint);
    }
}

struct MirSemanticCoverage<'a, 'b, 'tcx> {
    context: &'a BehaviorHashContext<'b, 'tcx>,
    owner: DefId,
}

impl<'tcx> rustc_middle::mir::visit::Visitor<'tcx> for MirSemanticCoverage<'_, '_, 'tcx> {
    fn visit_rvalue(
        &mut self,
        value: &rustc_middle::mir::Rvalue<'tcx>,
        location: rustc_middle::mir::Location,
    ) {
        if matches!(
            value,
            rustc_middle::mir::Rvalue::Cast(
                rustc_middle::mir::CastKind::Transmute
                    | rustc_middle::mir::CastKind::BoxDerefTransmute,
                ..
            )
        ) {
            self.context.record_semantic_gap(
                self.owner,
                "layout-behavior",
                "位级重解释依赖尚未认证的实际布局与有效性约束，名义类型证据不足",
            );
        }
        self.super_rvalue(value, location);
    }

    fn visit_statement(
        &mut self,
        statement: &rustc_middle::mir::Statement<'tcx>,
        location: rustc_middle::mir::Location,
    ) {
        if matches!(
            statement.kind,
            rustc_middle::mir::StatementKind::Intrinsic(..)
        ) {
            self.context.record_semantic_gap(
                self.owner,
                "intrinsic-behavior",
                "原生 intrinsic 语句的编译器语义未由 Rust 函数体完整认证",
            );
        }
        self.super_statement(statement, location);
    }
}

struct TypedConstantVisitor<'a, 'b, 'tcx> {
    tcx: TyCtxt<'tcx>,
    types: &'tcx TypeckResults<'tcx>,
    env: TypingEnv<'tcx>,
    context: &'a mut BehaviorHashContext<'b, 'tcx>,
    hasher: &'a mut StableHasher,
}

impl<'tcx> Visitor<'tcx> for TypedConstantVisitor<'_, '_, 'tcx> {
    fn visit_expr(&mut self, expression: &'tcx Expr<'tcx>) {
        if matches!(expression.kind, ExprKind::OffsetOf(..)) {
            self.context.record_semantic_gap(
                expression.hir_id.owner.def_id.to_def_id(),
                "layout-behavior",
                "offset_of! 依赖实际字段布局，完整类型实参不能替代布局证书",
            );
        }
        let definition = match &expression.kind {
            ExprKind::Path(path) => match self.types.qpath_res(path, expression.hir_id) {
                rustc_hir::def::Res::Def(kind, id) => Some((kind, id)),
                _ => None,
            },
            ExprKind::MethodCall(..) => self
                .types
                .type_dependent_def_id(expression.hir_id)
                .map(|id| (self.tcx.def_kind(id), id)),
            _ => None,
        };
        if let Some((kind, id)) = definition {
            self.reference(expression.hir_id, kind, id);
        }
        intravisit::walk_expr(self, expression);
    }

    fn visit_pat_expr(&mut self, expression: &'tcx rustc_hir::PatExpr<'tcx>) {
        if let rustc_hir::PatExprKind::Path(path) = &expression.kind
            && let rustc_hir::def::Res::Def(kind, id) =
                self.types.qpath_res(path, expression.hir_id)
        {
            self.reference(expression.hir_id, kind, id);
        }
        intravisit::walk_pat_expr(self, expression);
    }
}

impl<'tcx> TypedConstantVisitor<'_, '_, 'tcx> {
    fn reference(&mut self, hir_id: HirId, kind: DefKind, id: DefId) {
        if matches!(
            kind,
            DefKind::Const | DefKind::AssocConst | DefKind::Static { .. }
        ) || (matches!(kind, DefKind::Fn | DefKind::AssocFn)
            && (self.tcx.is_const_fn(id) || self.tcx.is_conditionally_const(id)))
        {
            // for 等展开路径不一定写入 node_args；函数项类型仍保留完整的真实实参。
            let args = if let Some(ty) = self.types.node_type_opt(hir_id)
                && let ty::FnDef(function, args) = ty.kind()
                && *function == id
            {
                self.tcx.instantiate_bound_regions_with_erased(*args)
            } else {
                self.types.node_args(hir_id)
            };
            if args.len() != self.tcx.generics_of(id).count() {
                self.context.unresolved.set(true);
                return;
            }
            let resolved = if matches!(kind, DefKind::AssocConst | DefKind::AssocFn) {
                match Instance::try_resolve(self.tcx, self.env, id, args) {
                    Ok(Some(instance)) => instance.def_id(),
                    Ok(None) => id,
                    Err(_) => {
                        self.context.unresolved.set(true);
                        id
                    }
                }
            } else {
                id
            };
            resolved.stable_hash(self.context, self.hasher);
            crate::portable::hash(self.tcx, &args, self.context, self.hasher);
            self.context
                .reference_proofs
                .borrow_mut()
                .insert((hir_id, id));
        }
    }
}

impl StableHashCtxt for BehaviorHashContext<'_, '_> {
    fn stable_hash_span(&mut self, _: RawSpan, _: &mut StableHasher) {}
    fn def_path_hash(&self, id: RawDefId) -> Fingerprint {
        let id = DefId::from_raw_def_id(id);
        let identity = self.identities.definition(id);
        let hash = Sha256::digest(identity.as_bytes());
        let base = Fingerprint::new(
            u64::from_le_bytes(hash[..8].try_into().unwrap()),
            u64::from_le_bytes(hash[8..16].try_into().unwrap()),
        );
        let tcx = self.identities.tcx;
        if self.include_dependencies
            && let Some(intrinsic) = tcx.intrinsic(id)
        {
            self.record_semantic_gap(
                id,
                "intrinsic-behavior",
                &format!(
                    "原生 intrinsic {} 的编译器行为与布局依赖尚未认证",
                    intrinsic.name
                ),
            );
            return base;
        }
        // 未规范化关联类型可改变后续 const 分派；没有覆盖证明时保留全构建回退。
        if self.include_dependencies && tcx.def_kind(id) == DefKind::AssocTy {
            self.unresolved.set(true);
        }
        let const_function = matches!(tcx.def_kind(id), DefKind::Fn | DefKind::AssocFn)
            && (tcx.is_const_fn(id) || tcx.is_conditionally_const(id));
        if self.require_helper_coverage
            && matches!(tcx.def_kind(id), DefKind::Fn | DefKind::AssocFn)
            && !const_function
            && !self.active.borrow().contains(&id)
        {
            // 普通 helper 由模型调用图覆盖；inventory 没有该闭包时不能证明成员用途完整。
            self.unresolved.set(true);
        }
        if !self.include_dependencies
            || !(const_function
                || matches!(
                    tcx.def_kind(id),
                    DefKind::Const
                        | DefKind::AssocConst
                        | DefKind::AnonConst
                        | DefKind::Static { .. }
                ))
            || !self.active.borrow_mut().insert(id)
        {
            return base;
        }
        if !self.take_dependency_work() {
            self.active.borrow_mut().remove(&id);
            return base;
        }
        let mut context = Self {
            identities: self.identities,
            active: self.active.clone(),
            include_dependencies: self.include_dependencies,
            unresolved: self.unresolved.clone(),
            dependencies: self.dependencies.clone(),
            reference_proofs: self.reference_proofs.clone(),
            work: self.work.clone(),
            default_work: self.default_work.clone(),
            require_helper_coverage: self.require_helper_coverage,
        };
        let mut hasher = StableHasher::new();
        base.stable_hash(&mut context, &mut hasher);
        // 函数对 const/static 的真正引用才加入初始化证据；不读取同文件的无关声明。
        if matches!(tcx.def_kind(id), DefKind::AssocConst | DefKind::AssocFn)
            && tcx.associated_item(id).container == ty::AssocContainer::Trait
        {
            self.identities
                .requested_traits
                .borrow_mut()
                .insert(tcx.parent(id));
            self.dependencies.borrow_mut().insert(PurposeDependency {
                trait_id: format!("decl-{}", self.identities.definition(tcx.parent(id))),
                member_id: format!("decl-{identity}"),
            });
            context.audit_trait_default(id);
            self.identities.gaps.borrow_mut().insert(identity.clone(), Gap { owner: format!("decl-{identity}"), kind: "constant-dispatch".into(), reason: "关联项引用尚未绑定具体 impl；用途依赖独立记录，模型须核验全构建 trait/impl 覆盖证明，不能证明时使用完整 owning 编译单元摘要回退。".into(), source: None });
        } else if let Some(local) = id.as_local() {
            if tcx.def_kind(id) == DefKind::AnonConst {
                // 匿名常量共享外层 HIR owner；只散列自身 body，避免兄弟常量相互展开整个 owner。
                tcx.hir_body_owned_by(local)
                    .stable_hash(&mut context, &mut hasher);
                context.hash_body_dependency(local, &mut hasher);
                context.check_body_coverage(tcx.hir_body_owned_by(local));
            } else {
                let owner = tcx.local_def_id_to_hir_id(local).owner;
                let nodes = tcx.hir_owner_nodes(owner);
                self.identities
                    .hash_owner_attributes(owner, &mut context, &mut hasher);
                self.identities.hash_declaration_types(
                    owner.def_id.to_def_id(),
                    &mut context,
                    &mut hasher,
                );
                nodes.node().stable_hash(&mut context, &mut hasher);
                nodes.bodies.stable_hash(&mut context, &mut hasher);
                context.hash_body_dependencies(owner, &mut hasher);
            }
        } else if matches!(tcx.def_kind(id), DefKind::Static { .. }) && !tcx.is_foreign_item(id) {
            format!("{:?}", tcx.def_kind(id)).stable_hash(&mut context, &mut hasher);
            crate::portable::hash(
                tcx,
                &tcx.type_of(id).instantiate_identity().skip_norm_wip(),
                &context,
                &mut hasher,
            );
            match tcx.eval_static_initializer(id) {
                Ok(allocation) => {
                    crate::portable::hash_allocation(tcx, &allocation, &context, &mut hasher)
                }
                Err(_) => {
                    self.unresolved.set(true);
                }
            }
        } else if !matches!(tcx.def_kind(id), DefKind::Static { .. })
            && tcx.defaultness(id).has_value()
        {
            if let Some(value) = (!const_function).then(|| tcx.trivial_const(id)).flatten() {
                crate::portable::hash(tcx, &value, &context, &mut hasher);
            } else if context.ctfe_mir_available(id) {
                context.hash_mir(id, tcx.mir_for_ctfe(id), &mut hasher);
            } else {
                self.record_semantic_gap(
                    id,
                    "constant-behavior",
                    "引用没有可用的原生初始化或 const 函数 MIR",
                );
            }
        } else {
            self.unresolved.set(true);
            format!("{:?}", tcx.def_kind(id)).stable_hash(&mut context, &mut hasher);
            tcx.is_foreign_item(id)
                .stable_hash(&mut context, &mut hasher);
            crate::portable::hash(
                tcx,
                &tcx.type_of(id).instantiate_identity().skip_norm_wip(),
                &context,
                &mut hasher,
            );
            self.identities.gaps.borrow_mut().insert(identity.clone(), Gap { owner: format!("decl-{identity}"), kind: "constant-behavior".into(), reason: "引用没有可用的 Rust 初始化体；模型必须使用完整 owning 编译单元语义摘要保守约束用途，不能仅凭定义身份复用。".into(), source: None });
        }
        self.active.borrow_mut().remove(&id);
        hasher.finish()
    }
    fn stable_hash_controls(&self) -> StableHashControls {
        StableHashControls { hash_spans: false }
    }
    fn assert_default_stable_hash_controls(&self, _: &str) {
        // HIR 的跨度不参与用途；类型、MIR 和分配证据由独立编码器处理，避免共享原生类型哈希缓存。
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustc_driver::{Callbacks, Compilation};
    use rustc_hir::def_id::CRATE_DEF_ID;
    use rustc_interface::interface;
    use std::{fs, path::PathBuf, process::Command};

    #[derive(Clone, Copy)]
    enum HashWarmup {
        NativeOnly,
        PortableType,
        PortableArguments,
        NativeThenPortableType,
        HirOnly,
    }

    struct NativeTypeId {
        warmup: HashWarmup,
        value: Option<u128>,
        evidence: Option<Fingerprint>,
    }

    impl Callbacks for NativeTypeId {
        fn after_analysis<'tcx>(
            &mut self,
            _: &interface::Compiler,
            tcx: TyCtxt<'tcx>,
        ) -> Compilation {
            let structure = |name| {
                tcx.hir_crate_items(())
                    .definitions()
                    .find(|local| {
                        let id = local.to_def_id();
                        tcx.def_kind(id) == DefKind::Struct && tcx.item_name(id).as_str() == name
                    })
                    .unwrap()
                    .to_def_id()
            };
            let marker = tcx
                .type_of(structure("Marker"))
                .instantiate_identity()
                .skip_norm_wip();
            let args = tcx.mk_args(&[marker.into()]);
            let wrapper = structure("Wrapper");
            let ty = tcx.type_of(wrapper).instantiate(tcx, args).skip_norm_wip();
            let identities = Identities::new(tcx, &[]).unwrap();
            let mut context = BehaviorHashContext::new(&identities, CRATE_DEF_ID.to_def_id());
            let mut hasher = StableHasher::new();
            match self.warmup {
                HashWarmup::NativeOnly => {}
                HashWarmup::PortableType => crate::portable::hash(tcx, &ty, &context, &mut hasher),
                HashWarmup::PortableArguments => {
                    crate::portable::hash(tcx, &args, &context, &mut hasher)
                }
                HashWarmup::NativeThenPortableType => {
                    let native = tcx.type_id_hash(ty);
                    crate::portable::hash(tcx, &ty, &context, &mut hasher);
                    assert_eq!(native, tcx.type_id_hash(ty));
                }
                HashWarmup::HirOnly => {
                    let owner = tcx.local_def_id_to_hir_id(wrapper.expect_local()).owner;
                    let nodes = tcx.hir_owner_nodes(owner);
                    nodes.node().stable_hash(&mut context, &mut hasher);
                    nodes.bodies.stable_hash(&mut context, &mut hasher);
                }
            }
            self.evidence = Some(hasher.finish());
            self.value = Some(tcx.type_id_hash(ty).as_u128());
            Compilation::Stop
        }
    }

    #[test]
    fn portable_type_and_argument_hashing_preserves_native_type_ids() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/rustc-analysis/fixtures/native-type-id-isolation");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("lib.rs");
        fs::write(
            &source,
            "pub struct Marker;\npub struct Wrapper<T> { pub value: T }\n",
        )
        .unwrap();
        let compiler = Command::new("rustc")
            .args(["--print", "sysroot"])
            .output()
            .unwrap();
        assert!(compiler.status.success());
        let sysroot = String::from_utf8(compiler.stdout).unwrap();
        let arguments = vec![
            "rustc".into(),
            source.to_string_lossy().into_owned(),
            "--crate-name=native_type_id_isolation".into(),
            "--crate-type=lib".into(),
            "--edition=2024".into(),
            "--sysroot".into(),
            sysroot.trim().into(),
            "--out-dir".into(),
            root.to_string_lossy().into_owned(),
        ];
        let mut values = vec![];
        let mut evidence = vec![];
        // 每种顺序使用全新 rustc 会话，确保便携哈希不能改变后续代码生成依赖的原生 TypeId。
        for (warmup, metadata) in [
            (HashWarmup::NativeOnly, "a"),
            (HashWarmup::PortableType, "a"),
            (HashWarmup::PortableArguments, "a"),
            (HashWarmup::NativeThenPortableType, "a"),
            (HashWarmup::PortableType, "b"),
            (HashWarmup::NativeThenPortableType, "b"),
            (HashWarmup::HirOnly, "a"),
        ] {
            let mut callback = NativeTypeId {
                warmup,
                value: None,
                evidence: None,
            };
            let mut arguments = arguments.clone();
            arguments.push(format!("-Cmetadata={metadata}"));
            rustc_driver::compiler_entrypoint(&arguments, &mut callback);
            values.push(callback.value.unwrap());
            evidence.push(callback.evidence.unwrap());
        }
        assert_eq!(
            values[..4],
            vec![values[0]; 4],
            "Portable Ty/GenericArgs evidence must not pollute rustc's native hash caches"
        );
        assert_eq!(values[4], values[5]);
        assert_eq!(
            values[0], values[6],
            "HIR-only hashing must leave native type caches intact"
        );
        assert_eq!(
            [evidence[1], evidence[3], evidence[4], evidence[5]],
            [evidence[1]; 4],
            "Native prewarming and Cargo metadata must not change portable type evidence"
        );
    }

    struct DynamicTypeEvidence {
        origins: Vec<PackageOrigin>,
        result: Option<(Fingerprint, Vec<String>)>,
    }

    impl Callbacks for DynamicTypeEvidence {
        fn after_analysis<'tcx>(
            &mut self,
            _: &interface::Compiler,
            tcx: TyCtxt<'tcx>,
        ) -> Compilation {
            let function = tcx
                .hir_body_owners()
                .find(|local| {
                    tcx.def_kind(local.to_def_id()) == DefKind::Fn
                        && tcx.item_name(local.to_def_id()).as_str() == "target"
                })
                .unwrap();
            let signature = tcx
                .fn_sig(function.to_def_id())
                .instantiate_identity()
                .skip_norm_wip();
            let ty = tcx
                .instantiate_bound_regions_with_erased(signature)
                .inputs()[0];
            let ty::Dynamic(predicates, _) = ty.peel_refs().kind() else {
                panic!("The fixture must contain a trait object");
            };
            let order = predicates
                .iter()
                .map(|predicate| match predicate.skip_binder() {
                    ty::ExistentialPredicate::AutoTrait(id) => tcx.crate_name(id.krate).to_string(),
                    _ => panic!("The fixture must contain only auto traits"),
                })
                .collect();
            let native = tcx.type_id_hash(ty);
            let identities = Identities::new(tcx, &self.origins).unwrap();
            let context = BehaviorHashContext::new(&identities, function.to_def_id());
            let mut hasher = StableHasher::new();
            crate::portable::hash(tcx, &ty, &context, &mut hasher);
            assert_eq!(native, tcx.type_id_hash(ty));
            self.result = Some((hasher.finish(), order));
            Compilation::Stop
        }
    }

    #[test]
    fn portable_dynamic_predicates_ignore_native_metadata_order_and_preserve_members() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/rustc-analysis/fixtures/dynamic-predicate-order");
        let dependency_a = root.join("dep_a");
        let dependency_b = root.join("dep_b");
        let consumer = root.join("consumer");
        for directory in [&dependency_a, &dependency_b, &consumer] {
            fs::create_dir_all(directory).unwrap();
        }
        let source_a = dependency_a.join("lib.rs");
        let source_b = dependency_b.join("lib.rs");
        let consumer_source = consumer.join("lib.rs");
        fs::write(
            &consumer_source,
            "pub fn target(_: &'static (dyn dep_a::Marker + dep_b::Marker)) {}\n",
        )
        .unwrap();
        for source in [&source_a, &source_b] {
            fs::write(
                source,
                "#![feature(auto_traits)]\npub auto trait Marker {}\n",
            )
            .unwrap();
        }
        let artifact_a = dependency_a.join("libdep_a.rlib");
        let artifact_b = dependency_b.join("libdep_b.rlib");
        let compile_dependency = |source: &Path, name: &str, metadata: &str, artifact: &Path| {
            let result = Command::new("rustc")
                .arg(source)
                .args(["--crate-type=rlib", "--edition=2024"])
                .arg(format!("--crate-name={name}"))
                .arg(format!("-Cmetadata={metadata}"))
                .arg("-o")
                .arg(artifact)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        };
        compile_dependency(&source_b, "dep_b", "fixed", &artifact_b);
        let origins = [
            (&dependency_a, &source_a, "dep_a"),
            (&dependency_b, &source_b, "dep_b"),
            (&consumer, &consumer_source, "consumer"),
        ]
        .into_iter()
        .map(|(directory, source, name)| PackageOrigin {
            root: normalized(directory).unwrap(),
            identity: format!("exact-package:{name}:1"),
            targets: vec![analysis_contract::PackageTargetOrigin {
                source: normalized(source).unwrap(),
                name: name.into(),
                kind: vec!["lib".into()],
            }],
        })
        .collect::<Vec<_>>();
        let compiler = Command::new("rustc")
            .args(["--print", "sysroot"])
            .output()
            .unwrap();
        assert!(compiler.status.success());
        let sysroot = String::from_utf8(compiler.stdout).unwrap();
        let arguments = vec![
            "rustc".into(),
            consumer_source.to_string_lossy().into_owned(),
            "--crate-name=consumer".into(),
            "--crate-type=lib".into(),
            "--edition=2024".into(),
            "--sysroot".into(),
            sysroot.trim().into(),
            "--out-dir".into(),
            consumer.to_string_lossy().into_owned(),
            "--extern".into(),
            format!("dep_a={}", artifact_a.display()),
            "--extern".into(),
            format!("dep_b={}", artifact_b.display()),
        ];
        let mut hashes = vec![];
        let mut orders = HashSet::new();
        // 两个外部 crate 的原生排序确实反转后才结束；固定种子不是概率性时间阈值。
        for seed in 0..16 {
            compile_dependency(&source_a, "dep_a", &format!("metadata-{seed}"), &artifact_a);
            let mut callback = DynamicTypeEvidence {
                origins: origins.clone(),
                result: None,
            };
            rustc_driver::compiler_entrypoint(&arguments, &mut callback);
            let (hash, order) = callback.result.unwrap();
            hashes.push(hash);
            orders.insert(order);
            if orders.len() == 2 {
                break;
            }
        }
        assert_eq!(
            orders.len(),
            2,
            "The fixture must observe both native predicate orders"
        );
        assert!(
            hashes.iter().all(|hash| *hash == hashes[0]),
            "Native predicate order must not enter portable evidence"
        );
        fs::write(
            &consumer_source,
            "pub fn target(_: &'static dyn dep_a::Marker) {}\n",
        )
        .unwrap();
        let mut callback = DynamicTypeEvidence {
            origins,
            result: None,
        };
        rustc_driver::compiler_entrypoint(&arguments, &mut callback);
        assert_ne!(
            hashes[0],
            callback.result.unwrap().0,
            "Changing the auto-trait set must change portable evidence"
        );
    }

    struct AnonymousConstantHash {
        fingerprint: Option<Fingerprint>,
    }

    impl Callbacks for AnonymousConstantHash {
        fn after_analysis<'tcx>(
            &mut self,
            _: &interface::Compiler,
            tcx: TyCtxt<'tcx>,
        ) -> Compilation {
            let local = tcx
                .hir_body_owners()
                .find(|local| {
                    let id = local.to_def_id();
                    if tcx.def_kind(id) != DefKind::AnonConst {
                        return false;
                    }
                    let field = tcx.parent(id);
                    tcx.def_kind(field) == DefKind::Field
                        && tcx.item_name(tcx.parent(field)).as_str() == "Selected"
                })
                .unwrap();
            let identities = Identities::new(tcx, &[]).unwrap();
            let owner = tcx.local_def_id_to_hir_id(local).owner;
            let mut context = BehaviorHashContext::new(&identities, owner.def_id.to_def_id());
            let mut hasher = StableHasher::new();
            local.to_def_id().stable_hash(&mut context, &mut hasher);
            self.fingerprint = Some(hasher.finish());
            Compilation::Stop
        }
    }

    #[test]
    fn anonymous_constant_dependency_hash_uses_its_body_and_nested_dependencies() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/rustc-analysis/fixtures/anonymous-constant-scope");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("lib.rs");
        let compiler = Command::new("rustc")
            .args(["--print", "sysroot"])
            .output()
            .unwrap();
        assert!(compiler.status.success());
        let sysroot = String::from_utf8(compiler.stdout).unwrap();
        let mut hashes = vec![];
        for (selected, nested, sibling, helper, metadata, blank_lines) in [
            (2, 1, 3, 0, "a", 0),
            (5, 1, 3, 0, "a", 0),
            (2, 4, 3, 0, "a", 0),
            (2, 1, 3, 1, "a", 0),
            (2, 1, 7, 0, "a", 0),
            (2, 1, 3, 0, "b", 3),
        ] {
            fs::write(
                &source,
                format!(
                    "#![allow(dead_code)]\n{}const SELECTED: usize = {selected};\nconst NESTED: usize = {nested};\nconst SIBLING: usize = {sibling};\nconst fn selected() -> usize {{ SELECTED + {helper} }}\nenum Arrays {{ Selected([u8; {{ let _nested = [0u8; NESTED]; selected() }}]), Sibling([u8; SIBLING]), Other([u16; 4]) }}\n",
                    "\n".repeat(blank_lines)
                ),
            )
            .unwrap();
            let arguments = vec![
                "rustc".into(),
                source.to_string_lossy().into_owned(),
                "--crate-name=anonymous_constant_scope".into(),
                "--crate-type=lib".into(),
                "--edition=2024".into(),
                "--sysroot".into(),
                sysroot.trim().into(),
                "--out-dir".into(),
                root.to_string_lossy().into_owned(),
                format!("-Cmetadata={metadata}"),
            ];
            let mut callback = AnonymousConstantHash { fingerprint: None };
            rustc_driver::compiler_entrypoint(&arguments, &mut callback);
            hashes.push(callback.fingerprint.unwrap());
        }
        assert_ne!(
            hashes[0], hashes[1],
            "Referenced constants affect the body evidence"
        );
        assert_ne!(
            hashes[0], hashes[2],
            "Nested anonymous constants retain their own dependencies"
        );
        assert_ne!(
            hashes[0], hashes[3],
            "Referenced const fn bodies affect the evidence"
        );
        assert_eq!(
            hashes[0], hashes[4],
            "Sibling array lengths are outside this anonymous constant's body"
        );
        assert_eq!(
            hashes[0], hashes[5],
            "Metadata and line movement do not affect body evidence"
        );
    }
}
