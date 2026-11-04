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

#[test]
fn caller_purpose_tracks_a_downstream_impl_used_inside_a_dependency_generic() {
    use analysis_contract::runtime::{RuntimeSchedule, RuntimeSnapshot, RuntimeSystem};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/downstream-constant-purpose");
    let dependency = root.join("dependency");
    let consumer = root.join("consumer");
    fs::create_dir_all(dependency.join("src")).unwrap();
    fs::create_dir_all(consumer.join("src")).unwrap();
    fs::create_dir_all(consumer.join("debugdump")).unwrap();
    let dependency_source = dependency.join("src/lib.rs");
    let consumer_source = consumer.join("src/lib.rs");
    fs::write(
        dependency.join("Cargo.toml"),
        "[package]\nname=\"bevy_ecs\"\nversion=\"0.1.0\"\n",
    )
    .unwrap();
    fs::write(
        consumer.join("Cargo.toml"),
        "[package]\nname=\"consumer\"\nversion=\"0.1.0\"\n",
    )
    .unwrap();
    fs::write(consumer.join("Cargo.lock"), "version = 4\n").unwrap();
    fs::write(&dependency_source, "").unwrap();
    fs::write(&consumer_source, "").unwrap();
    let root = root.canonicalize().unwrap();
    let dependency = dependency.canonicalize().unwrap();
    let consumer = consumer.canonicalize().unwrap();
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
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let artifact = dependency.join("libfixture.rlib");
    let digest = |bytes: &[u8]| format!("{:x}", sha2::Sha256::digest(bytes));
    let mut hashes = vec![];
    for (label, number, metadata) in [
        ("Original", 1, "first"),
        ("Changed", 1, "first"),
        ("Original", 2, "first"),
        ("Original", 1, "second"),
    ] {
        fs::write(&dependency_source, format!("pub mod component {{ pub trait Component {{}} }}\npub const NUMBER: u32 = {number};\npub trait Named {{ const LABEL: &'static str; const NUMBER: u32; }}\npub fn create<T: Named>() -> (&'static str, u32) {{ (T::LABEL, T::NUMBER) }}\n")).unwrap();
        fs::write(&consumer_source, format!("struct Marker;\nimpl bevy_ecs::Named for Marker {{ const LABEL: &'static str = {label:?}; const NUMBER: u32 = bevy_ecs::NUMBER; }}\npub fn entry() {{ let _values = bevy_ecs::create::<Marker>(); }}\n")).unwrap();
        let compiled = Command::new("rustc")
            .arg(&dependency_source)
            .args([
                "--crate-name=bevy_ecs",
                "--crate-type=rlib",
                "--edition=2024",
                "-Zalways-encode-mir",
            ])
            .arg(format!("-Cmetadata={metadata}"))
            .arg("-o")
            .arg(&artifact)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let mut units = vec![];
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
            } else {
                arguments.push(format!("-Cmetadata={metadata}"));
            }
            let mut extractor = OriginExtractor {
                facts: None,
                origins: origins.clone(),
            };
            rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
            units.push(extractor.facts.unwrap());
        }
        // 测试仅模拟 runtime 绑定；声明、泛型实例、初始化体和调用边均来自上面的真实编译。
        units[1]
            .callables
            .iter_mut()
            .find(|callable| callable.display == "consumer::entry")
            .unwrap()
            .system_type_ids
            .push("entry-runtime".into());
        let dot = "digraph { entry; }\n";
        let schedule_id = digest(b"main\0Update")[..16].to_owned();
        fs::write(consumer.join("debugdump/schedule.dot"), dot).unwrap();
        let runtime = RuntimeSnapshot {
            schema_version: 1,
            source_fingerprint: rustc_analysis::model::source_fingerprint(&consumer).unwrap(),
            target: "fixture".into(),
            schedules: vec![RuntimeSchedule {
                id: schedule_id.clone(),
                app: "main".into(),
                label: "Update".into(),
                dot_filename: "schedule.dot".into(),
                dot_sha256: digest(dot.as_bytes()),
                systems: vec![RuntimeSystem {
                    key: "entry".into(),
                    graph_name: "entry".into(),
                    name: "consumer::entry".into(),
                    type_id: "entry-runtime".into(),
                    access_scope: "finite".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let runtime_bytes = serde_json::to_vec(&runtime).unwrap();
        fs::write(consumer.join("runtime.json"), &runtime_bytes).unwrap();
        fs::write(consumer.join("debugdump/manifest.json"), serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"sourceFingerprint":runtime.source_fingerprint,"schedules":[{"id":schedule_id,"app":"main","label":"Update","filename":"schedule.dot","sha256":digest(dot.as_bytes())}]})).unwrap()).unwrap();
        fs::write(consumer.join("facts.json"), serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"compiler":"fixed-compiler","configuration":"fixed-build","workspace":consumer,"packages":[{"name":"bevy_ecs","version":"0.1.0","manifest_path":dependency.join("Cargo.toml")}],"units":units,"runtimeSha256":digest(&runtime_bytes)})).unwrap()).unwrap();
        fs::write(
            consumer.join("annotations.json"),
            b"{\"schemaVersion\":1,\"items\":{}}",
        )
        .unwrap();
        let result = rustc_analysis::model::build(
            &consumer.join("facts.json"),
            &consumer.join("runtime.json"),
            &consumer.join("annotations.json"),
            &consumer.join("model.json"),
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Chinese descriptions are pending")
        );
        let pending: serde_json::Value =
            serde_json::from_slice(&fs::read(consumer.join("pending-descriptions.json")).unwrap())
                .unwrap();
        hashes.push(
            pending
                .as_array()
                .unwrap()
                .iter()
                .find(|purpose| purpose["key"] == "consumer::entry")
                .unwrap()["evidenceHash"]
                .clone(),
        );
    }
    assert_ne!(
        hashes[0], hashes[1],
        "A downstream impl value must invalidate the caller's final purpose"
    );
    assert_eq!(
        hashes[0], hashes[3],
        "Dependency metadata alone must not invalidate the final caller purpose"
    );
    assert_ne!(
        hashes[0], hashes[2],
        "A foreign initializer used by the downstream impl must invalidate the final caller purpose"
    );
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
            .map(|declaration| {
                (
                    declaration.full_name.clone(),
                    (declaration.id.clone(), declaration.evidence_hash.clone()),
                )
            })
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
                    .any(|(id, _)| ty.declaration.as_ref() == Some(id))
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
fn purpose_evidence_tracks_name_initializer_and_helper_body_changes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/reuse-initializer-evidence");
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
    let mut versions = vec![];
    for (name, value, helper) in [
        ("Original", 1, 1),
        ("Changed", 1, 1),
        ("Original", 2, 1),
        ("Original", 1, 2),
    ] {
        fs::write(&source, format!("#![allow(dead_code)]\npub mod component {{ pub trait Component {{}} }}\nstruct Name(&'static str);\nfn create() {{ let _name = Name({name:?}); let _initial_value = {value}; helper(); }}\nfn helper() {{ let _ = {helper}; }}\n")).unwrap();
        let mut extractor = Extractor { facts: None };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        versions.push(
            extractor
                .facts
                .unwrap()
                .declarations
                .into_iter()
                .filter(|declaration| {
                    matches!(
                        declaration.full_name.as_str(),
                        "bevy_ecs::create" | "bevy_ecs::helper"
                    )
                })
                .map(|declaration| (declaration.full_name, declaration.evidence_hash))
                .collect::<std::collections::BTreeMap<_, _>>(),
        );
    }
    assert_ne!(
        versions[0]["bevy_ecs::create"],
        versions[1]["bevy_ecs::create"]
    );
    assert_ne!(
        versions[0]["bevy_ecs::create"],
        versions[2]["bevy_ecs::create"]
    );
    assert_eq!(
        versions[0]["bevy_ecs::create"],
        versions[3]["bevy_ecs::create"]
    );
    assert_ne!(
        versions[0]["bevy_ecs::helper"],
        versions[3]["bevy_ecs::helper"]
    );
}

