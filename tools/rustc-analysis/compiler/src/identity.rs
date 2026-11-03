//! 定义身份使用精确包与原生消歧路径；编译器 metadata 和物理源码位置只作来源证据。
use analysis_contract::{PackageOrigin, facts::Gap, normalized};
use anyhow::{Result, ensure};
use rustc_data_structures::{
    fingerprint::Fingerprint,
    stable_hash::{
        RawDefId, RawSpan, StableHash, StableHashControls, StableHashCtxt, StableHasher,
    },
};
use rustc_hir::{
    Expr, ExprKind, OwnerId,
    def::DefKind,
    def_id::{CRATE_DEF_INDEX, CrateNum, DefId, LOCAL_CRATE, LocalDefId},
    intravisit::{self, Visitor},
};
use rustc_middle::ty::{self, Instance, TyCtxt, TypeckResults, TypingEnv};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap, HashSet},
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
            bodies,
        };
        let local = identities.crate_identity(LOCAL_CRATE);
        ensure!(
            origins.is_empty() || !local.starts_with("native:"),
            "The compiler crate root does not uniquely match a Cargo package target"
        );
        Ok(identities)
    }

    fn crate_identity(&self, krate: CrateNum) -> String {
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
        let identity = if candidates.len() == 1 {
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
        };
        let mut hasher = StableHasher::new();
        "owning-hir-v1".stable_hash(&mut context, &mut hasher);
        env!("ANALYSIS_COMPILER").stable_hash(&mut context, &mut hasher);
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
            nodes.node().stable_hash(&mut context, &mut hasher);
            nodes.bodies.stable_hash(&mut context, &mut hasher);
        }
        let fingerprint = hasher.finish();
        *self.owning_behavior.borrow_mut() = Some(fingerprint);
        fingerprint
    }
}

pub(crate) struct BehaviorHashContext<'a, 'tcx> {
    identities: &'a Identities<'tcx>,
    active: Rc<RefCell<HashSet<DefId>>>,
    include_dependencies: bool,
    unresolved: Rc<Cell<bool>>,
}

impl<'a, 'tcx> BehaviorHashContext<'a, 'tcx> {
    pub(crate) fn new(identities: &'a Identities<'tcx>, owner: DefId) -> Self {
        Self {
            identities,
            active: Rc::new(RefCell::new(HashSet::from([owner]))),
            include_dependencies: true,
            unresolved: Rc::new(Cell::new(false)),
        }
    }

    pub(crate) fn unresolved_behavior(&self) -> bool {
        self.unresolved.get()
    }

