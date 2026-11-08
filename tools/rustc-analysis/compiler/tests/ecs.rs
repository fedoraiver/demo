//! 直接编译合成 API，检验类型与调用事实；夹具函数从不执行。
#![feature(rustc_private)]
extern crate rustc_driver;
extern crate rustc_interface;
extern crate rustc_middle;

use analysis_contract::facts::UnitFacts;
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use sha2::Digest;
use std::{fs, path::PathBuf, process::Command, sync::OnceLock};

struct Extractor {
    facts: Option<UnitFacts>,
}

struct OriginExtractor {
    facts: Option<UnitFacts>,
    origins: Vec<analysis_contract::PackageOrigin>,
}

impl Callbacks for OriginExtractor {
    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        self.facts =
            Some(analysis_compiler::ecs::extract_with_origins(tcx, &self.origins).unwrap());
        Compilation::Stop
    }
}

#[test]
fn exact_package_target_identity_is_stable_across_workspace_roots_and_distinguishes_packages() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/reuse-package-origins");
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let mut versions = vec![];
    for (directory, metadata, package) in [
        ("first", "a", "package-a"),
        ("second", "b", "package-a"),
        ("third", "a", "package-b"),
    ] {
        let directory = root.join(directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("lib.rs");
        fs::write(&source, "#![allow(dead_code)]\npub mod component { pub trait Component {} }\npub struct Marker;\nimpl component::Component for Marker {}\nfn unchanged() { let create = || Marker; let _ = create(); }\n").unwrap();
        let source = analysis_contract::normalized(&source).unwrap();
        let arguments = vec![
            "rustc".into(),
            source.clone(),
            "--crate-name=bevy_ecs".into(),
            "--crate-type=lib".into(),
            "--edition=2024".into(),
            "--sysroot".into(),
            sysroot.trim().into(),
            "--out-dir".into(),
            directory.to_string_lossy().into_owned(),
            "-Zalways-encode-mir".into(),
            "-Zmir-opt-level=0".into(),
            format!("-Cmetadata={metadata}"),
        ];
        let mut extractor = OriginExtractor {
            facts: None,
            origins: vec![analysis_contract::PackageOrigin {
                root: analysis_contract::normalized(&directory).unwrap(),
                identity: package.into(),
                targets: vec![analysis_contract::PackageTargetOrigin {
                    source,
                    name: "bevy_ecs".into(),
                    kind: vec!["lib".into()],
                }],
            }],
        };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        let facts = extractor.facts.unwrap();
        let declarations = facts
            .declarations
            .iter()
            .filter(|declaration| declaration.crate_name == "bevy_ecs")
            .map(|declaration| (declaration.full_name.clone(), declaration.id.clone()))
            .collect::<std::collections::BTreeMap<_, _>>();
        let callables = facts
            .callables
            .iter()
            .filter(|callable| callable.display.starts_with("bevy_ecs::"))
            .map(|callable| callable.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let types = facts
            .types
            .iter()
            .filter(|ty| {
                declarations
                    .values()
                    .any(|id| ty.declaration.as_ref() == Some(id))
            })
            .map(|ty| ty.id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        versions.push((declarations, callables, types));
    }
    assert!(!versions[0].1.is_empty());
    assert!(!versions[0].2.is_empty());
    assert_eq!(versions[0], versions[1]);
    assert_ne!(
        versions[0], versions[2],
        "Identical definition paths from distinct packages must stay separate"
    );
}

#[test]
fn owning_and_importing_compiler_units_agree_on_exact_package_identity() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/reuse-imported-origin");
    let dependency = root.join("dependency");
    let consumer = root.join("consumer");
    fs::create_dir_all(&dependency).unwrap();
    fs::create_dir_all(&consumer).unwrap();
    let dependency_source = dependency.join("lib.rs");
    let consumer_source = consumer.join("lib.rs");
    fs::write(&dependency_source, "pub mod component { pub trait Component {} }\npub struct Marker;\nimpl component::Component for Marker {}\n").unwrap();
    fs::write(
        &consumer_source,
        "pub fn consume(_marker: bevy_ecs::Marker) {}\n",
    )
    .unwrap();
    let artifact = dependency.join("libfixture.rlib");
    let compiled = Command::new("rustc")
        .args([
            dependency_source.as_os_str(),
            "--crate-name=bevy_ecs".as_ref(),
            "--crate-type=rlib".as_ref(),
            "--edition=2024".as_ref(),
            "-Zalways-encode-mir".as_ref(),
            "-o".as_ref(),
            artifact.as_os_str(),
        ])
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let origins = [
        (&dependency, &dependency_source, "bevy_ecs"),
        (&consumer, &consumer_source, "consumer"),
    ]
    .into_iter()
    .map(|(root, source, name)| analysis_contract::PackageOrigin {
        root: analysis_contract::normalized(root).unwrap(),
        identity: format!("exact-package:{name}:1"),
        targets: vec![analysis_contract::PackageTargetOrigin {
            source: analysis_contract::normalized(source).unwrap(),
            name: name.into(),
            kind: vec!["lib".into()],
        }],
    })
    .collect::<Vec<_>>();
    let mut versions = vec![];
    for (source, name) in [
        (&dependency_source, "bevy_ecs"),
        (&consumer_source, "consumer"),
    ] {
        let mut arguments = vec![
            "rustc".into(),
            source.to_string_lossy().into_owned(),
            format!("--crate-name={name}"),
            "--crate-type=lib".into(),
            "--edition=2024".into(),
            "--sysroot".into(),
            sysroot.trim().into(),
            "--out-dir".into(),
            root.to_string_lossy().into_owned(),
            "-Zalways-encode-mir".into(),
            "-Zmir-opt-level=0".into(),
        ];
        if name == "consumer" {
            arguments.extend([
                "--extern".into(),
                format!("bevy_ecs={}", artifact.display()),
            ]);
        }
        let mut extractor = OriginExtractor {
            facts: None,
            origins: origins.clone(),
        };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        let facts = extractor.facts.unwrap();
        let marker = facts
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == "bevy_ecs::Marker")
            .unwrap();
        versions.push(marker.id.clone());
    }
    assert_eq!(versions[0], versions[1]);
}