// for 展开生成的 const trait 函数路径不填 node_args，提取仍须完成三种具体迭代。
#[test]
fn purpose_evidence_resolves_const_trait_functions_in_desugared_for_loops() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/desugared-const-trait-functions");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("lib.rs");
    fs::write(
        &source,
        r#"
pub mod component { pub trait Component {} }
pub fn borrowed(values: &[u32]) -> u32 {
    let mut total = 0;
    for value in values { total += value; }
    total
}
pub fn owned(values: Vec<u32>) -> u32 {
    let mut total = 0;
    for value in values { total += value; }
    total
}
pub fn mutable(values: &mut [u32]) {
    for value in values { *value += 1; }
}
"#,
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
    let mut extractor = Extractor { facts: None };
    rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
    let facts = extractor.facts.unwrap();
    for function in ["borrowed", "owned", "mutable"] {
        let declaration = facts
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == format!("bevy_ecs::{function}"))
            .unwrap();
        assert!(!declaration.evidence_hash.is_empty());
    }
}

#[test]
fn purpose_evidence_tracks_referenced_constants_without_hashing_unrelated_declarations() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/reuse-constant-evidence");
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
    let mut versions = vec![];
    for (name, value, unrelated) in [
        ("Original", 1, 1),
        ("Changed", 1, 1),
        ("Original", 2, 1),
        ("Original", 1, 2),
    ] {
        fs::write(&source, format!("#![allow(dead_code)]\npub mod component {{ pub trait Component {{}} }}\nstruct Name(&'static str);\nconst NAME: &str = {name:?};\nconst fn initial_value() -> u32 {{ {value} }}\nconst VALUE: u32 = initial_value();\nconst UNRELATED: u32 = {unrelated};\nstruct Node(&'static Node);\nstatic LEFT: Node = Node(&RIGHT);\nstatic RIGHT: Node = Node(&LEFT);\nfn create() {{ let _name = Name(NAME); let _initial_value = VALUE; let _cyclic_reference = &LEFT; }}\n")).unwrap();
        let mut extractor = Extractor { facts: None };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        versions.push(
            extractor
                .facts
                .unwrap()
                .declarations
                .into_iter()
                .find(|declaration| declaration.full_name == "bevy_ecs::create")
                .unwrap()
                .evidence_hash,
        );
    }
    assert_ne!(versions[0], versions[1]);
    assert_ne!(versions[0], versions[2]);
    assert_eq!(
        versions[0], versions[3],
        "An unrelated constant must not invalidate the creator purpose"
    );
}

