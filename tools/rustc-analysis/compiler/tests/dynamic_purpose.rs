//! 用真实调用事实验证动态目标和未覆盖 helper 不能复用局部用途。
#![feature(rustc_private)]
extern crate rustc_driver;
extern crate rustc_interface;
extern crate rustc_middle;

use analysis_contract::{
    facts::{FACT_SCHEMA_VERSION, UnitFacts},
    runtime::{RuntimeSchedule, RuntimeSnapshot, RuntimeSystem},
};
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
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

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn extract(root: &Path, crate_name: &str, source: &Path, extra: &[String]) -> UnitFacts {
    fs::create_dir_all(root).unwrap();
    let sysroot = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(sysroot.status.success());
    let mut args = vec![
        "rustc".into(),
        source.to_string_lossy().into_owned(),
        format!("--crate-name={crate_name}"),
        "--crate-type=lib".into(),
        "--edition=2024".into(),
        "--sysroot".into(),
        String::from_utf8(sysroot.stdout).unwrap().trim().into(),
        "--out-dir".into(),
        root.to_string_lossy().into_owned(),
        format!("-Cmetadata=purpose_{crate_name}"),
        "-Zalways-encode-mir".into(),
        "-Zmir-opt-level=0".into(),
    ];
    args.extend(extra.iter().cloned());
    let mut callback = Extractor::default();
    rustc_driver::compiler_entrypoint(&args, &mut callback);
    callback.facts.unwrap()
}

struct Fixture {
    root: PathBuf,
    units: Vec<UnitFacts>,
}

struct DependencySource<'a> {
    library: &'a str,
    helper: &'a str,
    options: &'a [String],
}

impl Fixture {
    fn new(label: &str, source: &str, dependency_body: Option<u32>) -> Self {
        let helper = dependency_body.map(|value| format!("pub fn value() -> u32 {{ {value} }}\n"));
        let dependency = helper.as_deref().map(|helper| DependencySource {
            library: "mod helper;\npub fn value() -> u32 { helper::value() }\n",
            helper,
            options: &[],
        });
        Self::with_dependency(label, source, dependency)
    }