#[test]
fn compiler_metadata_does_not_change_declaration_identity() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/reuse-compiler-metadata");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("lib.rs");
    fs::write(&source, "#![allow(dead_code)]\npub mod component { pub trait Component {} }\npub struct Marker;\nimpl component::Component for Marker {}\nfn unchanged(value: Marker) { let _ = value; }\n").unwrap();
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let mut versions = vec![];
    for metadata in ["workspace_a", "workspace_b"] {
        let arguments = vec![
            "rustc".into(),
            source.to_string_lossy().into_owned(),
            "--crate-name=bevy_ecs".into(),
            "--crate-type=lib".into(),
            "--edition=2024".into(),
            "--sysroot".into(),
            sysroot.trim().into(),
            "--out-dir".into(),
            root.to_string_lossy().into_owned(),
            "-Zalways-encode-mir".into(),
            "-Zmir-opt-level=0".into(),
            format!("-Cmetadata={metadata}"),
        ];
        let mut extractor = Extractor { facts: None };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        let facts = extractor.facts.unwrap();
        versions.push(
            facts
                .declarations
                .into_iter()
                .filter(|declaration| {
                    matches!(
                        declaration.full_name.as_str(),
                        "bevy_ecs::Marker" | "bevy_ecs::unchanged"
                    )
                })
                .map(|declaration| (declaration.full_name, declaration.id))
                .collect::<std::collections::BTreeMap<_, _>>(),
        );
    }
    assert_eq!(versions[0].len(), 2);
    assert_eq!(
        versions[0], versions[1],
        "Cargo metadata must remain provenance, not semantic identity"
    );
}

