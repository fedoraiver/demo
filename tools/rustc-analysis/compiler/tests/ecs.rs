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
    for name in ["bevy_ecs", "bevy_scene", "bevy_app"] {
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
        facts.entities.iter().all(|entity| entity.gaps.is_empty()),
        "{:?}",
        facts.entities
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