    fn with_dependency(
        label: &str,
        source: &str,
        dependency_source: Option<DependencySource<'_>>,
    ) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/rustc-analysis/fixtures/dynamic-purpose")
            .join(format!(
                "{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("compiled")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname=\"fixture\"\nversion=\"0.1.0\"\n",
        )
        .unwrap();
        fs::write(root.join("Cargo.lock"), "version = 4\n").unwrap();
        fs::write(root.join("src/lib.rs"), source).unwrap();
        let root = root.canonicalize().unwrap();
        let mut units = vec![];
        let mut extra = vec![];
        if let Some(dependency_source) = dependency_source {
            let dependency = root.join("dependency");
            fs::create_dir_all(dependency.join("src")).unwrap();
            fs::write(dependency.join("src/lib.rs"), dependency_source.library).unwrap();
            fs::write(dependency.join("src/helper.rs"), dependency_source.helper).unwrap();
            let facts = extract(
                &root.join("compiled/dependency"),
                "helper_dep",
                &dependency.join("src/lib.rs"),
                dependency_source.options,
            );
            assert!(
                facts.declarations.is_empty(),
                "The non-ECS dependency must exercise the inventory-only path"
            );
            units.push(facts);
            extra.extend([
                "--extern".into(),
                format!(
                    "helper_dep={}",
                    root.join("compiled/dependency/libhelper_dep.rlib")
                        .display()
                ),
            ]);
        }
        let mut facts = extract(
            &root.join("compiled"),
            "bevy_ecs",
            &root.join("src/lib.rs"),
            &extra,
        );
        let entry = facts
            .callables
            .iter_mut()
            .find(|callable| callable.display == "bevy_ecs::entry")
            .unwrap();
        // 合成 Schedule 只连接同会话取得的真实函数项 TypeId，不补造调用边或目标。
        let runtime_id = entry.runtime_type_id.clone().unwrap();
        entry.system_type_ids.push(runtime_id.clone());
        units.push(facts);
        let schedule_id = hash("main\0Update")[..16].to_owned();
        let dot = "digraph { node_entry; }\n";
        let filename = format!("schedule-{schedule_id}.dot");
        fs::create_dir_all(root.join("debugdump")).unwrap();
        fs::write(root.join("debugdump").join(&filename), dot).unwrap();
        let runtime = RuntimeSnapshot {
            schema_version: 1,
            source_fingerprint: rustc_analysis::model::source_fingerprint(&root).unwrap(),
            target: "fixture".into(),
            features: vec![],
            schedules: vec![RuntimeSchedule {
                id: schedule_id,
                app: "main".into(),
                label: "Update".into(),
                dot_filename: filename,
                dot_sha256: hash(dot),
                systems: vec![RuntimeSystem {
                    key: "entry".into(),
                    graph_name: "node_entry".into(),
                    name: "entry".into(),
                    type_id: runtime_id,
                    access_scope: "finite".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        fs::write(
            root.join("runtime.json"),
            serde_json::to_vec(&runtime).unwrap(),
        )
        .unwrap();
        fs::write(root.join("debugdump/manifest.json"), serde_json::to_vec(&json!({"schemaVersion":1,"sourceFingerprint":runtime.source_fingerprint,
            "schedules":runtime.schedules.iter().map(|schedule|json!({"id":schedule.id,"app":schedule.app,"label":schedule.label,"filename":schedule.dot_filename,"sha256":schedule.dot_sha256})).collect::<Vec<_>>()})).unwrap()).unwrap();
        fs::write(root.join("facts.json"), serde_json::to_vec(&json!({"schemaVersion":FACT_SCHEMA_VERSION,"compiler":env!("ANALYSIS_COMPILER"),
            "configuration":"fixture","workspace":root,"packages":[],"units":units,"runtimeSha256":hash(fs::read(root.join("runtime.json")).unwrap())})).unwrap()).unwrap();
        fs::write(
            root.join("annotations.json"),
            br#"{"schemaVersion":1,"items":{}}"#,
        )
        .unwrap();
        Self { root, units }
    }

    fn facts(&self) -> &UnitFacts {
        self.units.last().unwrap()
    }

    fn compose(&self) -> anyhow::Result<()> {
        rustc_analysis::model::build(
            &self.root.join("facts.json"),
            &self.root.join("runtime.json"),
            &self.root.join("annotations.json"),
            &self.root.join("model.json"),
        )
    }

    fn read(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.root.join(name)).unwrap()).unwrap()
    }

    fn purpose(&self) -> String {
        assert!(
            self.compose()
                .unwrap_err()
                .to_string()
                .contains("Chinese descriptions are pending")
        );
        let pending = self.read("pending-descriptions.json");
        let row = pending
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == "bevy_ecs::entry")
            .unwrap();
        let evidence = row["evidenceHash"].as_str().unwrap().to_owned();
        fs::write(self.root.join("annotations.json"), serde_json::to_vec(&json!({"schemaVersion":1,"items":{"bevy_ecs::entry":{
            "description":"执行测试调用链并返回结果。","summary":"执行测试调用链。","evidenceHash":evidence}}})).unwrap()).unwrap();
        self.compose().unwrap();
        let calls = self.read("model.json")["callGraph"]["file"]
            .as_str()
            .unwrap()
            .to_owned();
        for line in fs::read_to_string(self.root.join(calls)).unwrap().lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            assert!(
                value.get("unresolvedReason").is_none(),
                "Internal analysis causes must not extend the public call graph contract"
            );
        }
        evidence
    }

    fn entry_evidence(&self) -> &str {
        &self
            .facts()
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == "bevy_ecs::entry")
            .unwrap()
            .evidence_hash
    }

