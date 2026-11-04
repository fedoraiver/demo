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
        let bodies = self
            .identities
            .bodies
            .get(&owner)
            .cloned()
            .unwrap_or_default();
        for local in bodies {
            self.hash_body_dependency(local, hasher);
        }
    }

    fn hash_body_dependency(&mut self, local: LocalDefId, hasher: &mut StableHasher) {
        let tcx = self.identities.tcx;
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
            // for 等展开路径不一定写入 node_args；函数项类型仍保留完整的真实实参。
            let args = if let Some(ty) = self.types.node_type_opt(expression.hir_id)
                && let ty::FnDef(function, args) = ty.kind()
                && *function == id
            {
                self.tcx.instantiate_bound_regions_with_erased(*args)
            } else {
                self.types.node_args(expression.hir_id)
            };
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
            crate::portable::hash(self.tcx, &args, self.context, self.hasher);
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
            if tcx.def_kind(id) == DefKind::AnonConst {
                // 匿名常量共享外层 HIR owner；只散列自身 body，避免兄弟常量相互展开整个 owner。
                tcx.hir_body_owned_by(local)
                    .stable_hash(&mut context, &mut hasher);
                context.hash_body_dependency(local, &mut hasher);
            } else {
                let owner = tcx.local_def_id_to_hir_id(local).owner;
                let nodes = tcx.hir_owner_nodes(owner);
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
                    self.identities
                        .owning_behavior()
                        .stable_hash(&mut context, &mut hasher);
                }
            }
        } else if !matches!(tcx.def_kind(id), DefKind::Static { .. })
            && tcx.defaultness(id).has_value()
        {
            if let Some(value) = (!const_function).then(|| tcx.trivial_const(id)).flatten() {
                crate::portable::hash(tcx, &value, &context, &mut hasher);
            } else {
                crate::portable::hash(tcx, tcx.mir_for_ctfe(id), &context, &mut hasher);
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
