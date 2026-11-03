//! 通过真实 Cargo 编译检查当前配置的结构体；不执行夹具程序。
use check_named_fields::{
    report::Report,
    runner::{self, Options},
};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/named-fields/fixtures")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(root.join("src")).unwrap();
        Self { root }
    }
    fn write(&self, path: &str, text: &str) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn options(&self) -> Options {
        let mut options = Options::new(self.root.clone());
        options.driver = Some(env!("CARGO_BIN_EXE_check-named-fields-driver").into());
        options
    }
    fn lock(&self) {
        let output = Command::new("cargo")
            .args(["generate-lockfile", "--offline", "--manifest-path"])
            .arg(self.root.join("Cargo.toml"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn package(&self) {
        self.write("Cargo.toml", &format!("[package]\nname = \"named-fields-fixture-{}\"\nversion = \"0.0.0\"\nedition = \"2024\"\n", NEXT.fetch_add(1, Ordering::Relaxed)));
        self.lock();
    }
}

fn names(report: &Report) -> Vec<&str> {
    report
        .issues
        .keys()
        .map(|finding| finding.name.as_str())
        .collect()
}

#[test]
fn checks_compiled_nested_local_generic_and_test_declarations() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "#![allow(dead_code)]\npub(crate) struct Plain(pub u8);\nmod nested { pub struct Generic<'a, T>(&'a T) where T: Sized; }\nfn helper() { struct Local(u16); }\n#[cfg(test)] mod tests { struct TestOnly(u32); }\n");
    fixture.write("build.rs", "fn main() { struct BuildOnly(u8); }");
    fixture.write("tests/integration.rs", "struct Integration(u8);");
    fixture.write("examples/demo.rs", "struct Example(u8); fn main() {}");
    fixture.write("benches/speed.rs", "struct Benchmark(u8); fn main() {}");
    fixture.package();
    let report = runner::check(&fixture.options()).unwrap();
    let actual = names(&report)
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        actual,
        [
            "Plain",
            "Generic",
            "Local",
            "TestOnly",
            "BuildOnly",
            "Integration",
            "Example",
            "Benchmark"
        ]
        .into_iter()
        .collect()
    );
    let plain = report
        .issues
        .keys()
        .find(|finding| finding.name == "Plain")
        .unwrap();
    assert_eq!(plain.site.line, 2);
    assert_eq!(plain.site.column, 19);
    assert!(plain.site.path.ends_with("/src/lib.rs"));
}

#[test]
fn accepts_compiled_named_fields_markers_tuple_variants_and_literals() {
    let fixture = Fixture::new();
    fixture.write(
        "src/lib.rs",
        r###"#![allow(dead_code)]
struct Wrapper<T> { value: T }
struct Marker;
struct Empty {}
struct EmptyTuple();
struct Pair(pub u8, pub u8);
enum Event { Value(u8), Pair(u8, u16) }
// struct Comment(u8);
/* struct BlockComment(u8); */
const TEXT: &str = "struct StringLiteral(u8);";
const RAW: &str = r#"struct RawString(u8);"#;
fn external_api() { let _ = std::num::Wrapping(1).0; }
"###,
    );
    fixture.package();
    assert!(runner::check(&fixture.options()).unwrap().issues.is_empty());
}

#[test]
fn excludes_disabled_declarations_and_unloaded_files() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "#[cfg(any())] struct Disabled(u8);\n#[cfg(any())] mod inactive;\npub struct Named { pub value: u8 }\n");
    for path in [
        "src/inactive.rs",
        "src/unregistered.rs",
        "tools/check-named-fields/src/unregistered.rs",
        "assets/example.rs",
        "vendor/example.rs",
    ] {
        fixture.write(path, "struct Broken(");
    }
    fixture.package();
    assert!(runner::check(&fixture.options()).unwrap().issues.is_empty());
    fixture.write("src/lib.rs", "mod unregistered;\n");
    fixture.write(
        "src/unregistered.rs",
        "#![allow(dead_code)]\npub struct Registered(pub u8);\n",
    );
    let report = runner::check(&fixture.options()).unwrap();
    assert_eq!(names(&report), ["Registered"]);
}