    fn reasons(&self) -> Vec<String> {
        self.read("purpose-summary.json")["fallbacks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|fallback| fallback["name"] == "bevy_ecs::entry")
            .flat_map(|fallback| {
                fallback["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|reason| reason.as_str().unwrap().to_owned())
            })
            .collect()
    }
}

#[test]
fn dyn_and_function_pointer_calls_keep_real_causes_and_track_unbound_implementations() {
    let mut evidence = vec![];
    let mut local = vec![];
    for (implementation, helper) in [(1, 3), (2, 3), (1, 5)] {
        let fixture = Fixture::new(
            "dynamic",
            &format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub trait Value {{ fn value(&self) -> u32; }}
pub struct Marker;
impl Value for Marker {{ fn value(&self) -> u32 {{ {implementation} }} }}
pub fn helper() -> u32 {{ {helper} }}
pub fn dyn_caller(value: &dyn Value) -> u32 {{ value.value() }}
pub fn pointer_caller(function: fn() -> u32) -> u32 {{ function() }}
pub fn entry() -> u32 {{ dyn_caller(&Marker) + pointer_caller(helper) }}
"#
            ),
            None,
        );
        for (name, cause) in [
            ("bevy_ecs::dyn_caller", "unresolved-dynamic-dispatch"),
            ("bevy_ecs::pointer_caller", "dynamic-call"),
        ] {
            let callable = fixture
                .facts()
                .callables
                .iter()
                .find(|callable| callable.display == name)
                .unwrap();
            assert!(
                fixture
                    .facts()
                    .calls
                    .iter()
                    .any(|call| call.caller == callable.id
                        && call.callee.is_none()
                        && call.unresolved_reason.as_deref() == Some(cause))
            );
        }
        local.push(fixture.entry_evidence().to_owned());
        evidence.push(fixture.purpose());
        let reasons = fixture.reasons();
        assert!(
            reasons
                .iter()
                .any(|reason| reason.starts_with("unresolved-dynamic-dispatch:"))
        );
        assert!(
            reasons
                .iter()
                .any(|reason| reason.starts_with("dynamic-call:"))
        );
    }
    assert_eq!(local[0], local[1]);
    assert_eq!(local[0], local[2]);
    assert_ne!(
        evidence[0], evidence[1],
        "A changed dynamic impl must invalidate its unchanged caller"
    );
    assert_ne!(
        evidence[0], evidence[2],
        "A changed function-pointer target must invalidate its unchanged caller"
    );
}

#[test]
fn ordinary_generic_helper_alias_changes_use_conservative_purpose_evidence() {
    let mut evidence = vec![];
    for selected in ["First", "Second"] {
        let fixture = Fixture::new(
            "generic-alias",
            &format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub trait Value {{ const NUMBER: u32; }}
pub struct First; pub struct Second;
impl Value for First {{ const NUMBER: u32 = 1; }}
impl Value for Second {{ const NUMBER: u32 = 2; }}
pub type Selected = {selected};
pub fn generic<T: Value>() -> u32 {{ T::NUMBER }}
pub fn entry() -> u32 {{ generic::<Selected>() }}
"#
            ),
            None,
        );
        evidence.push(fixture.purpose());
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("missing-helper-body:"))
        );
    }
    assert_ne!(
        evidence[0], evidence[1],
        "An unproved monomorphic helper instance must not reuse the old selected-type purpose"
    );
}

#[test]
fn a_foreign_helper_without_owning_body_coverage_tracks_changes_in_another_module() {
    let mut evidence = vec![];
    let mut local = vec![];
    for value in [1, 2] {
        let fixture = Fixture::new(
            "foreign-helper",
            "pub mod component { pub trait Component {} }\npub fn entry() -> u32 { helper_dep::value() }\n",
            Some(value),
        );
        local.push(fixture.entry_evidence().to_owned());
        evidence.push(fixture.purpose());
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("missing-helper-body:"))
        );
    }
    assert_eq!(local[0], local[1]);
    assert_ne!(
        evidence[0], evidence[1],
        "helper.rs changes must invalidate the caller even when the foreign entry file is unchanged"
    );
}

#[test]
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn inline_assembly_symbol_calls_require_conservative_purpose_evidence() {
    let mut evidence = vec![];
    let mut local = vec![];
    for value in [1, 2] {
        let fixture = Fixture::new(
            "inline-assembly",
            &format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub extern "C" fn helper() -> u32 {{ {value} }}
pub fn entry() {{ unsafe {{ core::arch::asm!("call {{target}}", target = sym helper, clobber_abi("C")); }} }}
"#
            ),
            None,
        );
        let entry = fixture
            .facts()
            .callables
            .iter()
            .find(|callable| callable.display == "bevy_ecs::entry")
            .unwrap();
        assert!(
            entry.body_analyzed,
            "The test must exercise an otherwise covered HIR body"
        );
        assert!(
            fixture
                .facts()
                .calls
                .iter()
                .chain(fixture.facts().purpose_calls.iter())
                .any(|call| call.caller == entry.id
                    && call.callee.is_none()
                    && call.unresolved_reason.as_deref() == Some("inline-assembly"))
        );
        local.push(fixture.entry_evidence().to_owned());
        evidence.push(fixture.purpose());
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("inline-assembly:"))
        );
    }
    assert_eq!(
        local[0], local[1],
        "The assembly and its sym operand keep the same local syntax"
    );
    assert_ne!(
        evidence[0], evidence[1],
        "A helper referenced only by assembly must invalidate the conservative caller purpose"
    );
}

