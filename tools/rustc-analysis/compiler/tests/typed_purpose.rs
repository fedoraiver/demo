//! 局部用途还必须约束别名展开后的类型行为与未建模的布局依赖。
#![feature(rustc_private)]
extern crate rustc_driver;
extern crate rustc_interface;
extern crate rustc_middle;

use analysis_contract::facts::UnitFacts;
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

fn fixture(code: &str) -> UnitFacts {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/typed-purpose")
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
        format!("#![allow(dead_code)]\npub mod component {{ pub trait Component {{}} }}\n{code}\n"),
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
        "-Cmetadata=typed_purpose".into(),
    ];
    let mut extractor = Extractor::default();
    rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
    assert!(root.join("libbevy_ecs.rlib").is_file());
    extractor.facts.unwrap()
}

fn entry(facts: &UnitFacts) -> &analysis_contract::facts::Declaration {
    facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::entry")
        .unwrap()
}

#[test]
fn primitive_alias_casts_include_the_resolved_type_behavior() {
    let versions: Vec<_> = ["u8", "u16"].into_iter().map(|selected| fixture(&format!(
        "pub type Selected = {selected};\npub fn entry(x: u64) -> u64 {{ (x as Selected) as u64 }}"
    ))).collect();
    assert_eq!(entry(&versions[0]).id, entry(&versions[1]).id);
    assert!(
        versions
            .iter()
            .all(|facts| !entry(facts).unresolved_behavior),
        "Resolved primitive aliases have complete local typed evidence"
    );
    assert_ne!(
        entry(&versions[0]).evidence_hash,
        entry(&versions[1]).evidence_hash,
        "Changing only the alias target changes cast truncation; HIR identity alone cannot certify this local purpose"
    );
}

#[test]
fn enum_alias_values_include_the_resolved_discriminant_behavior() {
    let versions: Vec<_> = ["A", "B"].into_iter().map(|selected| fixture(&format!(
        "#[derive(Clone, Copy)]\n#[repr(u8)]\npub enum A {{ X = 1 }}\n#[derive(Clone, Copy)]\n#[repr(u8)]\npub enum B {{ X = 2 }}\npub type Selected = {selected};\npub fn entry() -> u8 {{ Selected::X as u8 }}"
    ))).collect();
    assert_eq!(entry(&versions[0]).id, entry(&versions[1]).id);
    assert!(
        versions
            .iter()
            .all(|facts| !entry(facts).unresolved_behavior),
        "Resolved enum aliases must not trigger a blanket alias fallback"
    );
    assert_ne!(
        entry(&versions[0]).evidence_hash,
        entry(&versions[1]).evidence_hash,
        "Changing only the alias target changes the returned enum discriminant"
    );
}

#[test]
fn offset_of_without_layout_evidence_requires_a_conservative_fallback() {
    let versions: Vec<_> = ["u8", "u64"].into_iter().map(|before| fixture(&format!(
        "#[repr(C)]\npub struct Layout {{ pub before: {before}, pub value: u16 }}\npub fn entry() -> usize {{ std::mem::offset_of!(Layout, value) }}"
    ))).collect();
    assert_eq!(entry(&versions[0]).id, entry(&versions[1]).id);
    assert!(
        versions
            .iter()
            .all(|facts| entry(facts).unresolved_behavior),
        "The offset changes while the nominal type identity and field index stay fixed; typed MIR alone is not a layout certificate"
    );
    assert!(versions.iter().all(|facts| {
        facts
            .gaps
            .iter()
            .any(|gap| gap.kind == "layout-behavior" && gap.owner == entry(facts).id)
    }));
    assert_ne!(
        versions[0].behavior_hash, versions[1].behavior_hash,
        "The conservative context must retain the actual layout declaration change"
    );
}

#[test]
fn native_layout_intrinsics_without_a_rust_body_are_explicitly_unresolved() {
    let facts = fixture(
        "pub struct Layout { pub field: u64 }\npub fn entry() -> usize { std::mem::size_of::<Layout>() }",
    );
    assert!(entry(&facts).unresolved_behavior);
    assert!(
        facts
            .gaps
            .iter()
            .any(|gap| gap.kind == "intrinsic-behavior")
    );
}

#[test]
fn representation_attributes_change_the_owning_layout_fallback() {
    let versions: Vec<_> = ["C", "C, packed"]
        .into_iter()
        .map(|representation| {
            fixture(&format!(
                "#[repr({representation})]\npub struct Layout {{ pub before: u8, pub value: u32 }}\npub fn entry() -> usize {{ std::mem::offset_of!(Layout, value) }}"
            ))
        })
        .collect();
    assert!(
        versions
            .iter()
            .all(|facts| entry(facts).unresolved_behavior)
    );
    assert_ne!(
        versions[0].behavior_hash, versions[1].behavior_hash,
        "Changing representation alone changes the native field offset and must invalidate the conservative context"
    );
}