fn macro_fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let fixture = Fixture::new();
        fixture.write("Cargo.toml", r#"[package]
name = "named-fields-macros-fixture"
version = "0.0.0"
edition = "2024"
[dependencies]
external-macros = { path = "macros" }
[features]
extra = []
[[example]]
name = "gated"
required-features = ["extra"]
[[bench]]
name = "speed"
harness = false
"#);
        fixture.write("macros/Cargo.toml", "[package]\nname = \"external-macros\"\nversion = \"0.0.0\"\nedition = \"2024\"\n[lib]\nproc-macro = true\n");
        fixture.write("macros/src/lib.rs", r#"extern crate proc_macro;
use proc_macro::TokenStream;
#[allow(dead_code)] struct DependencyInternal(u8);
#[proc_macro] pub fn make_tuple(_: TokenStream) -> TokenStream { "pub struct FromProc(pub u8);".parse().unwrap() }
#[proc_macro_attribute] pub fn to_tuple(_: TokenStream, _: TokenStream) -> TokenStream { "pub struct Changed(pub u8);".parse().unwrap() }
#[proc_macro_attribute] pub fn to_named(_: TokenStream, _: TokenStream) -> TokenStream { "pub struct Rewritten { pub value: u8 }".parse().unwrap() }
#[proc_macro_attribute] pub fn erase(_: TokenStream, _: TokenStream) -> TokenStream { TokenStream::new() }
#[proc_macro_derive(Generate)] pub fn generate(_: TokenStream) -> TokenStream { "pub struct DerivedHelper(pub u8);".parse().unwrap() }
"#);
        fixture.write("src/lib.rs", r#"#![allow(dead_code, unused_imports)]
use external_macros::{make_tuple, to_tuple, to_named, erase, Generate};
pub struct Direct(pub u8);
#[cfg(any())] struct Disabled(u8);
macro_rules! wrap { ($name:ident) => { pub struct $name(pub u8); }; }
macro_rules! relay { ($name:ident) => { wrap!($name); }; }
wrap!(FromDeclaration);
relay!(Nested);
#[cfg(test)] wrap!(TestOnly);
#[cfg(feature = "extra")] wrap!(FeatureOnly);
make_tuple!();
#[to_tuple] pub struct Changed { value: u8 }
#[to_named] pub struct Rewritten(pub u8);
#[erase] pub struct Erased(pub u8);
#[derive(Generate)] pub struct Derived;
pub struct ConfigPair(pub u8, #[cfg(not(feature = "extra"))] pub u8);
mod first { wrap!(Repeated); }
mod second { wrap!(Repeated); }
#[allow(warnings)] mod allowed { wrap!(Allowed); }
"#);
        fixture.write("build.rs", "#![allow(dead_code)]\nmacro_rules! build { () => { struct BuildGenerated(u8); }; }\nbuild!();\nfn main() {}\n");
        fixture.write("tests/integration.rs", "#![allow(dead_code)]\nmacro_rules! make { () => { struct IntegrationGenerated(u8); }; }\nmake!();\n");
        fixture.write("examples/demo.rs", "#![allow(dead_code)]\nmacro_rules! make { () => { struct ExampleGenerated(u8); }; }\nmake!();\nfn main() {}\n");
        fixture.write("examples/gated.rs", "#![allow(dead_code)]\nmacro_rules! make { () => { struct GatedGenerated(u8); }; }\nmake!();\nfn main() {}\n");
        fixture.write("benches/speed.rs", "#![allow(dead_code)]\nmacro_rules! make { () => { struct BenchGenerated(u8); }; }\nmake!();\nfn main() {}\n");
        fixture.write("src/unregistered.rs", "struct Unregistered(u8);\n");
        fixture.lock();
        fixture
    })
}

#[test]
fn expanded_pass_covers_all_targets_and_external_macro_products() {
    let fixture = macro_fixture();
    let report = runner::check(&fixture.options()).unwrap();
    let found = names(&report);
    for name in [
        "Direct",
        "FromDeclaration",
        "Nested",
        "TestOnly",
        "FromProc",
        "Changed",
        "DerivedHelper",
        "Allowed",
        "BuildGenerated",
        "IntegrationGenerated",
        "ExampleGenerated",
        "BenchGenerated",
    ] {
        assert!(found.contains(&name), "Missed {name}: {found:?}");
    }
    for name in [
        "DependencyInternal",
        "Disabled",
        "Unregistered",
        "Rewritten",
        "Erased",
        "FeatureOnly",
        "GatedGenerated",
        "ConfigPair",
    ] {
        assert!(!found.contains(&name), "Unexpected {name}: {found:?}");
    }
    let direct = report
        .issues
        .iter()
        .filter(|(finding, _)| finding.name == "Direct")
        .collect::<Vec<_>>();
    assert_eq!(
        direct.len(),
        1,
        "The same declaration must merge across compilation targets"
    );
    assert!(direct[0].1.iter().any(|target| target.contains("[test]")));
    assert_eq!(direct[0].1.len(), 2);
    assert_eq!(
        found.iter().filter(|&&name| name == "Repeated").count(),
        2,
        "Distinct macro calls must remain separate"
    );
    for name in [
        "FromDeclaration",
        "Nested",
        "FromProc",
        "Changed",
        "DerivedHelper",
    ] {
        let finding = report
            .issues
            .keys()
            .find(|finding| finding.name == name)
            .unwrap();
        assert!(
            !finding.expansions.is_empty(),
            "Missing expansion origin for {name}: {finding:?}"
        );
        assert!(finding.site.path.ends_with("/src/lib.rs"));
    }
    let nested = report
        .issues
        .keys()
        .find(|finding| finding.name == "Nested")
        .unwrap();
    assert!(nested.expansions.len() >= 2);
}

#[test]
fn warm_runs_features_and_explicit_host_target_preserve_coverage() {
    let fixture = macro_fixture();
    let original = runner::check(&fixture.options()).unwrap();
    let mut selected = fixture.options();
    selected.features.push("extra".into());
    let selected = runner::check(&selected).unwrap();
    for name in ["FeatureOnly", "GatedGenerated", "ConfigPair"] {
        assert!(names(&selected).contains(&name), "Missing {name}");
    }
    let mut all = fixture.options();
    all.all_features = true;
    assert_eq!(runner::check(&all).unwrap().issues, selected.issues);
    let mut host = fixture.options();
    let version = Command::new("rustc").arg("-vV").output().unwrap();
    host.target = String::from_utf8(version.stdout)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("host: ").map(str::to_owned));
    assert!(host.target.is_some());
    assert_eq!(runner::check(&host).unwrap().issues, original.issues);
}