/// 使用主项目已检查的真实依赖，避免测试另行选择 Bevy 配置或重建图形依赖。
#[test]
#[ignore = "设置 ANALYSIS_BEVY_DEPS 为主项目构建产物目录，并设置 CARGO_PRIMARY_PACKAGE=1。"]
fn extracts_real_bevy_protocols_and_bsn() {
    let root = PathBuf::from(std::env::var_os("ANALYSIS_BEVY_DEPS").expect("ANALYSIS_BEVY_DEPS"));
    let mut pending = vec![root];
    let mut paths = vec![];
    let mut dependencies = std::collections::BTreeSet::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("rmeta" | "rlib" | "dll" | "so" | "dylib")
            ) {
                dependencies.insert(path.parent().unwrap().to_path_buf());
                paths.push(path);
            }
        }
    }
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/real-bevy");
    fs::create_dir_all(&output).unwrap();
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let mut arguments = vec![
        "rustc".into(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/real_bevy.rs")
            .to_string_lossy()
            .into_owned(),
        "--crate-name=architecture_fixture".into(),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        String::from_utf8(compiler.stdout).unwrap().trim().into(),
        "--out-dir".into(),
        output.to_string_lossy().into_owned(),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
    ];
    for name in [
        "bevy_ecs",
        "bevy_scene",
        "bevy_app",
        "bevy_ui",
        "bevy_ui_widgets",
    ] {
        let artifact = paths
            .iter()
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&format!("lib{name}-"))
                    && path
                        .extension()
                        .is_some_and(|extension| extension == "rmeta")
            })
            .unwrap();
        arguments.push(format!("--extern={name}={}", artifact.display()));
    }
    for directory in dependencies {
        arguments.push(format!("-Ldependency={}", directory.display()));
    }
    let external_metadata = output.join("libarchitecture_external.rmeta");
    let mut external_arguments = arguments.clone();
    external_arguments[1] = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/external_plugin.rs")
        .to_string_lossy()
        .into_owned();
    external_arguments[2] = "--crate-name=architecture_external".into();
    external_arguments.push(format!("--emit=metadata={}", external_metadata.display()));
    struct MetadataOnly;
    impl Callbacks for MetadataOnly {}
    rustc_driver::compiler_entrypoint(&external_arguments, &mut MetadataOnly);
    assert!(external_metadata.is_file());
    arguments.push(format!(
        "--extern=architecture_external={}",
        external_metadata.display()
    ));
    arguments.push(format!("-Ldependency={}", output.display()));
    let mut extractor = Extractor { facts: None };
    rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
    let facts = extractor.facts.unwrap();
    fs::write(
        output.join("facts.json"),
        serde_json::to_vec_pretty(&facts).unwrap(),
    )
    .unwrap();
    for function in [
        "architecture_external::external_generic_system",
        "architecture_external::external_zero",
    ] {
        let definition = facts
            .declarations
            .iter()
            .find(|definition| definition.full_name == function)
            .unwrap();
        assert!(
            facts
                .callables
                .iter()
                .any(|callable| callable.declaration == definition.id
                    && !callable.system_type_ids.is_empty()),
            "Missing native System instance for {function}"
        );
        if function.ends_with("external_generic_system") {
            assert!(
                facts
                    .operations
                    .iter()
                    .any(|operation| operation.kind == "modify"
                        && facts
                            .callables
                            .iter()
                            .any(|callable| callable.id == operation.owner
                                && callable.declaration == definition.id
                                && !callable.system_type_ids.is_empty())),
                "Native System body must be collected before general helper traversal"
            );
        }
    }
    let wrapper = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "architecture_fixture::canonical_params")
        .unwrap();
    let callable = facts
        .callables
        .iter()
        .find(|callable| callable.declaration == wrapper.id)
        .unwrap();
    for (slot, mode, storage) in [
        ("_resource", "mutable_access", "Resource"),
        ("_non_send", "read", "NonSend"),
        ("_non_send_mut", "mutable_access", "NonSend"),
        ("_components.data", "read", "Component"),
        ("_reader", "read", "Message"),
        ("_writer", "mutable_access", "Message"),
        ("_mutator", "mutable_access", "Message"),
        ("_event", "event", "Event"),
    ] {
        assert!(
            facts
                .accesses
                .iter()
                .any(|access| access.owner == callable.id
                    && access.parameter == slot
                    && access.mode == mode
                    && access.storage == storage),
            "Missing canonical wrapper access: {slot} {mode} {storage}"
        );
    }
    assert!(
        facts
            .types
            .iter()
            .any(|ty| ty.roles.iter().any(|role| role == "System") && ty.runtime_type_id.is_some())
    );
    assert!(
        facts
            .accesses
            .iter()
            .any(|access| access.storage == "Local" && access.parameter.starts_with("custom."))
    );
    assert!(
        facts
            .accesses
            .iter()
            .any(|access| access.storage == "Resource" && access.parameter.starts_with("custom."))
    );
    assert!(
        facts
            .operations
            .iter()
            .any(|operation| operation.kind == "filter")
    );
    assert!(
        facts
            .entities
            .iter()
            .any(|entity| !entity.required_components.is_empty())
    );
    assert!(
        facts
            .entities
            .iter()
            .any(|entity| !entity.children.is_empty())
    );
    let branch_creator = |name: &str| {
        let declaration = facts
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == format!("architecture_fixture::{name}"))
            .unwrap();
        facts
            .callables
            .iter()
            .find(|callable| callable.declaration == declaration.id)
            .unwrap()
            .id
            .clone()
    };
    let unknown_scene_creators = [
        branch_creator("unknown_scene_after_name"),
        branch_creator("unknown_scene_before_name"),
    ];
    assert!(
        facts
            .entities
            .iter()
            .all(|entity| entity.gaps.iter().all(|gap| matches!(
                gap.kind.as_str(),
                "entity-alternative" | "entity-multiplicity"
            ) || gap.reason.contains("独立结构候选")
                || gap.reason.contains("没有可达返回状态")
                || (gap.kind == "entity-structure"
                    && unknown_scene_creators.contains(&entity.creator)))),
        "{:?}",
        facts.entities
    );
    let component = |path: &str| {
        let declaration = facts
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == path)
            .expect(path);
        facts
            .types
            .iter()
            .find(|ty| ty.declaration.as_deref() == Some(&declaration.id))
            .unwrap()
            .id
            .clone()
    };
    let text = component("bevy_ui::widget::text::Text");
    let button = component("bevy_ui_widgets::button::Button");
    assert!(
        facts
            .entities
            .iter()
            .all(|entity| !(entity.components.contains(&text)
                && entity.components.contains(&button))),
        "Distinct branch shapes were merged"
    );
    let by_id: std::collections::BTreeMap<_, _> = facts
        .entities
        .iter()
        .map(|entity| (&entity.id, entity))
        .collect();
    for expected in [
        "Direct",
        "Deferred",
        "Scene root",
        "Scene child",
        "Choice host",
        "Repeated template",
        "Required fixture name",
        "Explicit fixture name",
        "Helper fixture name",
        "Cloned fixture name",
        "NamedFixtureRoot",
        "NamedFixtureChild",
    ] {
        assert!(
            facts.entities.iter().any(|entity| entity
                .name_candidates
                .iter()
                .any(|candidate| candidate.value.as_deref() == Some(expected))),
            "Missing compiler-confirmed Name {expected}"
        );
    }
    let direct = facts
        .entities
        .iter()
        .flat_map(|entity| &entity.name_candidates)
        .find(|candidate| candidate.value.as_deref() == Some("Direct"))
        .unwrap();
    assert_eq!(
        direct.expression.as_ref().unwrap().snippet.trim(),
        "\"Direct\""
    );
    let root = branch_creator("branch_assembly");
    let branches: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| {
            entity.creator == root && entity.alternative_selection.as_deref() == Some("unresolved")
        })
        .collect();
    assert_eq!(branches.len(), 2);
    assert!(
        branches
            .iter()
            .all(|entity| entity.possible && entity.alternative_group.is_some())
    );
    for branch in branches {
        let expected = if branch.components.contains(&text) {
            &text
        } else {
            &button
        };
        assert!(branch.components.contains(expected));
        assert_eq!(branch.children.len(), 1);
        let child = by_id[&branch.children[0]];
        let expected_names = if branch.components.contains(&text) {
            ("Text branch", "Text child")
        } else {
            ("Button branch", "Button child")
        };
        assert!(
            branch
                .name_candidates
                .iter()
                .any(|candidate| candidate.value.as_deref() == Some(expected_names.0))
        );
        assert!(
            child
                .name_candidates
                .iter()
                .any(|candidate| candidate.value.as_deref() == Some(expected_names.1))
        );
        assert!(
            child.components.contains(expected),
            "Child ordinal crossed a structural candidate boundary"
        );
        assert_eq!(child.alternative_context, branch.alternative_context);
        assert!(child.possible);
        assert!(
            child
                .source
                .as_ref()
                .is_some_and(|source| source.end_line > 0 && !source.expansions.is_empty()),
            "Native child macro Span was lost"
        );
    }
    let nested = branch_creator("nested_branch_assembly");
    let nested: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| {
            entity.creator == nested
                && entity.alternative_selection.as_deref() == Some("unresolved")
        })
        .collect();
    assert_eq!(nested.len(), 2);
    for root in nested {
        assert_eq!(root.children.len(), 1);
        let child = by_id[&root.children[0]];
        let expected = if child.components.contains(&text) {
            &text
        } else {
            &button
        };
        assert!(child.components.contains(expected));
        assert_eq!(child.children.len(), 1);
        assert!(by_id[&child.children[0]].components.contains(expected));
    }
    let nested = branch_creator("protocol_branch_assembly");
    let groups: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == nested)
        .flat_map(|entity| &entity.alternatives)
        .collect();
    assert!(!groups.is_empty());
    assert!(
        groups
            .iter()
            .flat_map(|group| &group.candidates)
            .any(|candidate| by_id[candidate].components.contains(&text))
    );
    assert!(
        groups
            .iter()
            .flat_map(|group| &group.candidates)
            .any(|candidate| by_id[candidate].components.contains(&button))
    );
    assert!(
        groups
            .iter()
            .all(|group| group.selection == "one-of" && !group.candidates.is_empty())
    );
    let no_outcome = branch_creator("no_scene_outcome");
    assert!(facts.entities.iter().any(|entity| {
        entity.creator == no_outcome
            && entity
                .gaps
                .iter()
                .any(|gap| gap.reason.contains("没有可达返回状态"))
    }));
    assert!(
        facts
            .entities
            .iter()
            .flat_map(|entity| &entity.alternatives)
            .all(|group| !group.candidates.is_empty())
    );
    let repeated = branch_creator("repeated_roots");
    let repeated: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == repeated)
        .collect();
    assert_eq!(
        repeated.len(),
        1,
        "Same-shape same-origin roots reuse a template, not a runtime entity"
    );
    assert!(
        repeated[0]
            .gaps
            .iter()
            .any(|gap| gap.kind == "entity-multiplicity")
    );
    assert_eq!(repeated[0].name_candidates.len(), 1);
    assert_eq!(
        repeated[0].name_candidates[0].value.as_deref(),
        Some("Repeated template")
    );
    for creator in ["same_shape_names", "same_shape_scene_names"] {
        let creator = branch_creator(creator);
        let templates: Vec<_> = facts
            .entities
            .iter()
            .filter(|entity| entity.creator == creator)
            .collect();
        assert_eq!(
            templates.len(),
            1,
            "Names must not introduce structural alternatives"
        );
        assert_eq!(templates[0].name_candidates.len(), 2);
        assert!(templates[0].alternatives.is_empty());
    }
    let creator = branch_creator("same_shape_unknown_name");
    let templates: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .collect();
    assert_eq!(templates.len(), 1);
    assert!(
        templates[0]
            .name_candidates
            .iter()
            .any(|candidate| candidate.value.as_deref() == Some("Confirmed name"))
    );
    assert!(
        templates[0]
            .name_candidates
            .iter()
            .any(|candidate| candidate.value.is_none()
                && candidate.expression.is_none()
                && candidate.reason.is_some())
    );
    let creator = branch_creator("required_names");
    let templates: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .collect();
    assert_eq!(templates.len(), 2);
    assert!(
        templates
            .iter()
            .all(|entity| entity.name_candidates.len() == 1)
    );
    let creator = branch_creator("dynamic_names");
    let expressions: std::collections::BTreeSet<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .flat_map(|entity| &entity.name_candidates)
        .filter_map(|candidate| candidate.expression.as_ref())
        .map(|source| source.snippet.trim().to_owned())
        .collect();
    assert_eq!(
        expressions,
        std::collections::BTreeSet::from([
            "format!(\"Named item {}\", index)".to_owned(),
            "format!(\"From item {}\", index)".to_owned(),
            "format!(\"Set item {}\", index)".to_owned(),
            "format!(\"BSN item {}\", index)".to_owned(),
            "format!(\"BSN child {}\", index)".to_owned(),
        ])
    );
    let creator = branch_creator("constant_name");
    let constants: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .collect();
    assert_eq!(constants.len(), 1);
    assert_eq!(constants[0].name_candidates.len(), 1);
    let constant = &constants[0].name_candidates[0];
    assert_eq!(constant.value.as_deref(), Some("Constant fixture name"));
    assert_eq!(
        constant.expression.as_ref().unwrap().snippet.trim(),
        "CONSTANT_ENTITY_NAME"
    );
    let creator = branch_creator("type_named_entities");
    let type_names: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .flat_map(|entity| &entity.name_candidates)
        .collect();
    assert_eq!(type_names.len(), 4);
    assert!(
        type_names
            .iter()
            .all(|name| name.reason.is_none() && name.expression.is_some())
    );
    let fixture_crate = arguments
        .iter()
        .find_map(|argument| argument.strip_prefix("--crate-name="))
        .unwrap();
    assert_eq!(
        type_names
            .iter()
            .map(|name| name.value.clone().unwrap())
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([
            format!("{fixture_crate}::Position"),
            "architecture_external::ExternalGenericPlugin<architecture_external::ExternalMarker>"
                .to_owned(),
            "alloc::vec::Vec<core::option::Option<alloc::string::String>>".to_owned(),
            "u32".to_owned(),
        ])
    );
    let creator = branch_creator("forwarded_dynamic_name");
    let forwarded: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .collect();
    assert_eq!(forwarded.len(), 1);
    assert_eq!(forwarded[0].name_candidates.len(), 1);
    let forwarded = &forwarded[0].name_candidates[0];
    assert!(forwarded.value.is_none());
    assert!(forwarded.reason.is_none());
    assert_eq!(
        forwarded.expression.as_ref().unwrap().snippet.trim(),
        "format!(\"Forwarded item {}\", index)"
    );
    let creator = branch_creator("dynamic_parameter_name");
    let parameter: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator)
        .collect();
    assert_eq!(parameter.len(), 1);
    assert_eq!(parameter[0].name_candidates.len(), 1);
    let parameter = &parameter[0].name_candidates[0];
    assert!(parameter.value.is_none());
    assert!(parameter.reason.is_none());
    assert_eq!(
        parameter.expression.as_ref().unwrap().snippet.trim(),
        "value"
    );
    for (function, expected) in [
        ("mutated_dynamic_name", "value"),
        ("mutated_static_name", "value"),
        ("unknown_text_modifier", "value"),
        ("unknown_static_text_modifier", "value"),
        ("unknown_dyn_text_modifier", "value"),
        ("unknown_text_factory", "make()"),
        ("trimmed_parameter_name", "text.trim()"),
        ("rebound_trimmed_name", "view"),
    ] {
        let creator = branch_creator(function);
        let templates: Vec<_> = facts
            .entities
            .iter()
            .filter(|entity| entity.creator == creator)
            .collect();
        assert_eq!(templates.len(), 1, "Unexpected templates for {function}");
        assert_eq!(templates[0].name_candidates.len(), 1);
        let name = &templates[0].name_candidates[0];
        assert!(name.value.is_none(), "Stale text retained in {function}");
        assert!(name.reason.is_none());
        assert_eq!(name.expression.as_ref().unwrap().snippet.trim(), expected);
    }
    for (function, original) in [
        ("rebound_shared_text", Some("Original shared name")),
        ("rebound_mutable_text", None),
    ] {
        let creator = branch_creator(function);
        let names: Vec<_> = facts
            .entities
            .iter()
            .filter(|entity| entity.creator == creator)
            .flat_map(|entity| &entity.name_candidates)
            .collect();
        assert_eq!(names.len(), 2, "Unexpected names in {function}");
        assert_eq!(
            names
                .iter()
                .filter(|name| name.value.as_deref() == original)
                .count(),
            if original.is_some() { 1 } else { 2 }
        );
        let borrowed = names
            .iter()
            .find(|name| {
                name.expression
                    .as_ref()
                    .is_some_and(|source| source.snippet.trim() == "String::clone(borrowed)")
            })
            .unwrap();
        assert!(borrowed.value.is_none());
        assert!(borrowed.reason.is_none());
        if original.is_none() {
            assert!(names.iter().any(|name| {
                name.expression
                    .as_ref()
                    .is_some_and(|source| source.snippet.trim() == "value")
            }));
        }
    }
    let creator = branch_creator("branch_required_scene_name");
    let branches: Vec<_> = facts
        .entities
        .iter()
        .filter(|entity| entity.creator == creator && entity.alternatives.is_empty())
        .collect();
    let names: std::collections::BTreeSet<_> = branches
        .iter()
        .flat_map(|entity| &entity.name_candidates)
        .map(|candidate| candidate.value.as_deref())
        .collect();
    assert_eq!(
        names,
        std::collections::BTreeSet::from([
            Some("Branch explicit name"),
            Some("Required fixture name")
        ])
    );
    for (function, expected, uncertain) in [
        ("unknown_scene_after_name", "Before unknown scene", true),
        ("unknown_scene_before_name", "After unknown scene", false),
        (
            "unknown_component_after_name",
            "Before unknown component",
            false,
        ),
    ] {
        let creator = branch_creator(function);
        let templates: Vec<_> = facts
            .entities
            .iter()
            .filter(|entity| entity.creator == creator)
            .collect();
        assert_eq!(templates.len(), 1, "Unexpected templates for {function}");
        let names = &templates[0].name_candidates;
        assert!(
            names
                .iter()
                .any(|candidate| candidate.value.as_deref() == Some(expected)),
            "Lost known Name in {function}"
        );
        assert_eq!(
            names.iter().any(|candidate| candidate.reason.is_some()),
            uncertain,
            "Wrong uncertainty for {function}"
        );
        assert_eq!(
            names.len(),
            if uncertain { 2 } else { 1 },
            "Unexpected Name candidates for {function}"
        );
    }
    for (function, expected) in [
        ("required_bundle_first", "First required name"),
        ("required_bundle_reversed", "Second required name"),
        ("required_inherited_first", "First required name"),
        ("required_direct_override", "Direct required name"),
    ] {
        let creator = branch_creator(function);
        let templates: Vec<_> = facts
            .entities
            .iter()
            .filter(|entity| entity.creator == creator)
            .collect();
        assert_eq!(templates.len(), 1, "Unexpected templates for {function}");
        assert_eq!(
            templates[0]
                .name_candidates
                .iter()
                .map(|candidate| candidate.value.as_deref())
                .collect::<Vec<_>>(),
            vec![Some(expected)],
            "Wrong required priority for {function}"
        );
    }
}

