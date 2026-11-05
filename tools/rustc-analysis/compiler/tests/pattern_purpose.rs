//! 模式、常量实参与未覆盖关联位置通过精确 HIR 身份约束用途复用。
#![feature(rustc_private)]
extern crate rustc_driver;
extern crate rustc_interface;
extern crate rustc_middle;

use analysis_contract::facts::{Declaration, UnitFacts};
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct Extractor {
    facts: Option<UnitFacts>,
}

impl Callbacks for Extractor {
    fn config(&mut self, config: &mut interface::Config) {
        config.opts.unstable_opts.metadata_crate_hash = false;
    }

    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        self.facts = Some(analysis_compiler::ecs::extract(tcx).unwrap());
        Compilation::Continue
    }
}

fn fixture(selected: &str, unrelated: usize) -> UnitFacts {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/pattern-purpose")
        .join(format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("lib.rs");
    fs::write(
        &source,
        format!(
            r#"
#![allow(dead_code)]
pub mod component {{ pub trait Component {{}} }}
pub trait Named {{ const VALUE: u8; }}
pub struct A;
pub struct B;
impl Named for A {{ const VALUE: u8 = 1; }}
impl Named for B {{ const VALUE: u8 = 2; }}
pub type Selected = {selected};
pub fn caller(x: u8) -> bool {{ matches!(x, Selected::VALUE) }}
pub fn ranges(x: u8) -> bool {{ matches!(x, Selected::VALUE..=7) }}
pub fn same_line(x: u8) -> bool {{ matches!(x, A::VALUE) || matches!(x, Selected::VALUE) }}
pub fn const_arg() -> [u8; Selected::VALUE as usize] {{ [0; Selected::VALUE as usize] }}
pub fn signature<T: Iterator<Item = Selected>>() -> usize {{ 0 }}
pub fn unrelated() -> usize {{ {unrelated} }}
"#
        ),
    )
    .unwrap();
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let arguments = vec![
        "rustc".into(),
        source.to_string_lossy().into_owned(),
        "--crate-name=bevy_ecs".into(),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        String::from_utf8(compiler.stdout).unwrap().trim().into(),
        "--out-dir".into(),
        root.to_string_lossy().into_owned(),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
        "-Cmetadata=pattern_purpose".into(),
    ];
    let mut extractor = Extractor::default();
    rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
    assert!(root.join("libbevy_ecs.rlib").is_file());
    extractor.facts.unwrap()
}

fn declaration(facts: &UnitFacts, name: &str) -> Declaration {
    facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == format!("bevy_ecs::{name}"))
        .unwrap()
        .clone()
}

#[test]
fn pattern_alias_and_constant_argument_references_track_their_actual_members() {
    let first = fixture("A", 1);
    let changed_alias = fixture("B", 1);
    let changed_unrelated = fixture("A", 9);
    for name in ["caller", "ranges", "same_line", "const_arg"] {
        let baseline = declaration(&first, name);
        let changed = declaration(&changed_alias, name);
        assert!(
            !baseline.unresolved_behavior,
            "{name} must have exact native reference coverage"
        );
        assert!(
            !changed.unresolved_behavior,
            "{name} must have exact native reference coverage"
        );
        assert_ne!(
            baseline.evidence_hash, changed.evidence_hash,
            "{name} must resolve the actual associated constant after the alias changes"
        );
        assert_eq!(
            baseline.evidence_hash,
            declaration(&changed_unrelated, name).evidence_hash,
            "An unrelated body must not enter {name}'s local evidence"
        );
    }
}

#[test]
fn unmodeled_associated_constraints_in_signatures_require_an_owner_fallback() {
    let first = fixture("A", 1);
    let changed_alias = fixture("B", 1);
    for facts in [&first, &changed_alias] {
        let signature = declaration(facts, "signature");
        assert!(
            signature.unresolved_behavior,
            "A non-expression association cannot silently inherit expression coverage"
        );
        assert!(
            facts
                .gaps
                .iter()
                .any(|gap| gap.owner == signature.id && gap.kind == "purpose-coverage")
        );
    }
    assert_ne!(
        first.behavior_hash, changed_alias.behavior_hash,
        "The conservative context must retain the changed alias definition"
    );
}
