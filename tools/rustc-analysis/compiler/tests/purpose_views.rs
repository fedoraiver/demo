//! 原生视图证书与 const trait 成员依赖的会话级回归。
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

struct Extractor {
    native_hir_hash: bool,
    facts: Option<UnitFacts>,
}

impl Callbacks for Extractor {
    fn config(&mut self, config: &mut interface::Config) {
        config.opts.unstable_opts.metadata_crate_hash = !self.native_hir_hash;
    }

    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        let facts = analysis_compiler::ecs::extract(tcx).unwrap();
        if self.native_hir_hash {
            for &krate in tcx.crates(()) {
                let name = tcx.crate_name(krate).to_string();
                let view = facts.purpose_inventory.required_views.iter().find(|view| {
                    serde_json::from_str::<serde_json::Value>(&view.crate_identity).ok()
                        .is_some_and(|identity| identity["sysrootCrate"].as_str() == Some(&name))
                }).unwrap_or_else(|| panic!("The std-only fixture must bind loaded crate {name} to its sysroot provenance"));
                assert_eq!(
                    view.metadata_hash,
                    format!("{:?}", tcx.crate_hash(krate)),
                    "The certificate must use the actual imported metadata view"
                );
            }
        }
        self.facts = Some(facts);
        Compilation::Continue
    }
}

