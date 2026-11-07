//! 通过真实 Cargo 和编译器 driver 验证规则；夹具函数与游戏均不执行。

use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

use check_entity_names::{
    model::{DiagnosticKind, NameEvidence, Report, Site},
    workspace::{self, Options},
};

fn site() -> Site {
    Site {
        path: "src/example.rs".into(),
        line: 1,
        column: 1,
    }
}

#[test]
fn presence_content_and_related_entities_are_independent() {
    let mut report = Report::default();
    report.entity(
        &NameEvidence::Name(Some("root".into())),
        &site(),
        &[],
        "valid".into(),
    );
    report.entity(&NameEvidence::Absent, &site(), &[], "missing".into());
    report.entity(
        &NameEvidence::Name(Some(String::new())),
        &site(),
        &[],
        "empty".into(),
    );
    report.entity(
        &NameEvidence::Name(None),
        &site(),
        &[],
        "dynamic-name".into(),
    );
    report.entity(
        &NameEvidence::Unknown("dynamic scene".into()),
        &site(),
        &[],
        "dynamic-scene".into(),
    );
    report.entity(
        &NameEvidence::Combined(vec![
            NameEvidence::Name(Some("parent".into())),
            NameEvidence::Related(vec![NameEvidence::Absent]),
        ]),
        &site(),
        &[],
        "parent".into(),
    );
    assert_eq!(
        report
            .diagnostics
            .iter()
            .filter(|item| item.kind == DiagnosticKind::Violation)
            .count(),
        3
    );
    assert_eq!(
        report
            .diagnostics
            .iter()
            .filter(|item| item.kind == DiagnosticKind::Unresolved)
            .count(),
        1
    );
    assert!(
        report
            .diagnostics
            .iter()
            .all(|item| !item.reason.starts_with("dynamic-name:"))
    );
    let mut unresolved = Report::default();
    unresolved.entity(
        &NameEvidence::Unknown("dynamic scene".into()),
        &site(),
        &[],
        "dynamic-scene".into(),
    );
    assert!(
        unresolved.has_errors(),
        "Unresolved Name presence must fail without any definite violation"
    );
    let mut named = Report::default();
    named.entity(
        &NameEvidence::Name(None),
        &site(),
        &[],
        "dynamic-name".into(),
    );
    assert!(
        !named.has_errors(),
        "Dynamic content with confirmed Name presence must pass"
    );
}

#[test]
fn confirmed_parent_names_do_not_hide_unresolved_or_invalid_children() {
    for name in [None, Some("parent".into())] {
        let mut report = Report::default();
        report.entity(
            &NameEvidence::Combined(vec![
                NameEvidence::Name(name),
                NameEvidence::Unknown("runtime tuple field".into()),
                NameEvidence::Related(vec![
                    NameEvidence::Unknown("dynamic child scene".into()),
                    NameEvidence::Absent,
                    NameEvidence::Name(Some(String::new())),
                ]),
            ]),
            &site(),
            &[],
            "parent".into(),
        );
        assert_eq!(
            report
                .diagnostics
                .iter()
                .filter(|item| item.kind == DiagnosticKind::Violation)
                .count(),
            2
        );
        assert_eq!(
            report
                .diagnostics
                .iter()
                .filter(|item| item.kind == DiagnosticKind::Unresolved)
                .count(),
            1
        );
        assert!(
            report
                .diagnostics
                .iter()
                .all(|item| item.reason.starts_with("parent/related["))
        );
    }
}

#[test]
fn conditional_scene_fragments_preserve_missing_branches() {
    let mut report = Report::default();
    report.entity(
        &NameEvidence::Combined(vec![NameEvidence::Alternatives(vec![
            NameEvidence::Name(Some("ok".into())),
            NameEvidence::Absent,
        ])]),
        &site(),
        &[],
        "conditional".into(),
    );
    assert!(report.has_errors());
}

fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn check(options: &Options) -> anyhow::Result<Report> {
    let mut options = options.clone();
    options.driver = Some(PathBuf::from(env!(
        "CARGO_BIN_EXE_check-entity-names-driver"
    )));
    workspace::check(&options)
}

fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    if fs::read_to_string(&path).ok().as_deref() != Some(content) {
        fs::write(path, content).unwrap();
    }
}