#[test]
fn implicit_drop_changes_invalidate_an_otherwise_closed_local_body() {
    let mut evidence = vec![];
    let mut local = vec![];
    for value in [1, 2] {
        let fixture = Fixture::new(
            "implicit-drop",
            &format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub struct Guard;
impl Drop for Guard {{ fn drop(&mut self) {{ let _value = {value}; }} }}
pub fn entry() {{ let _guard = Guard; }}
"#
            ),
            None,
        );
        let entry = fixture
            .facts()
            .callables
            .iter()
            .find(|callable| callable.display == "bevy_ecs::entry")
            .unwrap();
        assert!(
            entry.body_analyzed,
            "The closed-body marker must follow actual MIR auditing"
        );
        assert!(
            fixture
                .facts()
                .purpose_calls
                .iter()
                .any(|call| call.caller == entry.id
                    && call.callee.is_none()
                    && call.unresolved_reason.as_deref() == Some("implicit-drop")),
            "An implicit MIR Drop must appear in the exact caller's evidence"
        );
        local.push(fixture.entry_evidence().to_owned());
        evidence.push(fixture.purpose());
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("implicit-drop:"))
        );
    }
    assert_eq!(local[0], local[1]);
    assert_ne!(
        evidence[0], evidence[1],
        "Changing only Drop::drop must invalidate the unchanged caller's purpose"
    );
}

#[test]
fn purpose_audit_calls_do_not_add_unconditional_public_helper_edges() {
    let mut evidence = vec![];
    for value in [1, 2] {
        let fixture = Fixture::new(
            "conditional-helper",
            &format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub fn helper() -> u32 {{ {value} }}
pub fn entry(flag: bool) -> u32 {{ if flag {{ helper() }} else {{ 0 }} }}
"#
            ),
            None,
        );
        let entry = fixture
            .facts()
            .callables
            .iter()
            .find(|callable| callable.display == "bevy_ecs::entry")
            .unwrap();
        let helper = fixture
            .facts()
            .callables
            .iter()
            .find(|callable| callable.display == "bevy_ecs::helper")
            .unwrap();
        let public: Vec<_> = fixture
            .facts()
            .calls
            .iter()
            .filter(|call| call.caller == entry.id && call.callee.as_ref() == Some(&helper.id))
            .collect();
        assert!(!public.is_empty());
        assert!(
            public.iter().all(|call| !call.conditions.is_empty()),
            "The real HIR helper call retains its guard"
        );
        let private: Vec<_> = fixture
            .facts()
            .purpose_calls
            .iter()
            .filter(|call| call.caller == entry.id && call.callee.as_ref() == Some(&helper.id))
            .collect();
        assert!(
            !private.is_empty() && private.iter().all(|call| call.conditions.is_empty()),
            "MIR purpose auditing deliberately does not certify execution guards"
        );
        evidence.push(fixture.purpose());
        let model = fixture.read("model.json");
        assert!(model.get("purposeCalls").is_none());
        let filename = model["callGraph"]["file"].as_str().unwrap();
        let edges: Vec<Value> = fs::read_to_string(fixture.root.join(filename))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|edge| edge["caller"] == entry.id && edge["callee"] == helper.id)
            .collect();
        assert!(!edges.is_empty());
        assert!(
            edges
                .iter()
                .all(|edge| !edge["conditions"].as_array().unwrap().is_empty()),
            "Private unguarded audit copies must never enter the public call graph"
        );
        assert!(edges.len() <= public.len());
    }
    assert_ne!(
        evidence[0], evidence[1],
        "Separating private audit records must not remove helper purpose dependencies"
    );
}