fn compile(label: &str, source: &str, native_hir_hash: bool) -> UnitFacts {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/purpose-views")
        .join(format!(
            "{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&root).unwrap();
    let filename = root.join("lib.rs");
    fs::write(&filename, source).unwrap();
    let output = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let arguments = vec![
        "rustc".into(),
        filename.to_string_lossy().into_owned(),
        "--crate-name=bevy_ecs".into(),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        String::from_utf8(output.stdout).unwrap().trim().into(),
        "--out-dir".into(),
        root.to_string_lossy().into_owned(),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
    ];
    let mut extractor = Extractor {
        native_hir_hash,
        facts: None,
    };
    rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
    assert!(root.join("libbevy_ecs.rlib").is_file());
    extractor.facts.unwrap()
}

#[test]
fn missing_early_metadata_hash_returns_an_incomplete_certificate_without_panicking() {
    let facts = compile(
        "native-metadata",
        "pub mod component { pub trait Component {} }\npub trait Config { const VALUE: u32; }\n",
        false,
    );
    let inventory = facts.purpose_inventory;
    assert!(inventory.metadata_hash.is_empty());
    assert!(inventory.required_views.is_empty());
    assert_eq!(inventory.coverage.len(), 1);
    assert!(!inventory.coverage[0].complete);
    assert!(inventory.coverage[0].reason.contains("metadata hash"));
}

#[test]
fn abstract_associated_types_keep_their_identity_and_require_fallback() {
    let facts = compile(
        "associated-types",
        "pub mod component { pub trait Component {} }\npub trait Config { type Item; const VALUE: u32; }\n",
        true,
    );
    let definition = facts
        .purpose_inventory
        .traits
        .iter()
        .find(|item| item.members.len() == 2)
        .unwrap();
    let abstract_type = definition
        .members
        .iter()
        .find(|item| item.unresolved_behavior)
        .unwrap();
    assert!(!abstract_type.has_value);
    assert!(!abstract_type.member_id.is_empty() && !abstract_type.evidence_hash.is_empty());
    assert_eq!(abstract_type.trait_id, definition.trait_id);
}

#[test]
fn std_bundled_crates_have_exact_views_and_coverage_even_with_registry_source_paths() {
    let facts = compile(
        "std-coverage",
        "pub mod component { pub trait Component {} }\npub trait Config { const VALUE: usize; }\npub fn generic<T: Config>() -> usize { T::VALUE }\npub fn collection() -> std::collections::HashMap<u8, u8> { std::collections::HashMap::new() }\n",
        true,
    );
    let inventory = &facts.purpose_inventory;
    assert!(inventory.required_crates.len() > 1);
    for identity in &inventory.required_crates {
        assert!(
            !identity.starts_with("native:"),
            "A loaded std dependency must not have an unbound native-only origin"
        );
        let view = inventory
            .required_views
            .iter()
            .find(|view| &view.crate_identity == identity)
            .unwrap();
        assert!(!view.metadata_hash.is_empty());
        assert!(
            inventory
                .coverage
                .iter()
                .any(|coverage| coverage.crate_identity == *identity
                    && coverage.metadata_hash == view.metadata_hash
                    && coverage.complete),
            "A required crate view needs its own coverage certificate: {identity}"
        );
    }
}

#[test]
fn local_specialization_keeps_the_inventory_but_requires_fallback() {
    let facts = compile(
        "specialization",
        "#![feature(specialization)]\n#![allow(incomplete_features)]\npub mod component { pub trait Component {} }\npub trait Config { fn value() -> u32; }\nimpl<T> Config for T { default fn value() -> u32 { 1 } }\nimpl Config for u8 { fn value() -> u32 { 2 } }\n",
        true,
    );
    let implementations = &facts.purpose_inventory.implementations;
    assert_eq!(implementations.len(), 2);
    assert!(implementations.iter().all(|item| !item.complete));
    assert!(
        implementations
            .iter()
            .all(|item| item.reason.contains("specialization"))
    );
}

#[test]
fn const_trait_methods_keep_exact_arguments_and_separate_default_helper_evidence() {
    let mut versions = Vec::new();
    for (helper, selected_type, selected_const, unrelated) in [
        (7, "u8", 3, 1),
        (7, "u8", 3, 9),
        (11, "u8", 3, 1),
        (7, "u16", 3, 1),
        (7, "u8", 5, 1),
    ] {
        versions.push(compile(
            "const-method",
            &format!(
                r#"
#![feature(const_trait_impl)]
pub mod component {{ pub trait Component {{}} }}
const fn offset() -> usize {{ {helper} }}
pub const trait Calc<A, const N: usize> {{ fn value() -> usize {{ N + offset() }} }}
pub struct Marker;
const impl Calc<u8, 3> for Marker {{}}
pub type Selected = {selected_type};
pub const CHOICE: usize = {selected_const};
pub fn generic<T: Calc<Selected, {{ CHOICE }}>>() -> usize {{ T::value() }}
pub fn unrelated() -> usize {{ {unrelated} }}
"#
            ),
            true,
        ));
    }
    let declaration = |facts: &UnitFacts| {
        facts
            .declarations
            .iter()
            .find(|item| item.full_name == "bevy_ecs::generic")
            .unwrap()
            .clone()
    };
    let first = declaration(&versions[0]);
    assert!(!first.unresolved_behavior);
    assert_eq!(first.purpose_dependencies.len(), 1);
    assert_eq!(first.evidence_hash, declaration(&versions[1]).evidence_hash);
    assert_eq!(
        first.evidence_hash,
        declaration(&versions[2]).evidence_hash,
        "Default helper evidence belongs to the referenced member inventory"
    );
    assert_ne!(
        first.evidence_hash,
        declaration(&versions[3]).evidence_hash,
        "Resolved type arguments participate in local evidence"
    );
    assert_ne!(
        first.evidence_hash,
        declaration(&versions[4]).evidence_hash,
        "Resolved const arguments participate in local evidence"
    );
    let dependency = &first.purpose_dependencies[0];
    let member = |facts: &UnitFacts| {
        facts
            .purpose_inventory
            .traits
            .iter()
            .find(|item| item.trait_id == dependency.trait_id)
            .unwrap()
            .members
            .iter()
            .find(|item| item.member_id == dependency.member_id)
            .unwrap()
            .clone()
    };
    let original = member(&versions[0]);
    assert!(original.has_value && !original.unresolved_behavior);
    assert_eq!(original.evidence_hash, member(&versions[1]).evidence_hash);
    assert_ne!(original.evidence_hash, member(&versions[2]).evidence_hash);
    assert!(!versions[0].purpose_inventory.metadata_hash.is_empty());
}

#[test]
fn unmodeled_members_preserve_local_body_and_associated_type_evidence() {
    let mut versions = vec![];
    for (value, item) in [(1, "u8"), (2, "u8"), (1, "u16")] {
        versions.push(compile(
            "unmodeled-members",
            &format!(
                "pub mod component {{ pub trait Component {{}} }}\n\
                 pub trait Unmodeled {{ type Item; fn value() -> u32; }}\n\
                 pub struct Marker;\n\
                 impl Unmodeled for Marker {{ type Item = {item}; fn value() -> u32 {{ {value} }} }}\n"
            ),
            true,
        ));
    }
    for facts in &versions {
        let inventory = &facts.purpose_inventory;
        assert!(inventory.coverage.iter().all(|coverage| coverage.complete));
        let definition = inventory
            .traits
            .iter()
            .find(|item| item.members.len() == 2)
            .unwrap();
        assert!(definition.complete);
        assert!(
            definition
                .members
                .iter()
                .all(|member| member.unresolved_behavior)
        );
        assert_eq!(inventory.implementations.len(), 1);
        let implementation = &inventory.implementations[0];
        assert!(implementation.complete);
        assert_eq!(implementation.members.len(), 2);
        assert!(implementation.members.iter().all(|member| {
            member.has_value
                && member.unresolved_behavior
                && member.dependencies.is_empty()
                && !member.evidence_hash.is_empty()
        }));
    }
    let first = &versions[0].purpose_inventory.implementations[0];
    let changed_member = |version: usize| {
        let implementation = &versions[version].purpose_inventory.implementations[0];
        assert_eq!(first.implementation_id, implementation.implementation_id);
        assert_eq!(first.header_hash, implementation.header_hash);
        let changed: Vec<_> = first
            .members
            .iter()
            .filter(|member| {
                member.evidence_hash
                    != implementation
                        .members
                        .iter()
                        .find(|candidate| candidate.member_id == member.member_id)
                        .unwrap()
                        .evidence_hash
            })
            .map(|member| member.member_id.clone())
            .collect();
        assert_eq!(
            changed.len(),
            1,
            "Only the changed member owns its local evidence"
        );
        changed[0].clone()
    };
    assert_ne!(
        changed_member(1),
        changed_member(2),
        "Ordinary method bodies and associated type targets retain separate evidence"
    );
}