#[test]
fn name_alternatives_preserve_each_branch_priority() {
    use analysis_compiler::entity::mir_value::{EntityNameCandidate, NameParts};
    let name = |value: &str| {
        NameParts::explicit(EntityNameCandidate {
            value: Some(value.to_owned()),
            expression: None,
            reason: None,
        })
    };
    let mut names = NameParts::alternatives(vec![name("Explicit A"), NameParts::default()]);
    names.extend(name("Required B").into_required());
    assert_eq!(
        names
            .candidates()
            .iter()
            .map(|candidate| candidate.value.as_deref())
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([Some("Explicit A"), Some("Required B")])
    );
    names.extend(name("Final explicit"));
    assert_eq!(
        names
            .candidates()
            .iter()
            .map(|candidate| candidate.value.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("Final explicit")]
    );
    let mut required = name("First required").into_required();
    required.extend(name("Later inherited").into_required());
    assert_eq!(
        required.candidates()[0].value.as_deref(),
        Some("First required")
    );
    required.extend_direct_required(name("Direct required").into_required());
    assert_eq!(
        required.candidates()[0].value.as_deref(),
        Some("Direct required")
    );
}
impl Callbacks for Extractor {
    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        self.facts = Some(analysis_compiler::ecs::extract(tcx).unwrap());
        Compilation::Stop
    }
}