#[test]
fn fallback_purpose_tracks_overflow_options_with_identical_sources_and_debug_cfg() {
    let mut evidence = vec![];
    let mut local = vec![];
    let mut contexts = vec![];
    for overflow in ["yes", "no"] {
        let options = vec![
            "-Cdebug-assertions=no".into(),
            format!("-Coverflow-checks={overflow}"),
        ];
        let fixture = Fixture::with_dependency(
            "overflow-profile",
            "pub mod component { pub trait Component {} }\npub fn entry() -> u8 { helper_dep::value(255) }\n",
            Some(DependencySource {
                library: "mod helper;\npub fn value(x: u8) -> u8 { helper::value(x) }\n",
                helper: "#[cfg(debug_assertions)]\ncompile_error!(\"The test fixes debug_assertions=no\");\npub fn value(x: u8) -> u8 { x + 1 }\n",
                options: &options,
            }),
        );
        contexts.push(fixture.units[0].behavior_hash.clone());
        local.push(fixture.entry_evidence().to_owned());
        evidence.push(fixture.purpose());
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("missing-helper-body:"))
        );
    }
    assert_eq!(
        local[0], local[1],
        "The unchanged consumer does not encode an uncovered dependency's overflow profile"
    );
    assert_ne!(
        contexts[0], contexts[1],
        "A full owning fallback context must cover actual semantic options beyond cfg"
    );
    assert_ne!(
        evidence[0], evidence[1],
        "Overflow behavior changes require reviewing old fallback descriptions even when every source byte stays identical"
    );
}

#[test]
fn a_struct_field_alias_target_participates_in_local_type_purpose_evidence() {
    let mut fields = vec![];
    let mut evidence = vec![];
    let mut identities = vec![];
    for selected in ["u8", "u16"] {
        let fixture = Fixture::new(
            "struct-field-alias",
            &format!(
                r#"
pub mod component {{ pub trait Component {{}} }}
pub type Selected = {selected};
pub struct Stored {{ pub value: Selected }}
impl component::Component for Stored {{}}
pub fn entry() {{}}
"#
            ),
            None,
        );
        let declaration = fixture
            .facts()
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == "bevy_ecs::Stored")
            .unwrap();
        let instance = fixture
            .facts()
            .types
            .iter()
            .find(|instance| {
                instance.declaration.as_ref() == Some(&declaration.id)
                    && !instance.fields.is_empty()
            })
            .unwrap();
        identities.push(declaration.id.clone());
        fields.push(instance.fields[0].type_id.clone());
        evidence.push(declaration.evidence_hash.clone());
    }
    assert_eq!(identities[0], identities[1]);
    assert_ne!(
        fields[0], fields[1],
        "The compiler confirms that Stored now carries a different resolved field type"
    );
    assert_ne!(
        evidence[0], evidence[1],
        "A stable alias path must not certify an old description of the containing type's data"
    );
}

#[test]
fn repeated_const_dag_exhausts_the_work_budget_and_preserves_fallback_invalidation() {
    let mut evidence = vec![];
    for leaf in [1, 2] {
        let mut source = format!(
            "pub mod component {{ pub trait Component {{}} }}\nconst fn leaf() -> u32 {{ {leaf} }}\n"
        );
        // 五层共享 DAG 的语法很小；每个引用重新展开 HIR 与 typed MIR 会放大实际工作。
        for level in 1..=5 {
            let previous = if level == 1 {
                "leaf".to_owned()
            } else {
                format!("level{}", level - 1)
            };
            source.push_str(&format!(
                "const fn level{level}() -> u32 {{ let _ = {previous}(); let _ = {previous}(); {previous}() }}\n"
            ));
        }
        source.push_str("pub fn entry() -> u32 { level5() }\n");
        let fixture = Fixture::new("const-dag-budget", &source, None);
        let declaration = fixture
            .facts()
            .declarations
            .iter()
            .find(|declaration| declaration.full_name == "bevy_ecs::entry")
            .unwrap();
        assert!(
            fixture
                .facts()
                .gaps
                .iter()
                .any(|gap| { gap.owner == declaration.id && gap.kind == "purpose-work-budget" }),
            "The 1024-expansion budget must record the exact entry declaration; unresolved={}",
            declaration.unresolved_behavior
        );
        assert!(declaration.unresolved_behavior);
        assert!(fixture.root.join("compiled/libbevy_ecs.rlib").is_file());
        assert!(
            fixture
                .facts()
                .purpose_inventory
                .coverage
                .iter()
                .all(|coverage| coverage.complete),
            "Exhausted semantic work must preserve native inventory coverage and use owning fallback"
        );
        evidence.push(fixture.purpose());
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("compiler-unresolved:")),
            "A bounded partial traversal must never certify local purpose evidence"
        );
        assert!(
            fixture
                .reasons()
                .iter()
                .any(|reason| reason.starts_with("purpose-work-budget:")),
            "The declaration sidecar must retain the compiler's concrete work-budget cause"
        );
    }
    assert_ne!(
        evidence[0], evidence[1],
        "A changed DAG leaf must invalidate the final purpose through the complete owning fallback"
    );
}
