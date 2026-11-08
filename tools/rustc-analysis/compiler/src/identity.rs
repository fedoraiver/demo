//! 定义身份使用精确包与原生消歧路径；编译器 metadata 和物理源码位置只作来源证据。
use analysis_contract::{PackageOrigin, facts::Gap, normalized};
use anyhow::{Result, ensure};
use rustc_hir::def_id::{CRATE_DEF_INDEX, CrateNum, DefId, LOCAL_CRATE};
use rustc_middle::ty::TyCtxt;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    path::Path,
};

pub(crate) struct Identities<'tcx> {
    tcx: TyCtxt<'tcx>,
    origins: Vec<PackageOrigin>,
    crates: RefCell<BTreeMap<CrateNum, String>>,
    definitions: RefCell<HashMap<DefId, String>>,
    gaps: RefCell<BTreeMap<String, Gap>>,
}

impl<'tcx> Identities<'tcx> {
    pub(crate) fn new(tcx: TyCtxt<'tcx>, origins: &[PackageOrigin]) -> Result<Self> {
        let identities = Self {
            tcx,
            origins: origins.to_vec(),
            crates: RefCell::new(BTreeMap::new()),
            definitions: RefCell::new(HashMap::new()),
            gaps: RefCell::new(BTreeMap::new()),
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
}