#[test]
fn cli_returns_zero_one_or_two_and_prints_expansion_locations() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "pub struct Named { pub value: u8 }\n");
    fixture.package();
    for (source, code, message) in [
        ("pub struct Named { pub value: u8 }\n", 0, "0 violations"),
        (
            "macro_rules! wrap { () => { pub struct Generated(u8); }; }\nwrap!();\n",
            1,
            "macro:",
        ),
        ("missing_macro!();\n", 2, "macro"),
        (
            "pub fn type_error() { let _: u8 = \"no\"; }\n",
            2,
            "mismatched types",
        ),
        ("struct Broken(\n", 2, "broken"),
        ("struct Broken(u8)\nfn main() {}\n", 2, "expected `;`"),
    ] {
        fixture.write("src/lib.rs", source);
        let output = Command::new(env!("CARGO_BIN_EXE_check-named-fields"))
            .arg(&fixture.root)
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.code(), Some(code), "{text}");
        assert!(
            text.to_lowercase().contains(message),
            "Missing {message}: {text}"
        );
        if code == 1 {
            assert!(
                text.contains("/src/lib.rs:2:"),
                "Missing invocation location: {text}"
            );
        }
    }
}

#[test]
fn missing_stale_and_wrong_compiler_reports_fail_closed() {
    let fixture = Fixture::new();
    fixture.write("src/lib.rs", "pub fn noop() {}\n");
    fixture.package();
    let source = r#"use std::{env, fs, path::PathBuf, process::{Command, ExitCode}};
fn main() -> ExitCode {
    let args: Vec<_> = env::args().skip(1).collect();
    let mut child = Command::new(__DRIVER__).args(&args).spawn().unwrap();
    let pid = child.id();
    let status = child.wait().unwrap();
    if !status.success() { return ExitCode::from(2); }
    let directory = PathBuf::from(env::var_os("NAMED_FIELDS_REPORTS").unwrap());
    let prefix = format!("{pid}-");
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "json")
            || !path.file_name().unwrap().to_string_lossy().starts_with(&prefix) {
            continue;
        }
        let mode = env::current_exe().unwrap().file_stem().unwrap().to_string_lossy().into_owned();
        if mode.starts_with("missing") { if args.iter().any(|arg| arg == "--test") { fs::remove_file(path).unwrap(); } }
        else { let json = fs::read_to_string(&path).unwrap(); let json = if mode.starts_with("stale") { json.replace("\"run\":\"", "\"run\":\"stale-") } else { json.replace("__COMPILER__", "wrong-compiler") }; fs::write(path, json).unwrap(); }
    }
    ExitCode::SUCCESS
}
"#;
    fixture.write(
        "proxy.rs",
        &source
            .replace(
                "__DRIVER__",
                &serde_json::to_string(env!("CARGO_BIN_EXE_check-named-fields-driver")).unwrap(),
            )
            .replace("__COMPILER__", env!("NAMED_FIELDS_RUSTC")),
    );
    let proxy = fixture
        .root
        .join(format!("proxy{}", std::env::consts::EXE_SUFFIX));
    let output = Command::new("rustc")
        .arg("--edition=2024")
        .arg(fixture.root.join("proxy.rs"))
        .arg("-o")
        .arg(&proxy)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for mode in ["missing", "stale", "wrong"] {
        let driver = fixture
            .root
            .join(format!("{mode}{}", std::env::consts::EXE_SUFFIX));
        fs::copy(&proxy, &driver).unwrap();
        let mut options = fixture.options();
        options.driver = Some(driver);
        let error = runner::check(&options).unwrap_err();
        let text = format!("{error:#}");
        assert!(
            text.contains(if mode == "missing" {
                "compilation reports"
            } else {
                "Stale or incompatible compiler report"
            }),
            "{mode}: {text}"
        );
    }
}

#[test]
fn compiler_abi_mismatch_is_a_tool_error() {
    let fixture = Fixture::new();
    fixture.write(
        "fake.rs",
        "fn main() { println!(\"commit-hash: wrong-compiler\"); }\n",
    );
    let fake = fixture
        .root
        .join(format!("rustc{}", std::env::consts::EXE_SUFFIX));
    let output = Command::new("rustc")
        .arg(fixture.root.join("fake.rs"))
        .arg("-o")
        .arg(fake)
        .output()
        .unwrap();
    assert!(output.status.success());
    let mut path = vec![fixture.root.clone()];
    path.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    let output = Command::new(env!("CARGO_BIN_EXE_check-named-fields"))
        .arg(&fixture.root)
        .env("PATH", std::env::join_paths(path).unwrap())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("rustc ABI"));
}