#[test]
fn purpose_evidence_tracks_referenced_external_constant_values() {
    let versions = external_initializer_evidence("const");
    assert_ne!(versions[0], versions[1]);
    assert_ne!(versions[0], versions[2]);
    assert_eq!(versions[0], versions[3]);
}

#[test]
fn purpose_evidence_tracks_referenced_external_static_values() {
    let versions = external_initializer_evidence("static");
    assert_ne!(versions[0], versions[1]);
    assert_ne!(versions[0], versions[2]);
    assert_ne!(
        versions[0], versions[5],
        "Equal allocation bytes with different static types must not reuse a purpose"
    );
    assert_eq!(
        versions[0], versions[4],
        "A dependency metadata-only change must reuse the static purpose"
    );
}

#[test]
fn purpose_evidence_tracks_external_cyclic_static_relocations() {
    let versions = external_initializer_evidence("relocation");
    assert_ne!(
        versions[0], versions[1],
        "Pointer relocation targets affect static evidence"
    );
    assert_ne!(
        versions[0], versions[2],
        "Values reached through a cyclic static reference affect evidence"
    );
    assert_eq!(
        versions[0], versions[3],
        "Unreferenced static values must not affect the caller"
    );
    assert_eq!(
        versions[0], versions[4],
        "Native allocation IDs and dependency metadata must not enter static evidence"
    );
}

#[test]
fn purpose_evidence_tracks_external_const_function_mir() {
    let versions = external_initializer_evidence("const-function");
    assert_ne!(versions[0], versions[1]);
    assert_ne!(versions[0], versions[2]);
    assert_eq!(versions[0], versions[3]);
    assert_eq!(
        versions[0], versions[4],
        "External const fn MIR evidence must ignore dependency metadata"
    );
}

