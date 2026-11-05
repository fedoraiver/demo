//! 用真实磁盘增量会话检查提取器与 rustc 原生类型身份的隔离。
#![feature(rustc_private)]
extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_interface;
extern crate rustc_middle;

use analysis_contract::facts::UnitFacts;
use rustc_driver::{Callbacks, Compilation};
use rustc_hir::def::DefKind;
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct ExtractAndContinue {
    native_type_id: Option<u128>,
    facts: Option<UnitFacts>,
    previous_sessions: Option<u64>,
}

impl Callbacks for ExtractAndContinue {
    fn config(&mut self, config: &mut interface::Config) {
        config.opts.unstable_opts.metadata_crate_hash = false;
    }
    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        self.previous_sessions = Some(
            tcx.dep_graph
                .data()
                .expect("Incremental graph must be enabled")
                .session_count(),
        );
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
        let ty = tcx
            .type_of(structure("Wrapper"))
            .instantiate(tcx, args)
            .skip_norm_wip();
        let before = tcx.type_id_hash(ty).as_u128();
        let facts = analysis_compiler::ecs::extract(tcx).unwrap();
        assert_eq!(
            before,
            tcx.type_id_hash(ty).as_u128(),
            "Extraction must not contaminate rustc's TypeId cache"
        );
        self.native_type_id = Some(before);
        self.facts = Some(facts);
        // 完成代码生成和增量会话落盘，而不是仅在 after_analysis 退出。
        Compilation::Continue
    }
}

fn has_dep_graph(directory: &Path) -> bool {
    fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                has_dep_graph(&path)
            } else {
                path.file_name().is_some_and(|name| name == "dep-graph.bin")
            }
        })
}

#[test]
fn incremental_disk_sessions_preserve_native_type_id_and_portable_purpose() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures")
        .join(format!("incremental-disk-{}-{unique}", std::process::id()));
    let cache = root.join("incremental");
    fs::create_dir_all(&cache).unwrap();
    let source = root.join("lib.rs");
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let args = vec![
        "rustc".into(),
        source.to_string_lossy().into_owned(),
        "--crate-name=bevy_ecs".into(),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        sysroot.trim().into(),
        "--out-dir".into(),
        root.to_string_lossy().into_owned(),
        format!("-Cincremental={}", cache.display()),
        "-Cmetadata=incremental_fixture".into(),
        "-Zincremental-verify-ich".into(),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
    ];
    let mut sessions = Vec::new();
    for unrelated in [1, 2, 2] {
        fs::write(
            &source,
            format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub struct Marker;
pub struct Wrapper<T> {{ pub value: T }}
pub trait Config {{ const VALUE: u32; }}
impl Config for Marker {{ const VALUE: u32 = 7; }}
pub fn generic<T: Config>() -> u32 {{ T::VALUE }}
pub fn iteration(values: &[u32]) -> u32 {{ let mut n = 0; for value in values {{ n += value; }} n }}
pub fn unrelated() -> u32 {{ {unrelated} }}
"#
            ),
        )
        .unwrap();
        let mut callback = ExtractAndContinue::default();
        rustc_driver::compiler_entrypoint(&args, &mut callback);
        assert!(
            root.join("libbevy_ecs.rlib").is_file(),
            "The session must finish code generation"
        );
        assert!(
            has_dep_graph(&cache),
            "The session must persist an incremental dependency graph"
        );
        let facts = callback.facts.unwrap();
        let declaration = facts
            .declarations
            .iter()
            .find(|item| item.full_name == "bevy_ecs::generic")
            .unwrap();
        sessions.push((
            callback.native_type_id.unwrap(),
            declaration.evidence_hash.clone(),
            declaration.purpose_dependencies.clone(),
            callback.previous_sessions.unwrap(),
        ));
    }
    assert_eq!(
        (&sessions[0].0, &sessions[0].1, &sessions[0].2),
        (&sessions[1].0, &sessions[1].1, &sessions[1].2),
        "An unrelated body change must preserve native identity and portable purpose evidence"
    );
    assert_eq!(
        (&sessions[1].0, &sessions[1].1, &sessions[1].2),
        (&sessions[2].0, &sessions[2].1, &sessions[2].2),
        "A repeated disk-incremental session must preserve both identities"
    );
    assert_eq!(
        sessions[0].3, 0,
        "A new cache starts without a prior session"
    );
    assert!(
        sessions[1].3 >= 1 && sessions[2].3 > sessions[1].3,
        "Later sessions must load the previous on-disk dependency graph"
    );
    assert!(
        !sessions[0].2.is_empty(),
        "The fixture must exercise trait purpose dependencies"
    );
}