fn facts() -> &'static UnitFacts {
    static FACTS: OnceLock<UnitFacts> = OnceLock::new();
    FACTS.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tmp/rustc-analysis/fixtures/typed-facts");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("lib.rs");
        let mut fixture = String::from(r#"
#![allow(dead_code, unused_variables)]
pub mod component { pub trait Component {} }
pub mod resource { pub trait Resource: crate::component::Component {} }
pub mod system {
    pub mod system { pub trait System {} }
    pub mod system_param { pub trait SystemParam {} pub struct Local<T>(pub T); }
    pub mod query { pub struct Query<D,F=()>(std::marker::PhantomData<(D,F)>); }
    pub mod commands { pub struct Commands; impl Commands {
        pub fn insert<T>(&mut self, value:T) {} pub fn remove<T>(&mut self) {}
        pub fn queue<F:FnOnce()>(&mut self, callback:F) {}
    } }
    pub mod function_system { pub struct FunctionSystem<F> {pub function:F} impl<F> super::system::System for FunctionSystem<F> {} }
}
pub mod query { pub mod filter { pub struct With<T>(std::marker::PhantomData<T>); } }
pub mod change_detection { pub mod params { pub struct ResMut<T>(pub T); } pub use params::ResMut; }
pub mod entity {pub struct Entity;}
pub mod world { pub struct World; impl World {
    pub fn insert_resource<T>(&mut self, value:T) {}
    pub fn get_resource<T>(&self)->Option<&T> {None}
    pub fn spawn<T>(&mut self, bundle:T) {}
    pub fn spawn_at<T>(&mut self, entity:crate::entity::Entity, bundle:T) {}
    pub fn spawn_empty(&mut self) {}
} }
mod left { pub struct Position; impl crate::component::Component for Position {} }
mod right { pub struct Position; impl crate::component::Component for Position {} }
use left::Position as Imported;
type Alias = Imported;
struct Config; impl component::Component for Config {} impl resource::Resource for Config {}
trait Extract {type Out;} struct Source; impl Extract for Source {type Out=right::Position;}
fn typed(a:change_detection::ResMut<Config>, query:system::query::Query<(&'static mut Alias,), query::filter::With<right::Position>>, cache:system::system_param::Local<String>, output:<Source as Extract>::Out) {}
fn operations(commands:&mut system::commands::Commands, world:&mut world::World, values:&mut Vec<Alias>) {
    commands.insert(Alias {}); commands.remove::<right::Position>();
    values.insert(0,Alias {}); world.insert_resource(Config);
    if world.get_resource::<Config>().is_some() {helper(commands);}
    commands.queue(|| {});
}
fn helper(commands:&mut system::commands::Commands) {commands.remove::<left::Position>();}
fn replace<T: component::Component>(value:&mut T, new:T) {*value = new;}
fn guarded_replace<T: component::Component>(value:&mut T, new:T, enabled:bool) {if enabled {*value = new;}}
fn replacements(commands:&mut system::commands::Commands, world:&world::World, left:&mut left::Position, right:&mut right::Position, values:&mut Vec<u32>) {
    if world.get_resource::<Config>().is_some() {replace(left, left::Position);}
    guarded_replace(right, right::Position, true);
    commands.queue(|| replace(left, left::Position));
    values[0] = 1;
}
trait RuntimeDispatch {fn tick(&mut self);}
impl RuntimeDispatch for left::Position {fn tick(&mut self) {*self = left::Position;}}
fn dynamic(value:&mut dyn RuntimeDispatch) {value.tick();}
fn local_copy() {let mut value=left::Position; let reference=&mut value; *reference=left::Position;}
fn generic_spawn<T:component::Component>(world:&mut world::World, bundle:T) {world.spawn(bundle);}
fn spawn_operations(world:&mut world::World) {generic_spawn(world, left::Position); world.spawn_at(entity::Entity, right::Position); world.spawn_empty();}
fn registered() {}
fn conditional_registration(flag:bool) {if flag {registered();}}
fn indirect(callback:fn()) {callback();}
fn wrapper() {let system = system::function_system::FunctionSystem {function:registered};}
macro_rules! make {()=>{fn generated(commands:&mut system::commands::Commands) {commands.insert(Alias {});}}}
make!();
#[cfg(any())] fn inactive() {}
"#);
        let marker = "编译器源码证据".repeat(160);
        fixture.push_str(&format!("\nfn long_body() {{let _text = {marker:?};}}\nfn long_guard(value:&mut left::Position, new:left::Position) {{if {{let _text = {marker:?}; true}} {{*value = new;}}}}\n"));
        fs::write(&source, fixture).unwrap();
        let compiler = Command::new("rustc").args(["--print", "sysroot"]).output().unwrap();
        assert!(compiler.status.success());
        let sysroot = String::from_utf8(compiler.stdout).unwrap();
        let arguments = vec!["rustc".into(), source.to_string_lossy().into_owned(), "--crate-name=bevy_ecs".into(), "--crate-type=lib".into(), "--edition=2024".into(), "--sysroot".into(), sysroot.trim().into(), "--out-dir".into(), root.to_string_lossy().into_owned(), "-Zalways-encode-mir".into(), "-Zmir-opt-level=0".into()];
        let mut extractor = Extractor {facts:None};
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        extractor.facts.unwrap()
    })
}