fn fixture() -> &'static Report {
    static REPORT: OnceLock<Result<Report, String>> = OnceLock::new();
    REPORT.get_or_init(|| {
        let root = project_root().join("tmp/entity-names/fixture");
        write(&root, "Cargo.toml", r#"[package]
name = "entity-name-fixture"
version = "0.0.0"
edition = "2024"
[dependencies]
bevy_ecs = "=0.20.0"
bevy_scene = "=0.20.0"
fixture-macros = { path = "macros" }
fixture-factories = { path = "factories" }
[features]
extra = []
"#);
        write(&root, "factories/Cargo.toml", r#"[package]
name = "fixture-factories"
version = "0.0.0"
edition = "2024"
[dependencies]
bevy_ecs = "=0.20.0"
bevy_scene = "=0.20.0"
"#);
        write(&root, "factories/src/lib.rs", r#"use bevy_ecs::prelude::*;
use bevy_scene::prelude::*;
pub fn named() -> Box<dyn Scene> { Box::new(bsn! { #ExternalName }) }
pub fn missing() -> Box<dyn Scene> { Box::new(bsn! { }) }
pub fn internal_entities(world: &mut World) { world.spawn_empty(); }
pub fn clear(name: &mut Name) { name.set(""); }
"#);
        write(&root, "macros/Cargo.toml", r#"[package]
name = "fixture-macros"
version = "0.0.0"
edition = "2024"
[lib]
proc-macro = true
"#);
        write(&root, "macros/src/lib.rs", r#"extern crate proc_macro;
use proc_macro::TokenStream;
#[proc_macro]
pub fn named_spawn(input: TokenStream) -> TokenStream {
    format!("{{ {}.spawn(bevy_ecs::name::Name::new(\"from proc macro\")); }}", input).parse().unwrap()
}
#[proc_macro]
pub fn missing_spawn(input: TokenStream) -> TokenStream {
    format!("{{ {}.spawn_empty(); }}", input).parse().unwrap()
}
#[proc_macro_attribute]
pub fn with_spawn(_: TokenStream, item: TokenStream) -> TokenStream {
    format!("{} fn generated_attribute(world: &mut bevy_ecs::world::World) {{ world.spawn_empty(); }}", item).parse().unwrap()
}
#[proc_macro_derive(SpawnCheck)]
pub fn spawn_check(_: TokenStream) -> TokenStream {
    "impl Derived { fn generated_derive(world: &mut bevy_ecs::world::World) { world.spawn_empty(); } }".parse().unwrap()
}
"#);
        write(&root, "src/lib.rs", r#"#![allow(dead_code, unused_must_use, unused_variables, unused_assignments)]
use bevy_ecs::prelude::*;
use bevy_scene::prelude::*;
use fixture_macros::{named_spawn, missing_spawn, with_spawn, SpawnCheck};
#[cfg(any())] mod inactive;
#[derive(Component, Default, Clone)] struct Marker;
#[derive(Component, Default)] #[require(Name::new("required"))] struct RequiresName;
#[derive(Component)] #[require(RequiresName)] struct Transitive;
#[derive(Component, Default)] struct NameLike;
#[derive(Component)] #[require(NameLike)] struct NotNamed;
#[derive(Component)] #[require(Name)] struct EmptyRequired;
#[derive(Bundle)] struct NamedBundle { name: Name, marker: Marker }
#[derive(Bundle)] struct IgnoredName { #[bundle(ignore)] name: Name, marker: Marker }
#[derive(Component)] struct EmbeddedName { name: Name }
mod fake { use super::*; #[derive(Component)] pub struct NameEntityReference { pub name: Name } }
fn fake_record(world: &mut World) { world.spawn(fake::NameEntityReference { name: Name::new("field only") }); }
fn inactive_configuration(world: &mut World, choose: bool) {
    match choose {
        #[cfg(any())] _ => missing_macro!(),
        _ => { world.spawn(Name::new("active configuration")); }
    }
}
fn valid(world: &mut World) { world.spawn((Name::new("ok"), Marker)); }
fn missing(world: &mut World) { world.spawn(Marker); }
fn late(world: &mut World) { world.spawn(Marker).insert(Name::new("too late")); }
fn empty(world: &mut World) { world.spawn(Name::new("")); }
fn required(world: &mut World) { world.spawn(RequiresName); }
fn transitive(world: &mut World) { world.spawn(Transitive); }
fn name_like(world: &mut World) { world.spawn(NotNamed); }
fn required_empty(world: &mut World) { world.spawn(EmptyRequired); }
fn required_does_not_override_explicit(world: &mut World) { world.spawn((Name::new(""), RequiresName)); }
fn converted(world: &mut World) { let name: Name = "converted".into(); world.spawn(name); }
fn ufcs_bad(world: &mut World) { World::spawn(world, Marker); }
struct Factory;
impl Factory { fn emit<B: Bundle>(&self, world: &mut World, bundle: B) { world.spawn(bundle); } }
fn method_good(world: &mut World) { Factory.emit(world, Name::new("method")); }
fn method_bad(world: &mut World) { Factory.emit(world, Marker); }
fn bundle(world: &mut World) { world.spawn(NamedBundle { name: Name::new("bundle"), marker: Marker }); }
fn embedded(world: &mut World) { world.spawn(EmbeddedName { name: Name::new("field only") }); }
fn dynamic_name(world: &mut World, value: String) { world.spawn(Name::new(value)); }
fn ignored_name_bad(world: &mut World) { world.spawn(IgnoredName { name: Name::new("ignored"), marker: Marker }); }
fn dependency_good(world: &mut World) { world.spawn_scene(fixture_factories::named()); }
fn dependency_bad(world: &mut World) { world.spawn_scene(fixture_factories::missing()); }
fn dependency_internal(world: &mut World) { fixture_factories::internal_entities(world); }
fn dependency_mutation_bad(world: &mut World) { let mut name = Name::new("before"); fixture_factories::clear(&mut name); world.spawn(name); }
fn mutate_alias<F: FnOnce(&mut Name)>(name: &mut Name, change: F) { change(name); }
fn closure_alias_bad(world: &mut World) { let mut name = Name::new("before"); mutate_alias(&mut name, |name| name.set("")); world.spawn(name); }
fn correlated_good(world: &mut World, flag: bool) { let name = if flag { Name::new("ok") } else { Name::new("") }; if flag { world.spawn(name); } }
fn correlated_bad(world: &mut World, flag: bool) { let name = if flag { Name::new("") } else { Name::new("ok") }; if flag { world.spawn(name); } }
struct BranchFlags { flag: bool }
fn field_correlated_good(world: &mut World, flags: &BranchFlags) { let name = if flags.flag { Name::new("ok") } else { Name::new("") }; if flags.flag { world.spawn(name); } }
#[derive(PartialEq)] enum Choice { First, Second }
fn predicate_correlated_good(world: &mut World, choice: Choice) { let name = if choice == Choice::First { Name::new("ok") } else { Name::new("") }; if choice == Choice::First { world.spawn(name); } }
fn scene_pair() -> (bool, Box<dyn Scene>) { let flag = std::hint::black_box(true); (flag, Box::new(bsn! { Name({if flag { "valid" } else { "" }}) })) }
fn cached_pair_good(world: &mut World) { let (flag, scene) = scene_pair(); if flag { world.spawn_scene(scene); } }
fn cached_pair_again(world: &mut World) { cached_pair_good(world); }
fn queued_good(world: &mut World) { let name = Name::new("captured"); world.commands().queue(move |world: &mut World| { world.spawn(name); }); }
fn queued_bad(world: &mut World) { let name = Name::new(""); world.commands().queue(move |world: &mut World| { world.spawn(name); }); }
fn queued_empty_bad(world: &mut World) { world.commands().queue(|world: &mut World| { world.spawn_empty(); }); }
fn constant_scene_good(world: &mut World) { world.spawn_scene(bsn! { Name("constant root") Children [ Name("constant child") ] }); }
fn constant_scene_bad(world: &mut World) { world.spawn_scene(bsn! { Name("constant root") Children [ Marker ] }); }
fn scalar_capture_scene_good(world: &mut World) { let flag = true; world.spawn_scene(bsn! { Name("root") Children [ Name({if flag { "one" } else { "two" }}) ] }); }
fn numeric_branch_good(world: &mut World) { world.spawn(Name::new(if -1.0_f32 > 0.0 { "" } else { "valid" })); }
fn template_good(world: &mut World) { world.spawn_scene(bevy_ecs::template::template(|_| Ok(Name::new("factory")))); }
fn template_bad(world: &mut World) { world.spawn_scene(bevy_ecs::template::template(|_| Ok(Name::new("")))); }
fn recursive_scene() -> Box<dyn Scene> { if std::hint::black_box(true) { Box::new(named_scene()) } else { recursive_scene() } }
fn recursive_good(world: &mut World) { world.spawn_scene(recursive_scene()); }
fn recursive_never(choose: bool) -> Box<dyn Scene> { if choose { Box::new(named_scene()) } else { recursive_never(choose) } }
fn recursive_never_good(world: &mut World, choose: bool) { world.spawn_scene(recursive_never(choose)); }
fn mutual_left() -> Box<dyn Scene> { if std::hint::black_box(true) { Box::new(named_scene()) } else { mutual_right() } }
fn mutual_right() -> Box<dyn Scene> { if std::hint::black_box(true) { Box::new(fragment()) } else { mutual_left() } }
fn mutual_bad(world: &mut World) { world.spawn_scene(mutual_left()); }
fn recursive_tree() -> Box<dyn Scene> { if std::hint::black_box(true) { Box::new(named_scene()) } else { Box::new(bsn! { #Root Children [ @{recursive_tree()} ] }) } }
fn recursive_unknown(world: &mut World) { world.spawn_scene(recursive_tree()); }
#[cfg(feature = "extra")] fn extra_missing(world: &mut World) { world.spawn_empty(); }
fn inner<B: Bundle>(world: &mut World, bundle: B) { world.spawn(bundle); }
fn outer<B: Bundle>(world: &mut World, bundle: B) { inner(world, bundle); }
fn generic_good(world: &mut World) { outer(world, (Name::new("generic"), Marker)); }
fn generic_bad(world: &mut World) { outer(world, Marker); }
fn default_inner<B: Bundle + Default>(world: &mut World) { world.spawn(B::default()); }
fn default_outer<B: Bundle + Default>(world: &mut World) { default_inner::<B>(world); }
fn generic_type_good(world: &mut World) { default_outer::<RequiresName>(world); }
fn generic_type_bad(world: &mut World) { default_outer::<Marker>(world); }
fn generic_type_empty(world: &mut World) { default_outer::<Name>(world); }
fn inferred_default<B: Bundle + Default>(world: &mut World, _bundle: B) { default_inner::<B>(world); }
fn inferred_default_good(world: &mut World) { inferred_default(world, RequiresName); }
fn inferred_default_bad(world: &mut World) { inferred_default(world, Marker); }
fn empty_name() -> Name { Name::new("") }
fn nonempty_name() -> Name { Name::new("helper") }
fn helper_name_bad(world: &mut World) { world.spawn(empty_name()); }
fn helper_name_good(world: &mut World) { world.spawn(nonempty_name()); }
macro_rules! declare { ($world:expr, $($value:expr),*) => { $( $world.spawn($value); )* }; }
fn declarative_good(world: &mut World) { declare!(world, Name::new("a"), Name::new("b")); }
fn declarative_bad(world: &mut World) { declare!(world, Marker); }
fn procedural_good(world: &mut World) { named_spawn!(world); }
fn procedural_bad(world: &mut World) { missing_spawn!(world); }
#[with_spawn] fn attributed() {}
#[derive(SpawnCheck, Clone)] struct Derived;
fn named_scene() -> impl Scene { bsn! { #Named Marker } }
fn fragment() -> impl Scene { bsn! { Marker } }
fn include<S: Scene>(scene: S) -> impl Scene { bsn! { @scene } }
fn scene_good(world: &mut World) { world.spawn_scene(bsn! { #Root Children [ @named_scene() -- Name("child") ] }); }
fn scene_bad(world: &mut World) { world.spawn_scene(bsn! { #Root Children [ Marker ] }); }
fn scene_empty(world: &mut World) { world.spawn_scene(bsn! { Name }); }
fn unnamed_list() -> impl SceneList { bsn_list! { #First -- Marker } }
fn list_bad(world: &mut World) { world.spawn_scene(bsn! { #Root Children [ { unnamed_list() } ] }); }
fn composition_good(world: &mut World) { world.spawn_scene(bsn! { Name("combined") @fragment() }); }
fn scene_generic_good(world: &mut World) { world.spawn_scene(include(named_scene())); }
fn scene_generic_bad(world: &mut World) { world.spawn_scene(include(fragment())); }
fn finite_good(world: &mut World, choose: bool) {
    let scene: Box<dyn Scene> = if choose { Box::new(named_scene()) } else { Box::new(bsn! { Name("other") }) };
    world.spawn_scene(scene);
}
fn finite_bad(world: &mut World, choose: bool) {
    let scene: Box<dyn Scene> = if choose { Box::new(named_scene()) } else { Box::new(fragment()) };
    world.spawn_scene(scene);
}
fn dynamic_scene(world: &mut World, scene: Box<dyn Scene>) { world.spawn_scene(scene); }
fn composed_finite_bad(world: &mut World, choose: bool) {
    let content: Box<dyn Scene> = if choose { Box::new(named_scene()) } else { Box::new(fragment()) };
    world.spawn_scene(bsn! { @content });
}
enum ScenePage { Main, Other, Hidden }
fn stop_scene() -> ! { panic!("no scene is returned") }
fn boxed_match_good(world: &mut World, page: ScenePage) {
    let content: Box<dyn Scene> = match page {
        ScenePage::Main => Box::new(named_scene()),
        ScenePage::Other => Box::new(bsn! { Name("other page") }),
        ScenePage::Hidden => unreachable!(),
    };
    world.spawn_scene(bsn! { #Outer Children [ @{content} ] });
}
fn boxed_never_function_good(world: &mut World, choose: bool) {
    let content: Box<dyn Scene> = match choose {
        true => Box::new(named_scene()),
        false => stop_scene(),
    };
    world.spawn_scene(bsn! { #Outer Children [ @{content} ] });
}
fn boxed_match_bad(world: &mut World, page: ScenePage) {
    let content: Box<dyn Scene> = match page {
        ScenePage::Main => Box::new(named_scene()),
        ScenePage::Other => Box::new(fragment()),
        ScenePage::Hidden => unreachable!(),
    };
    world.spawn_scene(bsn! { #Outer Children [ @{content} ] });
}
fn boxed_match_dynamic(world: &mut World, choose: bool, scene: Box<dyn Scene>) {
    let content: Box<dyn Scene> = match choose {
        true => scene,
        false => unreachable!(),
    };
    world.spawn_scene(bsn! { #Outer Children [ @{content} ] });
}
fn never_branch_creates_unnamed(world: &mut World, choose: bool) {
    let content: Box<dyn Scene> = match choose {
        true => { world.spawn_empty(); unreachable!() },
        false => Box::new(named_scene()),
    };
    world.spawn_scene(bsn! { #Outer Children [ @{content} ] });
}
fn never_statement_creates_named(world: &mut World, choose: bool) {
    let content: Box<dyn Scene> = match choose {
        true => { world.spawn(Name::new("before panic")); unreachable!(); },
        false => Box::new(named_scene()),
    };
    world.spawn_scene(bsn! { #Outer Children [ @{content} ] });
}
fn assigned_scene_bad(world: &mut World, choose: bool) {
    let mut scene: Box<dyn Scene> = Box::new(named_scene());
    if choose { scene = Box::new(fragment()); }
    world.spawn_scene(scene);
}
fn assigned_scene_good(world: &mut World, choose: bool) {
    let mut scene: Box<dyn Scene> = Box::new(named_scene());
    match choose { true => { scene = Box::new(named_scene()); }, false => {} }
    world.spawn_scene(scene);
}
fn early_scene(choose: bool) -> Box<dyn Scene> {
    if choose { return Box::new(fragment()); }
    Box::new(named_scene())
}
fn early_bad(world: &mut World, choose: bool) { world.spawn_scene(early_scene(choose)); }
fn early_good_scene(choose: bool) -> Box<dyn Scene> {
    if choose { return Box::new(named_scene()); }
    Box::new(named_scene())
}
fn early_good(world: &mut World, choose: bool) { world.spawn_scene(early_good_scene(choose)); }
fn assigned_name_bad(world: &mut World, choose: bool) {
    let mut name = Name::new("initial");
    if choose { name = Name::new(""); }
    world.spawn(name);
}
fn conditional_name_bad(world: &mut World, choose: bool) {
    world.spawn(Name::new(if choose { "nonempty" } else { "" }));
}
fn mutated_name_bad(world: &mut World) {
    let mut name = Name::new("initial"); name.set(""); world.spawn(name);
}
fn mutated_name_good(world: &mut World) {
    let mut name = Name::default(); name.set("nonempty"); world.spawn(name);
}
fn shadowed_name_good(world: &mut World) {
    let name = Name::new("outer"); { let name = Name::new(""); let _ = name; } world.spawn(name);
}
fn nested_name_bad(world: &mut World) {
    let mut name = Name::new("outer"); { name = Name::new(""); } world.spawn(name);
}
fn unrelated_name_mutation(world: &mut World) {
    let mut name = Name::new("local only"); name.0 = "still local".into(); world.spawn(Marker);
}
fn batch_good(world: &mut World) { world.spawn_batch([Name::new("a"), Name::new("b")]); }
fn batch_bad(world: &mut World) { world.spawn_batch([Marker, Marker]); }
struct Other;
impl Other { fn spawn(&self, _: Marker) {} }
fn unrelated() { Other.spawn(Marker); }
#[cfg(test)] mod tests { use super::*; fn fixture(world: &mut World) { world.spawn_empty(); } }
"#);
        let source_path = root.join("src/lib.rs");
        let mut source = fs::read_to_string(&source_path).unwrap();
        for (name, leaf) in [("deep_good", "Name(\"leaf\")"), ("deep_bad", "Marker")] {
            let scene = (0..12).fold(leaf.to_string(), |child, _| format!("Name(\"parent\") Children [ {child} ]"));
            source.push_str(&format!("\nfn {name}_scene() -> Box<dyn Scene> {{ Box::new(bsn! {{ {scene} }}) }}\nfn {name}(world: &mut World) {{ world.spawn_scene({name}_scene()); }}\nfn {name}_again(world: &mut World) {{ {name}(world); }}\n"));
        }
        fs::write(source_path, source).unwrap();
        write(&root, "src/inactive.rs", "#[derive(UnavailableMacro)] struct Inactive;\n");
        if !root.join("Cargo.lock").exists() {
            fs::copy(project_root().join("Cargo.lock"), root.join("Cargo.lock")).unwrap();
        }
        let output = Command::new("cargo").args(["metadata", "--offline", "--format-version", "1", "--manifest-path"]).arg(root.join("Cargo.toml")).output().unwrap();
        assert!(output.status.success(), "Cannot prepare fixture lockfile: {}", String::from_utf8_lossy(&output.stderr));
        check(&Options::new(root)).map_err(|error| format!("{error:#}"))
    }).as_ref().unwrap()
}

fn messages_for(function: &str) -> Vec<&'static check_entity_names::model::Diagnostic> {
    fixture()
        .diagnostics
        .iter()
        .filter(|item| item.trace.iter().any(|name| name == function))
        .collect()
}

#[test]
fn tracks_generic_callers_and_rejects_late_or_embedded_names() {
    for name in [
        "missing",
        "late",
        "empty",
        "embedded",
        "fake_record",
        "generic_bad",
        "batch_bad",
        "name_like",
        "required_empty",
        "required_does_not_override_explicit",
        "ufcs_bad",
        "method_bad",
        "generic_type_bad",
        "generic_type_empty",
        "inferred_default_bad",
        "helper_name_bad",
    ] {
        assert!(
            messages_for(name)
                .iter()
                .any(|item| item.kind == DiagnosticKind::Violation),
            "Expected violation in {name}"
        );
    }
    for name in [
        "valid",
        "required",
        "bundle",
        "generic_good",
        "batch_good",
        "unrelated",
        "transitive",
        "converted",
    ] {
        assert!(
            messages_for(name).is_empty(),
            "Unexpected violation in {name}: {:?}",
            messages_for(name)
        );
    }
    for name in [
        "valid",
        "required",
        "bundle",
        "generic_good",
        "batch_good",
        "transitive",
        "converted",
        "method_good",
        "inactive_configuration",
        "generic_type_good",
        "inferred_default_good",
        "helper_name_good",
    ] {
        assert!(
            fixture()
                .entities
                .iter()
                .any(|item| item.trace.iter().any(|entry| entry == name)),
            "The checker skipped {name}"
        );
        assert!(
            messages_for(name).is_empty(),
            "Expected a verified name in {name}: {:?}",
            messages_for(name)
        );
    }
}

#[test]
fn expands_declarative_function_attribute_and_derive_macros() {
    for name in [
        "declarative_bad",
        "procedural_bad",
        "generated_attribute",
        "generated_derive",
    ] {
        assert!(
            messages_for(name)
                .iter()
                .any(|item| item.kind == DiagnosticKind::Violation),
            "Expected macro violation in {name}"
        );
    }
    for name in ["declarative_good", "procedural_good"] {
        assert!(
            messages_for(name).is_empty(),
            "Unexpected macro diagnostic in {name}: {:?}",
            messages_for(name)
        );
    }
}

#[test]
fn follows_bsn_composition_related_entities_and_finite_dynamic_branches() {
    for name in [
        "scene_bad",
        "scene_generic_bad",
        "finite_bad",
        "scene_empty",
        "list_bad",
        "composed_finite_bad",
    ] {
        assert!(
            messages_for(name)
                .iter()
                .any(|item| item.kind == DiagnosticKind::Violation),
            "Expected scene violation in {name}"
        );
    }
    for name in [
        "scene_good",
        "composition_good",
        "scene_generic_good",
        "finite_good",
    ] {
        assert!(
            messages_for(name).is_empty(),
            "Unexpected scene violation in {name}: {:?}",
            messages_for(name)
        );
    }
    assert!(
        fixture()
            .entities
            .iter()
            .any(|item| item.trace.iter().any(|entry| entry == "dynamic_name"))
    );
    assert!(messages_for("dynamic_name").is_empty());
    let messages = messages_for("dynamic_scene");
    assert!(
        !messages.is_empty()
            && messages
                .iter()
                .all(|item| item.kind == DiagnosticKind::Unresolved),
        "Expected unresolved Name errors for the dynamic scene: {messages:?}"
    );
    assert!(messages_for("fixture").is_empty());
}

#[test]
fn excludes_never_arms_without_hiding_entity_creations() {
    for name in [
        "boxed_match_good",
        "boxed_never_function_good",
        "never_statement_creates_named",
    ] {
        assert!(
            fixture()
                .entities
                .iter()
                .any(|item| item.trace.iter().any(|entry| entry == name)),
            "The checker skipped {name}"
        );
        assert!(
            messages_for(name).is_empty(),
            "Expected a verified boxed scene in {name}: {:?}",
            messages_for(name)
        );
    }
    let missing = messages_for("boxed_match_bad");
    assert!(
        missing
            .iter()
            .any(|item| item.kind == DiagnosticKind::Violation
                && item.reason.contains("Name is missing at creation"))
    );
    assert!(
        missing
            .iter()
            .all(|item| item.kind == DiagnosticKind::Violation)
    );
    let dynamic = messages_for("boxed_match_dynamic");
    assert_eq!(dynamic.len(), 1);
    assert!(
        dynamic[0].kind == DiagnosticKind::Unresolved
            && dynamic[0]
                .reason
                .contains("Name presence cannot be determined")
    );
    let inside_never = messages_for("never_branch_creates_unnamed");
    assert_eq!(inside_never.len(), 1, "{inside_never:?}");
    assert!(
        inside_never[0].kind == DiagnosticKind::Violation
            && inside_never[0].reason.starts_with("spawn_empty:")
    );
}

#[test]
fn follows_branch_assignments_early_returns_and_name_mutation() {
    for name in [
        "assigned_scene_bad",
        "early_bad",
        "assigned_name_bad",
        "conditional_name_bad",
        "mutated_name_bad",
        "unrelated_name_mutation",
        "nested_name_bad",
    ] {
        assert!(
            messages_for(name)
                .iter()
                .any(|item| item.kind == DiagnosticKind::Violation),
            "Expected violation in {name}: {:?}",
            messages_for(name)
        );
    }
    for name in [
        "assigned_scene_good",
        "early_good",
        "mutated_name_good",
        "shadowed_name_good",
    ] {
        assert!(
            fixture()
                .entities
                .iter()
                .any(|item| item.trace.iter().any(|entry| entry == name)),
            "The checker skipped {name}"
        );
        assert!(
            messages_for(name).is_empty(),
            "Expected a verified name in {name}: {:?}",
            messages_for(name)
        );
    }
}

#[test]
fn follows_dependency_mir_aliases_captures_and_correlated_branches() {
    for name in [
        "ignored_name_bad",
        "dependency_bad",
        "dependency_mutation_bad",
        "closure_alias_bad",
        "correlated_bad",
        "queued_bad",
        "queued_empty_bad",
        "template_bad",
        "constant_scene_bad",
    ] {
        assert!(
            messages_for(name)
                .iter()
                .any(|item| item.kind == DiagnosticKind::Violation),
            "Expected violation in {name}: {:?}",
            messages_for(name)
        );
    }
    for name in [
        "dependency_good",
        "correlated_good",
        "field_correlated_good",
        "predicate_correlated_good",
        "cached_pair_good",
        "cached_pair_again",
        "queued_good",
        "template_good",
        "constant_scene_good",
        "scalar_capture_scene_good",
        "numeric_branch_good",
    ] {
        assert!(
            fixture()
                .entities
                .iter()
                .any(|item| item.trace.iter().any(|entry| entry == name)),
            "Skipped {name}"
        );
        assert!(
            messages_for(name).is_empty(),
            "Unexpected diagnostic in {name}: {:?}",
            messages_for(name)
        );
    }
    assert!(messages_for("dependency_internal").is_empty());
    assert!(!fixture().entities.iter().any(|item| {
        item.trace
            .iter()
            .any(|entry| entry == "dependency_internal")
    }));
    let missing = messages_for("ignored_name_bad");
    assert!(missing[0].reason.contains("Name is missing"));
    let empty = messages_for("template_bad");
    assert!(empty[0].reason.contains("Name is empty"));
}

#[test]
fn converges_recursive_returns_and_preserves_deep_cached_hierarchies() {
    for name in [
        "recursive_good",
        "recursive_never_good",
        "deep_good",
        "deep_good_again",
    ] {
        assert!(
            fixture()
                .entities
                .iter()
                .any(|item| item.trace.iter().any(|entry| entry == name)),
            "Skipped {name}"
        );
        assert!(
            messages_for(name).is_empty(),
            "Unexpected diagnostic in {name}: {:?}",
            messages_for(name)
        );
    }
    for name in ["mutual_bad", "deep_bad", "deep_bad_again"] {
        assert!(
            messages_for(name)
                .iter()
                .any(|item| item.kind == DiagnosticKind::Violation),
            "Expected violation in {name}: {:?}",
            messages_for(name)
        );
    }
    assert!(
        messages_for("recursive_unknown")
            .iter()
            .any(|item| item.kind == DiagnosticKind::Unresolved
                && item.reason.contains("analysis budget"))
    );
    assert!(
        !messages_for("recursive_unknown")
            .iter()
            .any(|item| item.kind == DiagnosticKind::Violation)
    );
}

#[test]
fn cli_rejects_unresolved_names_with_source_trace_and_help() {
    fixture();
    let root = project_root().join("tmp/entity-names/cli-outcomes");
    write(
        &root,
        "Cargo.toml",
        r#"[package]
name = "entity-name-cli-outcomes"
version = "0.0.0"
edition = "2024"
[dependencies]
bevy_ecs = "=0.20.0"
bevy_scene = "=0.20.0"
"#,
    );
    let unresolved = "use bevy_ecs::prelude::*;\nuse bevy_scene::prelude::*;\nmacro_rules! create { ($world:expr, $scene:expr) => { $world.spawn_scene($scene) }; }\nfn unresolved_source(world: &mut World, scene: Box<dyn Scene>) { create!(world, scene); }\npub fn outer(world: &mut World, scene: Box<dyn Scene>) { unresolved_source(world, scene); }\n";
    write(&root, "src/lib.rs", unresolved);
    // 保留项目已锁定的撤回版本，避免冷缓存下重新选版使离线夹具失效。
    fs::copy(project_root().join("Cargo.lock"), root.join("Cargo.lock")).unwrap();
    let lock = Command::new("cargo")
        .args([
            "metadata",
            "--offline",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(root.join("Cargo.toml"))
        .output()
        .unwrap();
    assert!(
        lock.status.success(),
        "Cannot prepare the CLI fixture lockfile: {}",
        String::from_utf8_lossy(&lock.stderr)
    );
    let output = Command::new(env!("CARGO_BIN_EXE_check-entity-names"))
        .arg(&root)
        .output()
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        output.status.code(),
        Some(1),
        "Unresolved-only scans must fail: {stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let source = workspace::normalized(&root.join("src/lib.rs")).unwrap();
    for expected in [
        format!("{source}:4:"),
        "error[unresolved-name]".into(),
        "Name presence cannot be determined".into(),
        "outer -> unresolved_source".into(),
        "macro".into(),
        "help:".into(),
        "0 violations".into(),
    ] {
        assert!(
            stdout.contains(&expected),
            "Missing diagnostic detail {expected}: {stdout}"
        );
    }
    for (source, expected_code, expected_message) in [
        (
            "use bevy_ecs::prelude::*;\npub fn named(world: &mut World, value: String) { world.spawn(Name::new(value)); }\n",
            0,
            "0 unresolved names",
        ),
        (
            "use bevy_ecs::prelude::*;\npub fn missing(world: &mut World) { world.spawn_empty(); }\n",
            1,
            "error[entity-name]",
        ),
    ] {
        write(&root, "src/lib.rs", source);
        let output = Command::new(env!("CARGO_BIN_EXE_check-entity-names"))
            .arg(&root)
            .output()
            .unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            output.status.code(),
            Some(expected_code),
            "Unexpected CLI result: {stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains(expected_message),
            "Unexpected diagnostic: {stdout}"
        );
    }
}

#[test]
fn reruns_warm_scans_and_honors_feature_selection() {
    let expected = fixture();
    let root = project_root().join("tmp/entity-names/fixture");
    let repeated = check(&Options::new(root.clone())).unwrap();
    assert_eq!(expected.entities, repeated.entities);
    assert_eq!(expected.diagnostics, repeated.diagnostics);
    let mut selected = Options::new(root.clone());
    selected.features.push("extra".into());
    let selected = check(&selected).unwrap();
    assert!(
        selected
            .diagnostics
            .iter()
            .any(|item| item.kind == DiagnosticKind::Violation
                && item.trace.iter().any(|frame| frame == "extra_missing"))
    );
    let restored = check(&Options::new(root)).unwrap();
    assert_eq!(expected.entities, restored.entities);
    assert_eq!(expected.diagnostics, restored.diagnostics);
}

#[test]
fn build_script_artifacts_do_not_require_reports_outside_selected_library_sources() {
    let root = project_root().join("tmp/rustc-analysis/fixtures/entity-name-build-script-targets");
    write(
        &root,
        "Cargo.toml",
        "[package]\nname = \"entity-name-build-script-targets\"\nversion = \"0.0.0\"\nedition = \"2024\"\n",
    );
    write(
        &root,
        "Cargo.lock",
        "version = 4\n[[package]]\nname = \"entity-name-build-script-targets\"\nversion = \"0.0.0\"\n",
    );
    write(
        &root,
        "build.rs",
        "fn main() { println!(\"cargo::rerun-if-changed=build.rs\"); }\n",
    );
    write(&root, "src/lib.rs", "pub fn production_source() {}\n");
    for _ in 0..2 {
        let report = check(&Options::new(root.clone()))
            .expect("Only selected library sources require entity-name reports");
        assert!(!report.has_errors());
    }
}

#[test]
fn rejects_missing_stale_and_incompatible_driver_reports() {
    let root = project_root().join("tmp/entity-names/driver-errors");
    write(
        &root,
        "Cargo.toml",
        "[package]\nname = \"entity-name-driver-errors\"\nversion = \"0.0.0\"\nedition = \"2024\"\n",
    );
    write(
        &root,
        "Cargo.lock",
        "version = 4\n[[package]]\nname = \"entity-name-driver-errors\"\nversion = \"0.0.0\"\n",
    );
    write(&root, "src/lib.rs", "pub fn noop() {}\n");
    let source = r#"use std::{env, fs, path::Path, process::{Command, ExitCode}};
fn main() -> ExitCode {
    let args: Vec<_> = env::args().skip(1).collect();
    let executable = env::current_exe().unwrap();
    let nested = args.first().and_then(|program| fs::canonicalize(program).ok()) == Some(executable.canonicalize().unwrap());
    if nested {
        let status = Command::new(&args[0]).args(&args[1..]).status().unwrap();
        return if status.success() { ExitCode::SUCCESS } else { ExitCode::from(2) };
    }
    let mut child = Command::new(__DRIVER__).args(&args).spawn().unwrap();
    let pid = child.id();
    let status = child.wait().unwrap();
    if !status.success() { return ExitCode::from(2); }
    let compiled = args.iter().any(|arg| arg == "--crate-name" || arg.starts_with("--crate-name="))
        && args.iter().any(|arg| arg.ends_with(".rs") && Path::new(arg).is_file());
    if !compiled { return ExitCode::SUCCESS; }
    let prefix = format!("{pid}-");
    for entry in fs::read_dir(env::var_os("ANALYSIS_REPORTS").unwrap()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "json")
            || !path.file_name().unwrap().to_string_lossy().starts_with(&prefix) { continue; }
        let mode = executable.file_stem().unwrap().to_string_lossy();
        let json = fs::read_to_string(&path).unwrap();
        fs::write(Path::new(__CAPTURE__).join(format!("injected-{mode}-{}", path.file_name().unwrap().to_string_lossy())), &json).unwrap();
        if mode.starts_with("missing") { fs::remove_file(path).unwrap(); }
        else {
            let json = if mode.starts_with("stale") {
                assert!(json.contains("\"run\":\""));
                json.replacen("\"run\":\"", "\"run\":\"stale-", 1)
            } else {
                let compiler = format!("\"compiler\":{:?}", "__COMPILER__");
                assert!(json.contains(&compiler));
                json.replacen(&compiler, "\"compiler\":\"wrong-compiler\"", 1)
            };
            fs::write(path, json).unwrap();
        }
    }
    ExitCode::SUCCESS
}
"#;
    write(
        &root,
        "stub.rs",
        &source
            .replace(
                "__DRIVER__",
                &serde_json::to_string(env!("CARGO_BIN_EXE_check-entity-names-driver")).unwrap(),
            )
            .replace(
                "__CAPTURE__",
                &serde_json::to_string(&root.to_string_lossy()).unwrap(),
            )
            .replace("__COMPILER__", env!("ENTITY_CHECK_COMPILER")),
    );
    let stub = root.join(format!("missing-driver{}", std::env::consts::EXE_SUFFIX));
    let output = Command::new("rustc")
        .current_dir(&root)
        .args(["--edition=2024", "stub.rs", "-o"])
        .arg(&stub)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Cannot build fault-injection wrapper: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let captured_paths = |mode: &str| -> BTreeSet<PathBuf> {
        let prefix = format!("injected-{mode}-driver-");
        fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&prefix)
                    && path
                        .extension()
                        .is_some_and(|extension| extension == "json")
            })
            .collect()
    };
    for mode in ["missing", "stale", "wrong"] {
        let before = captured_paths(mode);
        let path = root.join(format!("{mode}-driver{}", std::env::consts::EXE_SUFFIX));
        if path != stub {
            fs::copy(&stub, &path).unwrap();
        }
        let mut options = Options::new(root.clone());
        options.driver = Some(path);
        let error = workspace::check(&options).unwrap_err();
        let captures: Vec<_> = captured_paths(mode).difference(&before).cloned().collect();
        assert!(
            !captures.is_empty(),
            "The fault must be injected after a real source compilation"
        );
        for captured in captures {
            let produced: analysis_contract::UnitReport =
                serde_json::from_slice(&fs::read(captured).unwrap()).unwrap();
            assert_eq!(
                produced.schema_version,
                analysis_contract::ANALYSIS_SCHEMA_VERSION
            );
            assert!(produced.analyzed && produced.inputs.complete && produced.failure.is_none());
            assert_eq!(produced.compiler, env!("ENTITY_CHECK_COMPILER"));
        }
        assert!(
            error
                .chain()
                .all(|cause| cause.downcast_ref::<serde_json::Error>().is_none()),
            "Fault injection must reach provenance validation with a valid shared report: {error:#}"
        );
        let message = format!("{error:#}");
        assert!(
            message.contains(if mode == "missing" {
                "Missing or ambiguous compiler facts after one package recovery"
            } else {
                "Stale or incompatible compiler report"
            }),
            "Unexpected {mode} report result: {message}"
        );
    }
    write(
        &root,
        "src/lib.rs",
        "pub fn broken() { unavailable_macro!(); }\n",
    );
    let output = Command::new(env!("CARGO_BIN_EXE_check-entity-names"))
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(2),
        "Compiler and macro errors must be tool failures"
    );
}

#[test]
fn production_source_entities_have_names_at_creation() {
    let mut options = Options::new(project_root());
    options.target = std::env::var("ENTITY_NAME_CHECK_TARGET")
        .ok()
        .filter(|value| !value.is_empty());
    options.features = std::env::var("ENTITY_NAME_CHECK_FEATURES")
        .unwrap_or_default()
        .split(',')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    options.all_features = std::env::var("ENTITY_NAME_CHECK_ALL_FEATURES")
        .is_ok_and(|value| value.eq_ignore_ascii_case("true"));
    let report = check(&options).unwrap();
    report.print();
    assert!(
        !report.has_errors(),
        "Production entity declarations violate the Name contract or have unresolved Name presence"
    );
    assert!(
        !report.entities.is_empty(),
        "The production scan must discover entity creations"
    );
}