#[test]
fn foreign_generic_trait_uncertainty_is_retained_without_metadata_identity() {
    let versions = external_initializer_evidence("trait");
    assert_eq!(
        versions[0], versions[4],
        "A dependency metadata-only change must reuse unresolved trait purposes"
    );
}

fn external_initializer_evidence(storage: &str) -> Vec<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../../tmp/rustc-analysis/fixtures/reuse-external-{storage}-evidence"
    ));
    let dependency = root.join("dependency");
    let consumer = root.join("consumer");
    fs::create_dir_all(&dependency).unwrap();
    fs::create_dir_all(&consumer).unwrap();
    let dependency_source = dependency.join("lib.rs");
    let consumer_source = consumer.join("lib.rs");
    fs::write(&dependency_source, "").unwrap();
    let consumer_code = if storage == "trait" {
        "struct Marker;\nimpl bevy_ecs::Named for Marker { const LABEL: &'static str = bevy_ecs::NAME; }\nfn create<T: bevy_ecs::Named>() { let _name = T::LABEL; }\npub fn entry() { create::<Marker>(); }\n"
    } else if storage == "relocation" {
        "pub fn create() { let _root = bevy_ecs::ROOT; }\n"
    } else if storage == "const-function" {
        "pub fn create() { let _name = bevy_ecs::name(); let _number = bevy_ecs::number(); }\n"
    } else {
        "pub fn create() { let _name = bevy_ecs::NAME; let _number = bevy_ecs::NUMBER; }\n"
    };
    fs::write(&consumer_source, consumer_code).unwrap();
    let artifact = dependency.join("libfixture.rlib");
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
    let arguments = vec![
        "rustc".into(),
        consumer_source.to_string_lossy().into_owned(),
        "--crate-name=consumer".into(),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        sysroot.trim().into(),
        "--out-dir".into(),
        root.to_string_lossy().into_owned(),
        "--extern".into(),
        format!("bevy_ecs={}", artifact.display()),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
    ];
    let mut versions = vec![];
    for (name, number, unrelated, metadata) in [
        ("Original", 1, 1, "first"),
        ("Changed", 1, 1, "first"),
        ("Original", 2, 1, "first"),
        ("Original", 1, 2, "first"),
        ("Original", 1, 1, "second"),
        ("Original", 1, 1, "typechange"),
    ] {
        let declaration_storage = if storage == "trait" { "const" } else { storage };
        let (number_type, number_value) = if storage == "static" {
            if metadata == "typechange" {
                ("f32", "0.0".to_owned())
            } else {
                ("u32", (number - 1).to_string())
            }
        } else {
            ("u32", number.to_string())
        };
        let dependency_code = if storage == "relocation" {
            let target = if name == "Original" { "LEFT" } else { "RIGHT" };
            format!(
                "pub mod component {{ pub trait Component {{}} }}\npub struct Node {{ pub value: u32, pub next: &'static Node }}\npub static LEFT: Node = Node {{ value: {number}, next: &RIGHT }};\npub static RIGHT: Node = Node {{ value: 29, next: &LEFT }};\npub static ROOT: &Node = &{target};\npub static UNRELATED: u32 = {unrelated};\n"
            )
        } else if storage == "const-function" {
            format!(
                "pub mod component {{ pub trait Component {{}} }}\npub const fn name() -> &'static str {{ {name:?} }}\npub const fn number() -> u32 {{ {number} }}\npub const UNRELATED: u32 = {unrelated};\n"
            )
        } else {
            format!(
                "pub mod component {{ pub trait Component {{}} }}\npub trait Named {{ const LABEL: &'static str; }}\npub {declaration_storage} NAME: &str = {name:?};\npub {declaration_storage} NUMBER: {number_type} = {number_value};\npub const UNRELATED: u32 = {unrelated};\n"
            )
        };
        fs::write(&dependency_source, dependency_code).unwrap();
        let compiled = Command::new("rustc")
            .args([
                dependency_source.as_os_str(),
                "--crate-name=bevy_ecs".as_ref(),
                "--crate-type=rlib".as_ref(),
                "--edition=2024".as_ref(),
                format!("-Cmetadata={metadata}").as_ref(),
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
        let mut extractor = OriginExtractor {
            facts: None,
            origins: origins.clone(),
        };
        rustc_driver::compiler_entrypoint(&arguments, &mut extractor);
        let declaration = extractor
            .facts
            .unwrap()
            .declarations
            .into_iter()
            .find(|declaration| declaration.full_name == "consumer::create")
            .unwrap();
        if storage == "trait" {
            assert!(
                declaration.unresolved_behavior,
                "Unknown dispatch must survive into the final model"
            );
        }
        versions.push(declaration.evidence_hash);
    }
    versions
}

#[test]
fn purpose_evidence_tracks_generic_trait_impl_constant_values() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/reuse-generic-constant-evidence");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("lib.rs");
    let compiler = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = String::from_utf8(compiler.stdout).unwrap();
    let mut versions = vec![];
    for (name, metadata, blank_lines) in [
        ("Original", "a", 0),
        ("Changed", "a", 0),
        ("Original", "b", 3),
    ] {
        fs::write(&source, format!("#![allow(dead_code)]\n{}pub mod component {{ pub trait Component {{}} }}\ntrait Named {{ const LABEL: &'static str; }}\nstruct Marker;\nimpl Named for Marker {{ const LABEL: &'static str = {name:?}; }}\nfn create<T: Named>() {{ let _name = T::LABEL; }}\nfn entry() {{ create::<Marker>(); }}\n", "\n".repeat(blank_lines))).unwrap();
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
        versions.push(
            extractor
                .facts
                .unwrap()
                .declarations
                .into_iter()
                .find(|declaration| declaration.full_name == "bevy_ecs::create")
                .unwrap()
                .evidence_hash,
        );
    }
    assert_ne!(
        versions[0], versions[1],
        "The selected generic impl initializer must invalidate its creator"
    );
    assert_eq!(
        versions[0], versions[2],
        "Conservative constant evidence must still ignore metadata and line movement"
    );
}