#[test]
fn resolves_aliases_associated_types_and_same_named_declarations() {
    let facts = facts();
    let declaration = facts
        .declarations
        .iter()
        .find(|d| d.full_name == "bevy_ecs::typed")
        .unwrap();
    let callable = facts
        .callables
        .iter()
        .find(|c| c.declaration == declaration.id)
        .unwrap();
    let output = callable
        .parameters
        .iter()
        .find(|p| p.slot == "output")
        .unwrap();
    let ty = facts.types.iter().find(|t| t.id == output.type_id).unwrap();
    let declaration = facts
        .declarations
        .iter()
        .find(|d| Some(&d.id) == ty.declaration.as_ref())
        .unwrap();
    assert_eq!(declaration.full_name, "bevy_ecs::right::Position");
    let positions: Vec<_> = facts
        .declarations
        .iter()
        .filter(|d| d.name == "Position")
        .collect();
    assert_eq!(positions.len(), 2);
    assert_ne!(positions[0].id, positions[1].id);
}

#[test]
fn separates_declared_access_existence_checks_and_ecs_operations() {
    let facts = facts();
    let helper = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::helper")
        .unwrap();
    assert!(
        facts.calls.iter().any(
            |call| call.declaration.as_ref() == Some(&helper.id) && !call.conditions.is_empty()
        )
    );
    assert!(
        facts
            .accesses
            .iter()
            .any(|a| a.parameter == "cache" && a.storage == "Local")
    );
    assert!(
        facts
            .accesses
            .iter()
            .any(|a| a.mode == "mutable_access" && a.storage == "Component")
    );
    assert!(
        facts
            .accesses
            .iter()
            .any(|a| a.mode == "filter" && a.storage == "Component")
    );
    assert!(facts.operations.iter().any(|o| {
        o.kind == "filter"
            && o.source
                .as_ref()
                .is_some_and(|s| s.snippet.contains("get_resource"))
    }));
    assert!(!facts.operations.iter().any(|o| {
        o.source
            .as_ref()
            .is_some_and(|s| s.snippet.contains("values.insert"))
    }));
    assert!(facts.calls.iter().any(|call| call.deferred));
}