    pub(crate) fn hash_body_dependencies(&mut self, owner: OwnerId, hasher: &mut StableHasher) {
        let tcx = self.identities.tcx;
        let bodies = self
            .identities
            .bodies
            .get(&owner)
            .cloned()
            .unwrap_or_default();
        for local in bodies {
            TypedConstantVisitor {
                tcx,
                types: tcx.typeck(local),
                env: TypingEnv::post_analysis(tcx, local.to_def_id()),
                context: self,
                hasher,
            }
            .visit_body(tcx.hir_body_owned_by(local));
        }
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
        if let ExprKind::Path(path) = &expression.kind
            && let rustc_hir::def::Res::Def(kind, id) =
                self.types.qpath_res(path, expression.hir_id)
            && (matches!(
                kind,
                DefKind::Const | DefKind::AssocConst | DefKind::Static { .. }
            ) || (matches!(kind, DefKind::Fn | DefKind::AssocFn) && self.tcx.is_const_fn(id)))
        {
            let args = self.types.node_args(expression.hir_id);
            let resolved = if matches!(kind, DefKind::AssocConst | DefKind::AssocFn) {
                Instance::try_resolve(self.tcx, self.env, id, args)
                    .ok()
                    .flatten()
                    .map(|instance| instance.def_id())
                    .unwrap_or(id)
            } else {
                id
            };
            resolved.stable_hash(self.context, self.hasher);
            args.stable_hash(self.context, self.hasher);
        }
        intravisit::walk_expr(self, expression);
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
        let const_function =
            matches!(tcx.def_kind(id), DefKind::Fn | DefKind::AssocFn) && tcx.is_const_fn(id);
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
        let mut context = Self {
            identities: self.identities,
            active: self.active.clone(),
            include_dependencies: self.include_dependencies,
            unresolved: self.unresolved.clone(),
        };
        let mut hasher = StableHasher::new();
        base.stable_hash(&mut context, &mut hasher);
        // 函数对 const/static 的真正引用才加入初始化证据；不读取同文件的无关声明。
        if matches!(tcx.def_kind(id), DefKind::AssocConst | DefKind::AssocFn)
            && tcx.associated_item(id).container == ty::AssocContainer::Trait
        {
            self.unresolved.set(true);
            self.identities
                .owning_behavior()
                .stable_hash(&mut context, &mut hasher);
            self.identities.gaps.borrow_mut().insert(identity.clone(), Gap { owner: format!("decl-{identity}"), kind: "constant-dispatch".into(), reason: "关联常量引用尚未绑定具体 impl；模型必须将全部实际 owning 编译单元的可移植 HIR 摘要合入相关用途，覆盖下游实现，相关范围外的变更也可能使用途失效。".into(), source: None });
        } else if let Some(local) = id.as_local() {
            let owner = tcx.local_def_id_to_hir_id(local).owner;
            let nodes = tcx.hir_owner_nodes(owner);
            nodes.node().stable_hash(&mut context, &mut hasher);
            nodes.bodies.stable_hash(&mut context, &mut hasher);
            context.hash_body_dependencies(owner, &mut hasher);
        } else if matches!(tcx.def_kind(id), DefKind::Static { .. }) && !tcx.is_foreign_item(id) {
            format!("{:?}", tcx.def_kind(id)).stable_hash(&mut context, &mut hasher);
            tcx.type_of(id)
                .instantiate_identity()
                .stable_hash(&mut context, &mut hasher);
            match tcx.eval_static_initializer(id) {
                Ok(allocation) => allocation.stable_hash(&mut context, &mut hasher),
                Err(_) => {
                    self.unresolved.set(true);
                    self.identities
                        .owning_behavior()
                        .stable_hash(&mut context, &mut hasher);
                }
            }
        } else if !matches!(tcx.def_kind(id), DefKind::Static { .. })
            && tcx.defaultness(id).has_value()
        {
            if let Some(value) = (!const_function).then(|| tcx.trivial_const(id)).flatten() {
                value.stable_hash(&mut context, &mut hasher);
            } else {
                tcx.mir_for_ctfe(id).stable_hash(&mut context, &mut hasher);
            }
        } else {
            self.unresolved.set(true);
            format!("{:?}", tcx.def_kind(id)).stable_hash(&mut context, &mut hasher);
            tcx.is_foreign_item(id)
                .stable_hash(&mut context, &mut hasher);
            tcx.type_of(id)
                .instantiate_identity()
                .stable_hash(&mut context, &mut hasher);
            self.identities
                .owning_behavior()
                .stable_hash(&mut context, &mut hasher);
            self.identities.gaps.borrow_mut().insert(identity.clone(), Gap { owner: format!("decl-{identity}"), kind: "constant-behavior".into(), reason: "引用没有可用的 Rust 初始化体；模型必须使用完整 owning 编译单元语义摘要保守约束用途，不能仅凭定义身份复用。".into(), source: None });
        }
        self.active.borrow_mut().remove(&id);
        hasher.finish()
    }
    fn stable_hash_controls(&self) -> StableHashControls {
        StableHashControls { hash_spans: false }
    }
    fn assert_default_stable_hash_controls(&self, _: &str) {
        // 此上下文只计算独立用途证据，不参与 rustc metadata 的默认模式缓存。
    }
}