#[test]
fn compiler_metadata_does_not_change_declaration_identity_or_local_purpose() {
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
                .map(|declaration| {
                    (
                        declaration.full_name,
                        (declaration.id, declaration.evidence_hash),
                    )
                })
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
    assert!(
        facts
            .entities
            .iter()
            .all(|entity| entity.gaps.iter().all(|gap| matches!(
                gap.kind.as_str(),
                "entity-alternative" | "entity-multiplicity"
            ) || gap.reason.contains("独立结构候选")
                || gap.reason.contains("没有可达返回状态"))),
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
    let by_id: std::collections::BTreeMap<_, _> = facts
        .entities
        .iter()
        .map(|entity| (&entity.id, entity))
        .collect();
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
fn bounds_unicode_previews_after_hashing_full_declaration_and_preserves_guards() {
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
    let preview_hash = format!(
        "{:x}",
        sha2::Sha256::digest(
            serde_json::to_vec(&(
                &declaration.source,
                &declaration.full_name,
                &declaration.docs
            ))
            .unwrap()
        )
    );
    assert_ne!(declaration.evidence_hash, preview_hash);
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
fn body_only_edit_invalidates_description_with_identical_published_preview() {
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
    assert_eq!(before.docs, after.docs);
    let old_source = before.source.as_ref().unwrap();
    let new_source = after.source.as_ref().unwrap();
    assert_eq!(
        old_source.snippet.chars().count(),
        analysis_compiler::ecs::SOURCE_PREVIEW_CHAR_LIMIT
    );
    assert_eq!(old_source.snippet, new_source.snippet);
    assert_ne!(old_source.sha256, new_source.sha256);
    assert_ne!(before.evidence_hash, after.evidence_hash);
    let moved = &versions[2];
    assert_eq!(before.id, moved.id);
    assert_eq!(before.evidence_hash, moved.evidence_hash);
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
    assert_eq!(expansions[0].id, expansions[1].id);
    assert_eq!(
        expansions[0].source.as_ref().unwrap().snippet,
        expansions[1].source.as_ref().unwrap().snippet
    );
    assert_ne!(expansions[0].evidence_hash, expansions[1].evidence_hash);
}