#[test]
fn records_macro_cfg_source_hashes_and_concrete_system_identity() {
    let facts = facts();
    assert!(!facts.declarations.iter().any(|d| d.name == "inactive"));
    let generated = facts
        .declarations
        .iter()
        .find(|d| d.name == "generated")
        .unwrap();
    assert!(!generated.source.as_ref().unwrap().expansions.is_empty());
    assert!(
        facts
            .source_files
            .iter()
            .all(|source| source.sha256.len() == 64)
    );
    let registered = facts
        .declarations
        .iter()
        .find(|d| d.full_name == "bevy_ecs::registered")
        .unwrap();
    assert!(
        facts
            .callables
            .iter()
            .any(|callable| callable.declaration == registered.id
                && !callable.system_type_ids.is_empty())
    );
}

#[test]
fn instantiates_real_assignments_and_preserves_call_guards() {
    let facts = facts();
    let replace = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::replace")
        .unwrap();
    let position = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::left::Position")
        .unwrap();
    let concrete = facts
        .callables
        .iter()
        .filter(|callable| callable.declaration == replace.id)
        .find(|callable| {
            callable.arguments.iter().any(|argument| {
                facts.types.iter().any(|ty| {
                    ty.id == argument.value && ty.declaration.as_ref() == Some(&position.id)
                })
            })
        })
        .unwrap();
    assert!(facts.operations.iter().any(|operation| {
        operation.owner == concrete.id
            && operation.kind == "modify"
            && facts.types.iter().any(|ty| {
                operation.target_type.as_ref() == Some(&ty.id)
                    && ty.declaration.as_ref() == Some(&position.id)
            })
    }));
    assert!(
        facts
            .calls
            .iter()
            .any(|call| call.callee.as_ref() == Some(&concrete.id) && !call.conditions.is_empty())
    );
    let guarded = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::guarded_replace")
        .unwrap();
    assert!(
        facts
            .operations
            .iter()
            .filter(|operation| operation.kind == "modify" && !operation.conditions.is_empty())
            .any(|operation| facts
                .callables
                .iter()
                .any(|callable| callable.id == operation.owner
                    && callable.declaration == guarded.id
                    && facts
                        .types
                        .iter()
                        .any(|ty| operation.target_type.as_ref() == Some(&ty.id)
                            && ty.runtime_type_id.is_some())))
    );
    assert!(!facts.operations.iter().any(|operation| {
        operation.kind == "modify"
            && operation
                .source
                .as_ref()
                .is_some_and(|source| source.snippet.contains("values[0]"))
    }));
    let deferred = facts.calls.iter().find(|call| {
        call.deferred
            && call.callee.as_ref().is_some_and(|id| {
                facts
                    .calls
                    .iter()
                    .any(|next| &next.caller == id && next.callee.as_ref() == Some(&concrete.id))
            })
    });
    assert!(deferred.is_some());
}

#[test]
fn reports_virtual_dispatch_without_querying_instance_mir() {
    let facts = facts();
    let declaration = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::dynamic")
        .unwrap();
    let callable = facts
        .callables
        .iter()
        .find(|callable| callable.declaration == declaration.id)
        .unwrap();
    assert!(
        facts
            .gaps
            .iter()
            .any(|gap| gap.owner == callable.id && gap.kind == "unresolved-dynamic-dispatch")
    );
    assert!(
        facts
            .calls
            .iter()
            .any(|call| call.caller == callable.id && call.callee.is_none())
    );
    assert!(
        !facts
            .calls
            .iter()
            .filter(|call| call.caller == callable.id)
            .any(|call| call
                .callee
                .as_ref()
                .is_some_and(
                    |id| facts.callables.iter().any(|candidate| &candidate.id == id
                        && facts
                            .declarations
                            .iter()
                            .any(|definition| definition.id == candidate.declaration
                                && definition.full_name.contains("{impl#")))
                ))
    );
}

#[test]
fn does_not_claim_local_component_copy_mutates_world_storage() {
    let facts = facts();
    let declaration = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::local_copy")
        .unwrap();
    let callable = facts
        .callables
        .iter()
        .find(|callable| callable.declaration == declaration.id)
        .unwrap();
    let mutations: Vec<_> = facts
        .operations
        .iter()
        .filter(|operation| operation.owner == callable.id && operation.kind == "modify")
        .collect();
    assert!(!mutations.is_empty());
    assert!(
        mutations
            .iter()
            .all(|operation| operation.scope == "typed-value")
    );
    assert!(
        facts
            .gaps
            .iter()
            .any(|gap| gap.owner == callable.id && gap.kind == "storage-origin")
    );
}

#[test]
fn records_concrete_helper_creates_and_spawn_at_bundle_payload() {
    let facts = facts();
    let declaration = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::generic_spawn")
        .unwrap();
    let position = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::left::Position")
        .unwrap();
    assert!(facts.operations.iter().any(|operation| {
        operation.kind == "create"
            && facts.callables.iter().any(|callable| {
                callable.id == operation.owner && callable.declaration == declaration.id
            })
            && facts.types.iter().any(|ty| {
                operation.target_type.as_ref() == Some(&ty.id)
                    && ty.declaration.as_ref() == Some(&position.id)
            })
    }));
    let position = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::right::Position")
        .unwrap();
    assert!(facts.operations.iter().any(|operation| {
        operation.kind == "create"
            && operation
                .source
                .as_ref()
                .is_some_and(|source| source.snippet.contains("spawn_at"))
            && facts.types.iter().any(|ty| {
                operation.target_type.as_ref() == Some(&ty.id)
                    && ty.declaration.as_ref() == Some(&position.id)
            })
    }));
    assert!(facts.operations.iter().any(|operation| {
        operation.kind == "create"
            && operation.target_type.is_none()
            && operation
                .source
                .as_ref()
                .is_some_and(|source| source.snippet.contains("spawn_empty"))
    }));
}

#[test]
fn bounds_unicode_previews_and_preserves_complete_source_hashes_and_guards() {
    let facts = facts();
    let declaration = facts
        .declarations
        .iter()
        .find(|declaration| declaration.full_name == "bevy_ecs::long_body")
        .unwrap();
    let source = declaration.source.as_ref().unwrap();
    assert_eq!(
        source.snippet.chars().count(),
        analysis_compiler::ecs::SOURCE_PREVIEW_CHAR_LIMIT
    );
    assert!(source.snippet.contains("编译器源码证据"));
    let complete_source = fs::read(&source.path).unwrap();
    assert_eq!(
        source.sha256,
        format!("{:x}", sha2::Sha256::digest(complete_source))
    );
    assert!(
        facts
            .operations
            .iter()
            .flat_map(|operation| &operation.conditions)
            .any(|guard| guard.snippet.chars().count()
                > analysis_compiler::ecs::SOURCE_PREVIEW_CHAR_LIMIT
                && guard.snippet.contains("编译器源码证据"))
    );
}

#[test]
fn body_and_macro_edits_update_source_hashes_with_identical_published_preview() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/body-evidence");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("lib.rs");
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let arguments = vec![
        "rustc".into(),
        source.to_string_lossy().into_owned(),
        "--crate-name=bevy_ecs".into(),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        sysroot.trim().into(),
        "--out-dir".into(),
        root.to_string_lossy().into_owned(),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
    ];
    let marker = "编译器源码证据".repeat(160);
    let mut versions = vec![];
    for (value, blank_lines) in [(1, 0), (2, 0), (1, 3)] {
        fs::write(&source, format!("#![allow(dead_code)]\npub mod component {{pub trait Component {{}}}}\n{}fn stable_body() {{let _text = {marker:?}; let _changed_body_value = {value};}}\n", "\n".repeat(blank_lines))).unwrap();
        let mut extractor = Extractor { facts: None };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        let facts = extractor.facts.unwrap();
        versions.push(
            facts
                .declarations
                .into_iter()
                .find(|declaration| declaration.full_name == "bevy_ecs::stable_body")
                .unwrap(),
        );
    }
    let before = &versions[0];
    let after = &versions[1];
    assert_eq!(before.id, after.id);
    let old_source = before.source.as_ref().unwrap();
    let new_source = after.source.as_ref().unwrap();
    assert_eq!(
        old_source.snippet.chars().count(),
        analysis_compiler::ecs::SOURCE_PREVIEW_CHAR_LIMIT
    );
    assert_eq!(old_source.snippet, new_source.snippet);
    assert_ne!(old_source.sha256, new_source.sha256);
    let moved = &versions[2];
    assert_eq!(before.id, moved.id);
    assert_ne!(old_source.line, moved.source.as_ref().unwrap().line);
    assert_ne!(old_source.sha256, moved.source.as_ref().unwrap().sha256);
    let mut expansions = vec![];
    for value in [1, 2] {
        fs::write(&source, format!("#![allow(dead_code)]\npub mod component {{pub trait Component {{}}}}\nmacro_rules! behavior {{()=>{{fn stable_body() {{let _changed_body_value = {value};}}}}}}\nbehavior!();\n")).unwrap();
        let mut extractor = Extractor { facts: None };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        expansions.push(
            extractor
                .facts
                .unwrap()
                .declarations
                .into_iter()
                .find(|declaration| declaration.full_name == "bevy_ecs::stable_body")
                .unwrap(),
        );
    }
    assert_ne!(
        expansions[0].source.as_ref().unwrap().sha256,
        expansions[1].source.as_ref().unwrap().sha256
    );
    assert_eq!(expansions[0].id, expansions[1].id);
    assert_eq!(
        expansions[0].source.as_ref().unwrap().snippet,
        expansions[1].source.as_ref().unwrap().snippet
    );
}

#[test]
fn conditional_calls_keep_guards_and_function_pointers_keep_explicit_gaps() {
    let facts = facts();
    let callable = |name: &str| {
        facts
            .callables
            .iter()
            .find(|callable| callable.display == name)
            .unwrap()
    };
    let entry = callable("bevy_ecs::conditional_registration");
    let helper = callable("bevy_ecs::registered");
    let calls: Vec<_> = facts
        .calls
        .iter()
        .filter(|call| call.caller == entry.id && call.callee.as_ref() == Some(&helper.id))
        .collect();
    assert!(!calls.is_empty());
    assert!(calls.iter().all(|call| !call.conditions.is_empty()));
    let indirect = callable("bevy_ecs::indirect");
    assert!(facts.calls.iter().any(|call| call.caller == indirect.id
        && call.callee.is_none()
        && call.unresolved_reason.as_deref() == Some("dynamic-call")));
    assert!(
        facts
            .gaps
            .iter()
            .any(|gap| gap.owner == indirect.id && gap.kind == "dynamic-call")
    );
}
