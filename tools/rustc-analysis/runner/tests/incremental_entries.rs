//! 通过三个公开入口验证真实 Cargo 冷/热复用；子进程隔离环境输入，夹具只执行专用导出。
use rustc_analysis::{Options, check_entity_names, check_named_fields, extract, normalized};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

static HOST_TEST_LOCK: Mutex<()> = Mutex::new(());
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn host_test_guard() -> MutexGuard<'static, ()> {
    // 锁只负责让独立夹具排队；前一断言失败不能遮蔽后续测试自己的结果。
    HOST_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn driver() -> PathBuf {
    let path = env::var_os("ANALYSIS_TEST_DRIVER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_BIN_EXE_rustc-analysis"))
                .with_file_name(format!("rustc-analysis-driver{}", env::consts::EXE_SUFFIX))
        });
    assert!(
        path.is_file(),
        "Set ANALYSIS_TEST_DRIVER to the built analysis driver: {}",
        path.display()
    );
    path.canonicalize().unwrap()
}

struct Fixture {
    root: PathBuf,
    package: String,
}

struct Run {
    result: Value,
    summary: Value,
    directory: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let serial = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let package = format!("incremental_{label}_{}_{}", std::process::id(), serial);
        let root = repository().join("tmp/ra/tests/entries").join(format!(
            "{package}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("dependency/src")).unwrap();
        fs::write(root.join("Cargo.toml"), format!(
            "[package]\nname = {package:?}\nversion = \"0.1.0\"\nedition = \"2024\"\n[workspace]\nmembers = [\"dependency\"]\nresolver = \"3\"\n[features]\ndebugdump = []\nselected = []\n[dependencies]\nfixture_dependency = {{ path = \"dependency\" }}\n"
        )).unwrap();
        fs::write(
            root.join("dependency/Cargo.toml"),
            "[package]\nname = \"fixture_dependency\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::write(
            root.join("dependency/src/lib.rs"),
            "pub const VALUE: usize = 4;\n",
        )
        .unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "pub fn library_value() -> usize { fixture_dependency::VALUE }\n",
        )
        .unwrap();
        fs::write(root.join("Cargo.lock"), format!(
            "version = 4\n\n[[package]]\nname = {package:?}\nversion = \"0.1.0\"\ndependencies = [\"fixture_dependency\"]\n\n[[package]]\nname = \"fixture_dependency\"\nversion = \"0.1.0\"\n"
        )).unwrap();
        fs::write(root.join("seed.txt"), "7").unwrap();
        fs::write(root.join("src/input.txt"), "included input").unwrap();
        fs::write(root.join("build.rs"), r#"fn main() {
    println!("cargo:rerun-if-changed=seed.txt");
    println!("cargo:rerun-if-env-changed=ANALYSIS_FIXTURE_BUILD");
    let seed: usize = std::fs::read_to_string("seed.txt").unwrap().parse().unwrap();
    let extra: usize = std::env::var("ANALYSIS_FIXTURE_BUILD").unwrap().parse().unwrap();
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("generated.rs");
    std::fs::write(output, format!("pub const GENERATED: usize = {};\n", seed + extra)).unwrap();
}
"#).unwrap();
        let fixture = Self {
            root: root.canonicalize().unwrap(),
            package,
        };
        fixture.source(1, false);
        fixture
    }

    fn source(&self, value: usize, negative: bool) {
        let source = r#"#![allow(dead_code)]
mod generated { include!(concat!(env!("OUT_DIR"), "/generated.rs")); }
const TEXT: &str = include_str!("input.txt");
__NEGATIVE__
pub fn value() -> usize {
    fixture_dependency::VALUE + generated::GENERATED + TEXT.len()
        + option_env!("ANALYSIS_FIXTURE_VALUE").map(str::len).unwrap_or(0) + __VALUE__
}
fn main() {
    let mut args = std::env::args().skip(1);
    assert_eq!(args.next().as_deref(), Some("--dump-schedules"), "Only the dedicated test export may execute");
    assert!(cfg!(feature = "debugdump"));
    let output = std::path::PathBuf::from(args.next().unwrap());
    std::fs::create_dir_all(&output).unwrap();
    let fingerprint = format!("fixture-{}", value());
    std::fs::write(output.join("manifest.json"), format!("{{\"schemaVersion\":1,\"sourceFingerprint\":\"{}\",\"schedules\":[]}}", fingerprint)).unwrap();
    std::fs::write(output.join("runtime.json"), format!("{{\"schemaVersion\":1,\"sourceFingerprint\":\"{}\",\"target\":\"fixture\",\"features\":[\"debugdump\"],\"schedules\":[]}}", fingerprint)).unwrap();
}
"#.replace("__VALUE__", &value.to_string()).replace("__NEGATIVE__", if negative { "pub struct NeedsNamedField(pub usize);" } else { "" });
        fs::write(self.root.join("src/main.rs"), source).unwrap();
    }

    fn nested_tool_workspace(&self) -> [String; 3] {
        let root = self.root.join("tools/rustc-analysis");
        let contract = format!("{}_contract", self.package);
        let compiler = format!("{}_compiler", self.package);
        let runner = format!("{}_runner", self.package);
        for (directory, package, dependencies, source) in [
            (
                "contract",
                &contract,
                String::new(),
                "pub const VALUE: usize = 1;\n",
            ),
            (
                "compiler",
                &compiler,
                format!(
                    "[dependencies]\nfixture_contract = {{ package = {contract:?}, path = \"../contract\" }}\n"
                ),
                "pub fn compiler_value() -> usize { fixture_contract::VALUE }\n",
            ),
            (
                "runner",
                &runner,
                format!(
                    "[dependencies]\nfixture_contract = {{ package = {contract:?}, path = \"../contract\" }}\nfixture_compiler = {{ package = {compiler:?}, path = \"../compiler\" }}\n"
                ),
                "pub fn runner_value() -> usize { fixture_compiler::compiler_value() + fixture_contract::VALUE }\n",
            ),
        ] {
            let member = root.join(directory);
            fs::create_dir_all(member.join("src")).unwrap();
            fs::write(member.join("Cargo.toml"), format!("[package]\nname = {package:?}\nversion = \"0.1.0\"\nedition = \"2024\"\nbuild = \"../shared-build.rs\"\n{dependencies}")).unwrap();
            fs::write(member.join("src/lib.rs"), source).unwrap();
        }
        fs::write(root.join("shared-build.rs"), "fn main() {}\n").unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers = [\"contract\", \"compiler\", \"runner\"]\nresolver = \"3\"\n",
        )
        .unwrap();
        fs::write(root.join("Cargo.lock"), format!("version = 4\n\n[[package]]\nname = {compiler:?}\nversion = \"0.1.0\"\ndependencies = [{contract:?}]\n\n[[package]]\nname = {contract:?}\nversion = \"0.1.0\"\n\n[[package]]\nname = {runner:?}\nversion = \"0.1.0\"\ndependencies = [{compiler:?}, {contract:?}]\n")).unwrap();
        [contract, compiler, runner]
    }

    fn nested_tool_workspace_with_compiler_dev_dependency(&self) -> [String; 3] {
        let members = self.nested_tool_workspace();
        let [contract, compiler, runner] = &members;
        let root = self.root.join("tools/rustc-analysis");
        fs::write(root.join("compiler/Cargo.toml"), format!(
            "[package]\nname = {compiler:?}\nversion = \"0.1.0\"\nedition = \"2024\"\nbuild = \"../shared-build.rs\"\n[dependencies]\nfixture_contract = {{ package = {contract:?}, path = \"../contract\" }}\n[dev-dependencies]\nfixture_runner = {{ package = {runner:?}, path = \"../runner\" }}\n"
        )).unwrap();
        fs::write(root.join("compiler/src/lib.rs"), "pub fn compiler_value() -> usize { fixture_contract::VALUE }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn runner_is_available_to_compiler_tests() { assert_eq!(fixture_runner::runner_value(), super::compiler_value()); }\n}\n").unwrap();
        fs::write(root.join("runner/Cargo.toml"), format!(
            "[package]\nname = {runner:?}\nversion = \"0.1.0\"\nedition = \"2024\"\nbuild = \"../shared-build.rs\"\n[dependencies]\nfixture_contract = {{ package = {contract:?}, path = \"../contract\" }}\n"
        )).unwrap();
        fs::write(
            root.join("runner/src/lib.rs"),
            "pub fn runner_value() -> usize { fixture_contract::VALUE }\n",
        )
        .unwrap();
        fs::write(root.join("Cargo.lock"), format!("version = 4\n\n[[package]]\nname = {compiler:?}\nversion = \"0.1.0\"\ndependencies = [{contract:?}, {runner:?}]\n\n[[package]]\nname = {contract:?}\nversion = \"0.1.0\"\n\n[[package]]\nname = {runner:?}\nversion = \"0.1.0\"\ndependencies = [{contract:?}]\n")).unwrap();
        members
    }

    fn nested_tool_workspace_with_default_optional_dependency(&self) -> [String; 3] {
        let members = self.nested_tool_workspace_with_compiler_dev_dependency();
        let [contract, compiler, runner] = &members;
        let root = self.root.join("tools/rustc-analysis");
        fs::write(root.join("compiler/Cargo.toml"), format!(
            "[package]\nname = {compiler:?}\nversion = \"0.1.0\"\nedition = \"2024\"\nbuild = \"../shared-build.rs\"\n[features]\ndefault = [\"runner-support\"]\nrunner-support = [\"dep:fixture_runner\"]\n[dependencies]\nfixture_contract = {{ package = {contract:?}, path = \"../contract\" }}\nfixture_runner = {{ package = {runner:?}, path = \"../runner\", optional = true }}\n"
        )).unwrap();
        fs::write(root.join("compiler/src/lib.rs"), "#[cfg(feature = \"runner-support\")]\npub fn compiler_value() -> usize { fixture_runner::runner_value() + fixture_contract::VALUE }\n#[cfg(not(feature = \"runner-support\"))]\npub fn compiler_value() -> usize { fixture_contract::VALUE }\n").unwrap();
        members
    }

    fn set_environment_config(&self, value: &str, force: bool) {
        let directory = self.root.join(".cargo");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("config.toml"),
            format!("[env]\nANALYSIS_FIXTURE_VALUE = {{ value = {value:?}, force = {force} }}\n"),
        )
        .unwrap();
    }

    fn summaries(&self) -> BTreeSet<PathBuf> {
        package_summaries(&self.package)
    }

    fn run(&self, rule: &str, step: &str, environment: &str, build: &str) -> Run {
        self.run_configured(rule, step, environment, build, &[], None)
    }

    fn run_configured(
        &self,
        rule: &str,
        step: &str,
        environment: &str,
        build: &str,
        features: &[&str],
        opt_level: Option<&str>,
    ) -> Run {
        let before = self.summaries();
        let output = self.root.join(format!("{step}-result.json"));
        let child = self.invoke_configured(rule, step, environment, build, features, opt_level);
        assert!(
            child.status.success(),
            "{rule}/{step}:\n{}\n{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        let mut run = new_package_run(&self.package, &before);
        run.result = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        run
    }

    fn invoke(
        &self,
        rule: &str,
        step: &str,
        environment: &str,
        build: &str,
    ) -> std::process::Output {
        self.invoke_configured(rule, step, environment, build, &[], None)
    }

    fn invoke_configured(
        &self,
        rule: &str,
        step: &str,
        environment: &str,
        build: &str,
        features: &[&str],
        opt_level: Option<&str>,
    ) -> std::process::Output {
        let output = self.root.join(format!("{step}-result.json"));
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args(["--exact", "public_entry_child", "--nocapture"])
            .env("ANALYSIS_ENTRY_CHILD", rule)
            .env("ANALYSIS_ENTRY_ROOT", &self.root)
            .env("ANALYSIS_ENTRY_RESULT", &output)
            .env("ANALYSIS_TEST_DRIVER", driver())
            .env("ANALYSIS_FIXTURE_VALUE", environment)
            .env("ANALYSIS_FIXTURE_BUILD", build)
            .env("ANALYSIS_ENTRY_FEATURES", features.join(","));
        if let Some(opt_level) = opt_level {
            command.env("CARGO_PROFILE_DEV_OPT_LEVEL", opt_level);
        }
        if let Some(suffix) = step.strip_prefix("parent-cargo-env-") {
            command
                .env(
                    "CARGO_TARGET_DIR",
                    self.root.join(format!("ignored-target-{suffix}")),
                )
                .env(
                    "CARGO_BUILD_BUILD_DIR",
                    self.root.join(format!("ignored-build-{suffix}")),
                )
                .env(
                    "CARGO_BUILD_TARGET",
                    format!("ignored-parent-target-{suffix}"),
                );
        }
        #[cfg(windows)]
        if step.starts_with("windows-case-") {
            command.env("ANALYSIS_FIXTURE_CASE", "uppercase-parent-value");
        }
        if step.starts_with("driver-copy-") {
            command.env(
                "ANALYSIS_TEST_DRIVER",
                self.root
                    .join("driver-copy")
                    .join(format!("rustc-analysis-driver{}", env::consts::EXE_SUFFIX)),
            );
        }
        command.output().unwrap()
    }

    fn run_cli_negative(&self) -> Run {
        self.run_cli_check(&self.root, &self.package, 1)
    }

    fn run_cli_check(&self, root: &Path, package: &str, expected_exit: i32) -> Run {
        let before = package_summaries(package);
        let child = Command::new(env!("CARGO_BIN_EXE_rustc-analysis"))
            .args(["check", "--rule", "named-fields", "--workspace"])
            .arg(root)
            .env("ANALYSIS_FIXTURE_VALUE", "first")
            .env("ANALYSIS_FIXTURE_BUILD", "1")
            .output()
            .unwrap();
        assert_eq!(
            child.status.code(),
            Some(expected_exit),
            "The named-field CLI must preserve its requested scope and result:\n{}\n{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        new_package_run(package, &before)
    }
}

fn package_summaries(package: &str) -> BTreeSet<PathBuf> {
    package_run_files(package, "cache-summary.json")
}

fn package_run_files(package: &str, suffix: &str) -> BTreeSet<PathBuf> {
    let root = repository().join("tmp/ra/r");
    if !root.is_dir() {
        return BTreeSet::new();
    }
    fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path().join(format!("{package}-{suffix}")))
        .filter(|path| path.is_file())
        .collect()
}

fn new_package_run(package: &str, before: &BTreeSet<PathBuf>) -> Run {
    let summaries: Vec<_> = package_summaries(package)
        .difference(before)
        .cloned()
        .collect();
    assert_eq!(
        summaries.len(),
        1,
        "Each entry invocation must publish exactly one summary for {package}"
    );
    Run {
        result: Value::Null,
        summary: serde_json::from_slice(&fs::read(&summaries[0]).unwrap()).unwrap(),
        directory: summaries[0].parent().unwrap().to_path_buf(),
    }
}

fn count(run: &Run, key: &str) -> u64 {
    run.summary[key].as_u64().unwrap()
}

fn hot(run: &Run) {
    assert_eq!(count(run, "compiled"), 0, "{}", run.summary);
    assert!(count(run, "reused") > 0, "{}", run.summary);
    assert_eq!(count(run, "recovered"), 0, "{}", run.summary);
    assert_eq!(count(run, "attempts"), 1, "{}", run.summary);
}

fn changed(run: &Run) {
    assert!(count(run, "compiled") > 0, "{}", run.summary);
    assert_eq!(count(run, "recovered"), 0, "{}", run.summary);
    assert_eq!(count(run, "attempts"), 1, "{}", run.summary);
}

fn dependency_was_fresh(run: &Run, fixture: &Fixture) {
    let bytes = fs::read_to_string(
        run.directory
            .join(format!("{}-0.stdout.jsonl", fixture.package)),
    )
    .unwrap();
    let artifacts: Vec<Value> = bytes
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|value: &Value| {
            value["reason"] == "compiler-artifact"
                && value["target"]["name"] == "fixture_dependency"
        })
        .collect();
    assert!(!artifacts.is_empty());
    assert!(artifacts.iter().all(|artifact| artifact["fresh"] == true));
}

fn dependency_units_have_passive_inputs(run: &Run, fixture: &Fixture) {
    let messages = fs::read_to_string(
        run.directory
            .join(format!("{}-0.stdout.jsonl", fixture.package)),
    )
    .unwrap();
    let artifacts: Vec<Value> = messages
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|value: &Value| value["reason"] == "compiler-artifact")
        .collect();
    let root_source = normalized(&fixture.root.join("src/main.rs")).unwrap();
    let root_package = artifacts
        .iter()
        .find(|artifact| {
            normalized(Path::new(artifact["target"]["src_path"].as_str().unwrap())).unwrap()
                == root_source
        })
        .unwrap()["package_id"]
        .as_str()
        .unwrap();
    let dependencies: Vec<_> = artifacts
        .iter()
        .filter(|artifact| artifact["package_id"] != root_package)
        .collect();
    assert!(!dependencies.is_empty());
    let reports: Vec<Value> = fs::read_dir(run.directory.join(&fixture.package))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap())
        .collect();
    for artifact in dependencies {
        let source =
            normalized(Path::new(artifact["target"]["src_path"].as_str().unwrap())).unwrap();
        let matching: Vec<_> = reports
            .iter()
            .filter(|report| {
                report["target"]["source"] == source
                    && report["target"]["test"] == artifact["profile"]["test"]
            })
            .collect();
        assert_eq!(
            matching.len(),
            1,
            "Every actual dependency unit must have a unique input report"
        );
        let report = matching[0];
        assert_eq!(report["analyzed"], false);
        assert_eq!(report["inputs"]["complete"], true);
        assert!(report["findings"].as_array().unwrap().is_empty());
        assert!(
            report["entities"]["entities"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            report["entities"]["diagnostics"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(report["facts"].is_null());
    }
}

fn native_incremental_was_enabled(run: &Run, fixture: &Fixture, architecture: bool) {
    let root = normalized(&fixture.root).unwrap();
    let dependency = normalized(&fixture.root.join("dependency")).unwrap();
    let mut root_reports = 0;
    let mut dependency_reports = 0;
    for entry in fs::read_dir(run.directory.join(&fixture.package)).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let report: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        if report["manifest_dir"] == root {
            root_reports += 1;
            assert_eq!(
                report["inputs"]["incremental"], true,
                "Root rustc invocation must enable incremental compilation"
            );
        } else if architecture && report["manifest_dir"] == dependency {
            dependency_reports += 1;
            assert_eq!(
                report["inputs"]["incremental"], true,
                "Path dependency rustc invocation must enable incremental compilation"
            );
        }
    }
    assert!(root_reports > 0);
    if architecture {
        assert!(dependency_reports > 0);
    }
}

fn compiler_environment_matches(run: &Run, fixture: &Fixture, name: &str, expected: &str) {
    let expected = format!("{:x}", Sha256::digest(expected.as_bytes()));
    let mut observed = false;
    for entry in fs::read_dir(run.directory.join(&fixture.package)).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let report: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        for input in report["inputs"]["env"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|input| input["name"] == name)
        {
            observed = true;
            assert_eq!(
                input["value_sha256"], expected,
                "The compiler must observe the effective value of {name}"
            );
        }
    }
    assert!(observed, "The compiler must actually track {name}");
}

fn root_report_cache_paths(run: &Run, fixture: &Fixture) -> (PathBuf, PathBuf) {
    let cache_root = repository().join("tmp/ra/v2");
    let cache = cache_root
        .join(run.summary["configuration"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    assert!(cache.starts_with(cache_root.canonicalize().unwrap()));
    let source = normalized(&fixture.root.join("src/main.rs")).unwrap();
    let mut selected = vec![];
    for entry in fs::read_dir(cache.join("units")).unwrap() {
        let index = entry.unwrap().path();
        let record: Value = serde_json::from_slice(&fs::read(&index).unwrap()).unwrap();
        let report_path = cache
            .join("reports")
            .join(format!("{}.json", record["reportSha256"].as_str().unwrap()));
        let report: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
        if report["target"]["source"] == source && report["target"]["test"] == false {
            selected.push((index, report_path));
        }
    }
    assert_eq!(
        selected.len(),
        1,
        "Only this fixture's normal binary cache index may be removed"
    );
    selected.pop().unwrap()
}

fn dependency_cached_reports(run: &Run, fixture: &Fixture) -> Vec<(PathBuf, Vec<u8>)> {
    let cache = repository()
        .join("tmp/ra/v2")
        .join(run.summary["configuration"].as_str().unwrap());
    let manifest = normalized(&fixture.root.join("dependency")).unwrap();
    let mut reports = vec![];
    for entry in fs::read_dir(cache.join("units")).unwrap() {
        let index: Value =
            serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
        let path = cache
            .join("reports")
            .join(format!("{}.json", index["reportSha256"].as_str().unwrap()));
        let bytes = fs::read(&path).unwrap();
        let report: Value = serde_json::from_slice(&bytes).unwrap();
        if report["manifest_dir"] == manifest {
            reports.push((path, bytes));
        }
    }
    assert!(!reports.is_empty());
    reports
}

fn file_snapshot(directory: &Path) -> BTreeMap<PathBuf, String> {
    fn collect(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, String>) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect(root, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    format!("{:x}", Sha256::digest(fs::read(&path).unwrap())),
                );
            }
        }
    }
    let mut files = BTreeMap::new();
    collect(directory, directory, &mut files);
    files
}

fn failed_architecture_build_preserves_valid_cache_and_published_outputs(
    fixture: &Fixture,
    baseline: &Run,
) {
    let cache_root = repository().join("tmp/ra/v2").canonicalize().unwrap();
    let configuration = baseline.summary["configuration"].as_str().unwrap();
    let cache = cache_root.join(configuration).canonicalize().unwrap();
    assert!(cache.starts_with(&cache_root));
    let manifests = BTreeSet::from([
        normalized(&fixture.root).unwrap(),
        normalized(&fixture.root.join("dependency")).unwrap(),
    ]);
    let mut observed_manifests = BTreeSet::new();
    let mut indices = 0;
    for entry in fs::read_dir(cache.join("units")).unwrap() {
        let index: Value =
            serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
        assert_eq!(index["configuration"], configuration);
        let report_hash = index["reportSha256"].as_str().unwrap();
        let bytes = fs::read(cache.join("reports").join(format!("{report_hash}.json"))).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), report_hash);
        let report: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(report["configuration"], configuration);
        assert_eq!(report["compiler"], env!("ANALYSIS_COMPILER"));
        assert_eq!(report["run"], index["producerRun"]);
        assert_eq!(report["inputs"]["complete"], true);
        assert!(report["failure"].is_null());
        let manifest = report["manifest_dir"].as_str().unwrap().to_owned();
        assert!(manifests.contains(&manifest));
        observed_manifests.insert(manifest);
        indices += 1;
    }
    assert!(indices > 0);
    assert_eq!(observed_manifests, manifests);
    let cached = file_snapshot(&cache);
    let output = fixture.root.join("architecture-output");
    let published = file_snapshot(&output);
    for required in [
        "facts.json",
        "runtime.json",
        "analysis-summary.json",
        "debugdump/manifest.json",
        "debugdump/runtime.json",
    ] {
        assert!(published.contains_key(Path::new(required)));
    }
    let summaries = fixture.summaries();
    let requests = package_run_files(&fixture.package, "request.input");
    let library = fixture.root.join("src/lib.rs");
    let binary = fixture.root.join("src/main.rs");
    let original_library = fs::read(&library).unwrap();
    let original_binary = fs::read(&binary).unwrap();
    let mut changed_library = original_library.clone();
    changed_library.extend_from_slice(b"\npub const COMPILED_BEFORE_FAILURE: usize = 19;\n");
    let mut invalid_binary = original_binary.clone();
    invalid_binary
        .extend_from_slice(b"\ncompile_error!(\"architecture-cache-failure-fixture\");\n");
    fs::write(&library, &changed_library).unwrap();
    fs::write(&binary, invalid_binary).unwrap();
    let failed = fixture.invoke("architecture", "compile-failed", "first", "1");
    fs::write(&library, &original_library).unwrap();
    fs::write(&binary, &original_binary).unwrap();
    assert!(!failed.status.success());
    let diagnostic = String::from_utf8_lossy(&failed.stderr);
    assert!(
        diagnostic.contains("architecture-cache-failure-fixture"),
        "{diagnostic}"
    );
    assert!(!fixture.root.join("compile-failed-result.json").exists());
    assert_eq!(fixture.summaries(), summaries);
    assert_eq!(
        file_snapshot(&cache),
        cached,
        "A failed Cargo build cannot publish reports or replace any valid cache index/blob"
    );
    assert_eq!(
        file_snapshot(&output),
        published,
        "A failed build must preserve the complete facts/runtime/Schedule snapshot"
    );
    let failed_requests = package_run_files(&fixture.package, "request.input");
    let failed_requests = failed_requests.difference(&requests).collect::<Vec<_>>();
    assert_eq!(failed_requests.len(), 1);
    let failed_run = failed_requests[0].parent().unwrap();
    let failed_request: Value =
        serde_json::from_slice(&fs::read(failed_requests[0]).unwrap()).unwrap();
    let source = normalized(&library).unwrap();
    let changed_hash = format!("{:x}", Sha256::digest(&changed_library));
    assert!(
        fs::read_dir(failed_run.join(&fixture.package))
            .unwrap()
            .any(|entry| {
                let path = entry.unwrap().path();
                if path.extension().is_none_or(|extension| extension != "json") {
                    return false;
                }
                let report: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                report["target"]["source"] == source
                    && report["run"] == failed_request["run"]
                    && report["analyzed"] == true
                    && report["failure"].is_null()
                    && report["facts"].is_object()
                    && report["inputs"]["complete"] == true
                    && report["inputs"]["files"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|input| input["path"] == source && input["sha256"] == changed_hash)
            }),
        "The failed invocation must actually produce a new valid library report before the binary fails"
    );
    let restored = fixture.run("architecture", "compile-restored", "first", "1");
    assert_eq!(restored.result, baseline.result);
    assert_eq!(
        restored.summary["configuration"],
        baseline.summary["configuration"]
    );
    assert_eq!(count(&restored, "recovered"), 0);
    assert_eq!(count(&restored, "attempts"), 1);
    assert_eq!(fs::read(&library).unwrap(), original_library);
    assert_eq!(fs::read(&binary).unwrap(), original_binary);
    let stable = fixture.run("architecture", "compile-restored-hot", "first", "1");
    hot(&stable);
    assert_eq!(stable.result, baseline.result);
    let restored_outputs = file_snapshot(&output);
    for path in [
        "runtime.json",
        "debugdump/manifest.json",
        "debugdump/runtime.json",
    ] {
        assert_eq!(
            restored_outputs[Path::new(path)],
            published[Path::new(path)]
        );
    }
}

#[test]
fn public_entry_child() {
    let Some(rule) = env::var_os("ANALYSIS_ENTRY_CHILD") else {
        return;
    };
    let root = PathBuf::from(env::var_os("ANALYSIS_ENTRY_ROOT").unwrap());
    let mut options = Options::new(root.clone());
    options.driver = Some(driver());
    options.features = env::var("ANALYSIS_ENTRY_FEATURES")
        .unwrap_or_default()
        .split(',')
        .filter(|feature| !feature.is_empty())
        .map(str::to_owned)
        .collect();
    let result = match rule.to_str().unwrap() {
        "named-fields" => {
            let report = check_named_fields(&options).unwrap();
            json!({"issues": report.issues.into_iter().map(|(finding, targets)| json!({"finding":finding,"targets":targets})).collect::<Vec<_>>()})
        }
        "entity-names" => {
            let report = check_entity_names(&options).unwrap();
            json!({"diagnostics":report.diagnostics,"entities":report.entities})
        }
        "architecture" => {
            let output = root.join("architecture-output");
            extract(&options, &output).unwrap();
            let facts: Value =
                serde_json::from_slice(&fs::read(output.join("facts.json")).unwrap()).unwrap();
            json!({"units":facts["units"].as_array().unwrap().len()})
        }
        other => panic!("Unexpected test rule: {other}"),
    };
    fs::write(
        PathBuf::from(env::var_os("ANALYSIS_ENTRY_RESULT").unwrap()),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
}

#[test]
fn all_public_entries_reuse_hot_units_and_recompile_only_changed_root_sources() {
    let _serial = host_test_guard();
    for rule in ["named-fields", "entity-names", "architecture"] {
        let fixture = Fixture::new(&rule.replace('-', "_"));
        let cold = fixture.run(rule, "cold", "first", "1");
        changed(&cold);
        native_incremental_was_enabled(&cold, &fixture, rule == "architecture");
        let warm = fixture.run(rule, "warm", "first", "1");
        hot(&warm);
        assert_eq!(cold.result, warm.result);
        if rule == "named-fields" {
            let reports = cold.directory.join(&fixture.package);
            let harnesses: BTreeSet<_> = fs::read_dir(reports)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                })
                .map(|path| serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap())
                .filter(|report| report["manifest_dir"] == normalized(&fixture.root).unwrap())
                .map(|report| {
                    (
                        report["target"]["source"].as_str().unwrap().to_owned(),
                        report["target"]["test"].as_bool().unwrap(),
                    )
                })
                .collect();
            assert_eq!(
                harnesses,
                ["src/lib.rs", "src/main.rs"]
                    .into_iter()
                    .flat_map(|source| {
                        let source = normalized(&fixture.root.join(source)).unwrap();
                        [false, true].map(|harness| (source.clone(), harness))
                    })
                    .chain(std::iter::once((
                        normalized(&fixture.root.join("build.rs")).unwrap(),
                        false
                    )))
                    .collect()
            );
        }
        fixture.source(2, false);
        let modified = fixture.run(rule, "source-changed", "first", "1");
        changed(&modified);
        dependency_was_fresh(&modified, &fixture);
        let source_hot = fixture.run(rule, "source-hot", "first", "1");
        hot(&source_hot);
        if rule == "architecture" {
            failed_architecture_build_preserves_valid_cache_and_published_outputs(
                &fixture,
                &source_hot,
            );
            let lock_path = fixture.root.join("Cargo.lock");
            let lock_bytes = fs::read(&lock_path).unwrap();
            fs::remove_file(root_report_cache_paths(&source_hot, &fixture).0).unwrap();
            let recovered = fixture.run(rule, "missing-root-report", "first", "1");
            assert_eq!(
                fs::read(&lock_path).unwrap(),
                lock_bytes,
                "Recovering a missing report must preserve Cargo.lock bytes"
            );
            assert_eq!(count(&recovered, "recovered"), 1, "{}", recovered.summary);
            assert_eq!(count(&recovered, "attempts"), 2, "{}", recovered.summary);
            assert!(count(&recovered, "compiled") > 0);
            assert!(count(&recovered, "reused") > 0);
            let recovered_hot = fixture.run(rule, "recovered-hot", "first", "1");
            hot(&recovered_hot);
            assert_eq!(fs::read(&lock_path).unwrap(), lock_bytes);
            let dependency_reports = dependency_cached_reports(&recovered_hot, &fixture);
            fs::write(
                root_report_cache_paths(&recovered_hot, &fixture).1,
                b"corrupt only this fixture's normal binary report",
            )
            .unwrap();
            let repaired = fixture.run(rule, "corrupt-root-report", "first", "1");
            assert_eq!(
                fs::read(&lock_path).unwrap(),
                lock_bytes,
                "Recovering a damaged report must preserve Cargo.lock bytes"
            );
            assert_eq!(count(&repaired, "recovered"), 1, "{}", repaired.summary);
            assert_eq!(count(&repaired, "attempts"), 2, "{}", repaired.summary);
            assert!(count(&repaired, "compiled") > 0);
            assert!(count(&repaired, "reused") > 0);
            dependency_was_fresh(&repaired, &fixture);
            for (path, bytes) in dependency_reports {
                assert_eq!(fs::read(path).unwrap(), bytes);
            }
            hot(&fixture.run(rule, "repaired-hot", "first", "1"));
            assert_eq!(fs::read(&lock_path).unwrap(), lock_bytes);
        }
    }
}

#[test]
fn architecture_binds_equal_parent_units_by_distinct_native_dependency_closures() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("dependency_proof_classes");
    fs::create_dir_all(fixture.root.join("leaf/src")).unwrap();
    fs::create_dir_all(fixture.root.join("sibling/src")).unwrap();
    fs::write(fixture.root.join("Cargo.toml"), format!(
        "[package]\nname = {:?}\nversion = \"0.1.0\"\nedition = \"2024\"\n[workspace]\nmembers = [\"dependency\", \"leaf\", \"sibling\"]\nresolver = \"3\"\n[features]\ndebugdump = []\n[dependencies]\nfixture_dependency = {{ path = \"dependency\" }}\nfixture_leaf = {{ path = \"leaf\", default-features = false, features = [\"extra\"] }}\nfixture_sibling = {{ path = \"sibling\" }}\n[build-dependencies]\nfixture_dependency = {{ path = \"dependency\" }}\n[profile.dev]\ndebug = 0\n",
        fixture.package
    )).unwrap();
    fs::write(
        fixture.root.join("dependency/Cargo.toml"),
        "[package]\nname = \"fixture_dependency\"\nversion = \"0.1.0\"\nedition = \"2024\"\n[dependencies]\nfixture_leaf = { path = \"../leaf\", default-features = false }\n",
    ).unwrap();
    fs::write(
        fixture.root.join("dependency/src/lib.rs"),
        "pub const VALUE: usize = fixture_leaf::VALUE;\n",
    )
    .unwrap();
    fs::write(
        fixture.root.join("leaf/Cargo.toml"),
        "[package]\nname = \"fixture_leaf\"\nversion = \"0.1.0\"\nedition = \"2024\"\n[features]\nextra = []\n",
    ).unwrap();
    fs::write(
        fixture.root.join("leaf/src/lib.rs"),
        "#[cfg(feature = \"extra\")]\npub const VALUE: usize = 8;\n#[cfg(not(feature = \"extra\"))]\npub const VALUE: usize = 4;\n",
    ).unwrap();
    fs::write(
        fixture.root.join("sibling/Cargo.toml"),
        "[package]\nname = \"fixture_sibling\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    fs::write(
        fixture.root.join("sibling/src/lib.rs"),
        "pub const VALUE: usize = 3;\n",
    )
    .unwrap();
    fs::write(fixture.root.join("Cargo.lock"), format!(
        "version = 4\n\n[[package]]\nname = {:?}\nversion = \"0.1.0\"\ndependencies = [\"fixture_dependency\", \"fixture_leaf\", \"fixture_sibling\"]\n\n[[package]]\nname = \"fixture_dependency\"\nversion = \"0.1.0\"\ndependencies = [\"fixture_leaf\"]\n\n[[package]]\nname = \"fixture_leaf\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"fixture_sibling\"\nversion = \"0.1.0\"\n",
        fixture.package
    )).unwrap();
    let build_script = fs::read_to_string(fixture.root.join("build.rs"))
        .unwrap()
        .replacen(
            "fn main() {",
            r#"fn main() {
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    if manifest.join("capture-retained-reports").exists() {
        let captured = manifest.join("retention-before");
        std::fs::create_dir_all(&captured).unwrap();
        let root_package = format!("\"package\":{:?}", env!("CARGO_PKG_NAME"));
        let root_target = format!("\"name\":{:?},\"test\":false", env!("CARGO_PKG_NAME"));
        for report in std::fs::read_dir(std::env::var_os("ANALYSIS_REPORTS").unwrap()).unwrap() {
            let report = report.unwrap().path();
            if report.extension().is_some_and(|extension| extension == "json") {
                let bytes = std::fs::read(&report).unwrap();
                let text = String::from_utf8_lossy(&bytes);
                if text.contains("\"package\":\"fixture_sibling\"")
                    || (text.contains(&root_package) && text.contains(&root_target))
                {
                    std::fs::write(captured.join(report.file_name().unwrap()), bytes).unwrap();
                }
            }
        }
    }
    println!("cargo:rustc-env=ANALYSIS_FIXTURE_PARENT={}", fixture_dependency::VALUE);"#,
            1,
        );
    fs::write(fixture.root.join("build.rs"), build_script).unwrap();
    let source = fixture.root.join("src/main.rs");
    fs::OpenOptions::new().append(true).open(source).unwrap().write_all(
        b"\nconst _: () = assert!(fixture_dependency::VALUE == 8);\nconst _: () = assert!(fixture_leaf::VALUE == 8);\nconst _: usize = fixture_sibling::VALUE;\nconst _: () = assert!(env!(\"ANALYSIS_FIXTURE_PARENT\").as_bytes()[0] == b'4');\n",
    ).unwrap();

    let cold = fixture.run("architecture", "proof-cold", "first", "1");
    changed(&cold);
    compiler_environment_matches(&cold, &fixture, "ANALYSIS_FIXTURE_PARENT", "4");
    let units: Vec<Value> = serde_json::from_slice(
        &fs::read(
            cold.directory
                .join(format!("{}-0.unit-index.json", fixture.package)),
        )
        .unwrap(),
    )
    .unwrap();
    let parent_source = normalized(&fixture.root.join("dependency/src/lib.rs")).unwrap();
    let parents: Vec<_> = units
        .iter()
        .filter(|unit| unit["target"]["source"] == parent_source)
        .collect();
    assert_eq!(
        parents.len(),
        2,
        "Both host and target Parent units must exist"
    );
    // Parent 自身的配置完全相同；绑定只能由实际 extern 指向的不同叶单元证明。
    for field in [
        "package",
        "target",
        "crateTypes",
        "profile",
        "features",
        "mode",
    ] {
        assert!(
            parents.iter().all(|unit| unit[field] == parents[0][field]),
            "{field}: {parents:?}"
        );
    }
    assert!(parents.iter().all(|unit| unit["mode"] == "build"));
    let parent_graphs: BTreeSet<_> = parents
        .iter()
        .map(|unit| unit["graph"].as_str().unwrap())
        .collect();
    assert_eq!(parent_graphs.len(), 2);
    let leaf_source = normalized(&fixture.root.join("leaf/src/lib.rs")).unwrap();
    let leaf_features: BTreeSet<Vec<String>> = units
        .iter()
        .filter(|unit| unit["target"]["source"] == leaf_source)
        .map(|unit| serde_json::from_value(unit["features"].clone()).unwrap())
        .collect();
    assert_eq!(
        leaf_features,
        BTreeSet::from([vec![], vec!["extra".to_owned()]])
    );
    let warm = fixture.run("architecture", "proof-warm", "first", "1");
    hot(&warm);
    assert_eq!(
        count(&warm, "reused"),
        units.len() as u64,
        "{}",
        warm.summary
    );

    let cache = repository()
        .join("tmp/ra/v2")
        .join(warm.summary["configuration"].as_str().unwrap());
    let parent_indexes: Vec<_> = fs::read_dir(cache.join("units"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter_map(|path| {
            let record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (record["proof"]["packageMetadata"]["name"] == "fixture_dependency")
                .then_some((path, record))
        })
        .collect();
    assert_eq!(parent_indexes.len(), 2);
    let indexed_keys: BTreeSet<_> = parent_indexes
        .iter()
        .map(|(_, record)| record["proof"]["unit"].as_str().unwrap())
        .collect();
    assert_eq!(
        indexed_keys,
        parents
            .iter()
            .map(|unit| unit["key"].as_str().unwrap())
            .collect()
    );
    let indexed_graphs: BTreeSet<_> = parent_indexes
        .iter()
        .map(|(_, record)| record["proof"]["graph"].as_str().unwrap())
        .collect();
    assert_eq!(indexed_graphs, parent_graphs);
    let removed = parent_indexes.iter().map(|(path, _)| path).min().unwrap();
    fs::remove_file(removed).unwrap();
    let lock_bytes = fs::read(fixture.root.join("Cargo.lock")).unwrap();
    let repaired = fixture.run("architecture", "proof-missing-parent", "first", "1");
    assert_eq!(count(&repaired, "recovered"), 1, "{}", repaired.summary);
    assert_eq!(count(&repaired, "attempts"), 2, "{}", repaired.summary);
    assert!(count(&repaired, "compiled") > 0);
    assert!(count(&repaired, "reused") > 0);
    assert!(
        removed.is_file(),
        "The precise missing Parent index must be restored"
    );
    assert_eq!(
        fs::read(fixture.root.join("Cargo.lock")).unwrap(),
        lock_bytes
    );
    let repaired_hot = fixture.run("architecture", "proof-repaired-hot", "first", "1");
    hot(&repaired_hot);
    assert_eq!(
        count(&repaired_hot, "reused"),
        units.len() as u64,
        "{}",
        repaired_hot.summary
    );
    assert_eq!(repaired_hot.result, cold.result);

    fs::write(
        fixture.root.join("sibling/src/lib.rs"),
        "pub const VALUE: usize = 5;\n",
    )
    .unwrap();
    fs::write(fixture.root.join("capture-retained-reports"), b"").unwrap();
    fs::remove_file(removed).unwrap();
    let retained = fixture.run("architecture", "proof-retained-sibling", "first", "1");
    assert_eq!(count(&retained, "recovered"), 1, "{}", retained.summary);
    assert_eq!(count(&retained, "attempts"), 2, "{}", retained.summary);
    assert!(count(&retained, "compiled") > 0);
    let sibling_source = normalized(&fixture.root.join("sibling/src/lib.rs")).unwrap();
    let root_sources: BTreeSet<_> = ["src/lib.rs", "src/main.rs"]
        .map(|source| normalized(&fixture.root.join(source)).unwrap())
        .into_iter()
        .collect();
    for (attempt, sibling_fresh, parent_fresh) in [(0, false, true), (1, true, false)] {
        let messages = fs::read_to_string(
            retained
                .directory
                .join(format!("{}-{attempt}.stdout.jsonl", fixture.package,)),
        )
        .unwrap();
        let artifacts: Vec<Value> = messages
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|value: &Value| value["reason"] == "compiler-artifact")
            .collect();
        for (source, expected, expected_count) in [
            (&sibling_source, sibling_fresh, 1),
            (&parent_source, parent_fresh, 2),
        ] {
            let matching: Vec<_> = artifacts
                .iter()
                .filter(|artifact| {
                    normalized(Path::new(artifact["target"]["src_path"].as_str().unwrap())).unwrap()
                        == *source
                })
                .collect();
            assert_eq!(matching.len(), expected_count);
            assert!(
                matching
                    .iter()
                    .all(|artifact| artifact["fresh"] == expected),
                "{matching:?}"
            );
        }
        for source in &root_sources {
            let matching: Vec<_> = artifacts
                .iter()
                .filter(|artifact| {
                    normalized(Path::new(artifact["target"]["src_path"].as_str().unwrap())).unwrap()
                        == *source
                })
                .collect();
            assert_eq!(matching.len(), 1);
            assert_eq!(matching[0]["fresh"], false);
        }
    }
    let read_reports = |directory: &Path| -> Vec<(PathBuf, Vec<u8>, Value)> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .map(|path| {
                let bytes = fs::read(&path).unwrap();
                let report = serde_json::from_slice(&bytes).unwrap();
                (path, bytes, report)
            })
            .collect()
    };
    // Parent 恢复使 build.rs 再执行；它在第二轮 Host 绑定之前冻结第一轮原始报告。
    let captured = read_reports(&fixture.root.join("retention-before"));
    let report_directory = retained.directory.join(&fixture.package);
    let final_reports = read_reports(&report_directory);
    let sibling_before: Vec<_> = captured
        .iter()
        .filter(|(_, _, report)| report["target"]["source"] == sibling_source)
        .collect();
    let sibling_after: Vec<_> = final_reports
        .iter()
        .filter(|(_, _, report)| report["target"]["source"] == sibling_source)
        .collect();
    assert_eq!(sibling_before.len(), 1);
    assert_eq!(sibling_after.len(), 1);
    let (before_path, before_bytes, before_report) = sibling_before[0];
    let (after_path, after_bytes, after_report) = sibling_after[0];
    let request: Value = serde_json::from_slice(
        &fs::read(
            retained
                .directory
                .join(format!("{}-request.input", fixture.package)),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(before_report["run"], request["run"]);
    assert_eq!(after_report["analyzed"], true);
    assert_eq!(after_report["inputs"]["complete"], true);
    let sibling_input = after_report["inputs"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|input| input["path"] == sibling_source)
        .unwrap();
    assert_eq!(
        sibling_input["sha256"],
        format!("{:x}", Sha256::digest(b"pub const VALUE: usize = 5;\n"))
    );
    assert_eq!(before_path.file_name(), after_path.file_name());
    assert_eq!(before_report["run"], after_report["run"]);
    assert_eq!(Sha256::digest(before_bytes), Sha256::digest(after_bytes));
    assert_eq!(before_bytes, after_bytes);
    let original_run = before_report["run"].as_str().unwrap();
    for source in &root_sources {
        let before: Vec<_> = captured
            .iter()
            .filter(|(_, _, report)| report["target"]["source"] == *source)
            .collect();
        let after: Vec<_> = final_reports
            .iter()
            .filter(|(_, _, report)| report["target"]["source"] == *source)
            .collect();
        assert_eq!(before.len(), 1);
        assert_eq!(after.len(), 1);
        assert!(
            !report_directory
                .join(before[0].0.file_name().unwrap())
                .exists()
        );
        assert_eq!(after[0].2["run"], original_run);
    }
    let final_parents: Vec<_> = final_reports
        .iter()
        .filter(|(_, _, report)| report["target"]["source"] == parent_source)
        .collect();
    assert_eq!(final_parents.len(), 2);
    assert!(
        final_parents
            .iter()
            .all(|(_, _, report)| report["run"] == original_run)
    );
    assert_eq!(
        fs::read(fixture.root.join("Cargo.lock")).unwrap(),
        lock_bytes
    );
    let retained_hot = fixture.run("architecture", "proof-retained-hot", "first", "1");
    hot(&retained_hot);
    assert_eq!(
        count(&retained_hot, "reused"),
        units.len() as u64,
        "{}",
        retained_hot.summary
    );
}

#[test]
fn named_fields_tracks_include_environment_generated_inputs_and_cached_findings() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("tracked_inputs");
    changed(&fixture.run("named-fields", "cold", "first", "1"));
    hot(&fixture.run("named-fields", "warm", "first", "1"));
    fs::write(
        fixture.root.join("src/input.txt"),
        "included content changed",
    )
    .unwrap();
    changed(&fixture.run("named-fields", "include-changed", "first", "1"));
    changed(&fixture.run("named-fields", "environment-changed", "second", "1"));
    fs::write(fixture.root.join("seed.txt"), "9").unwrap();
    changed(&fixture.run("named-fields", "generator-input-changed", "second", "1"));
    changed(&fixture.run(
        "named-fields",
        "generator-environment-changed",
        "second",
        "3",
    ));
    hot(&fixture.run("named-fields", "inputs-hot", "second", "3"));
    fixture.source(1, true);
    let negative = fixture.run("named-fields", "negative", "second", "3");
    changed(&negative);
    assert!(!negative.result["issues"].as_array().unwrap().is_empty());
    let reused_negative = fixture.run("named-fields", "negative-hot", "second", "3");
    hot(&reused_negative);
    assert_eq!(negative.result, reused_negative.result);
}

#[test]
fn cached_named_field_violations_keep_the_cli_failure_exit_code() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("cli_findings");
    fixture.source(1, true);
    changed(&fixture.run_cli_negative());
    hot(&fixture.run_cli_negative());
}

#[test]
fn nested_tool_members_keep_dependency_reports_fresh_between_selected_roots() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("nested_tools");
    let members = fixture.nested_tool_workspace();
    let packages = std::iter::once(fixture.package.clone())
        .chain(members)
        .collect::<Vec<_>>();
    let before: Vec<_> = packages
        .iter()
        .map(|package| package_summaries(package))
        .collect();
    let cold = fixture.run("named-fields", "nested-cold", "first", "1");
    assert!(cold.result["issues"].as_array().unwrap().is_empty());
    let cold_runs: Vec<_> = packages
        .iter()
        .zip(&before)
        .map(|(package, previous)| new_package_run(package, previous))
        .collect();
    for run in &cold_runs {
        changed(run);
    }
    for run in &cold_runs[2..] {
        assert_eq!(
            run.summary["configuration"], cold_runs[1].summary["configuration"],
            "Members of the same effective tool workspace must share a stable configuration"
        );
    }

    let before: Vec<_> = packages
        .iter()
        .map(|package| package_summaries(package))
        .collect();
    let warm = fixture.run("named-fields", "nested-warm", "first", "1");
    assert_eq!(warm.result, cold.result);
    for ((package, previous), cold) in packages.iter().zip(&before).zip(&cold_runs) {
        let run = new_package_run(package, previous);
        hot(&run);
        assert_eq!(
            run.summary["configuration"], cold.summary["configuration"],
            "Changing only the request run cannot invalidate {package}"
        );
    }
}

fn nested_cold_then_hot(fixture: &Fixture, members: [String; 3], label: &str) -> Vec<Run> {
    let packages = std::iter::once(fixture.package.clone())
        .chain(members)
        .collect::<Vec<_>>();
    let before: Vec<_> = packages
        .iter()
        .map(|package| package_summaries(package))
        .collect();
    assert!(before.iter().all(BTreeSet::is_empty));
    let cold = fixture.run("named-fields", &format!("{label}-cold"), "first", "1");
    assert!(cold.result["issues"].as_array().unwrap().is_empty());
    let cold_runs: Vec<_> = packages
        .iter()
        .zip(&before)
        .map(|(package, previous)| new_package_run(package, previous))
        .collect();
    assert_eq!(
        cold_runs
            .iter()
            .map(|run| &run.directory)
            .collect::<BTreeSet<_>>()
            .len(),
        packages.len()
    );
    for run in &cold_runs {
        changed(run);
    }
    for run in &cold_runs[2..] {
        assert_eq!(
            run.summary["configuration"],
            cold_runs[1].summary["configuration"]
        );
    }

    let before: Vec<_> = packages
        .iter()
        .map(|package| package_summaries(package))
        .collect();
    let warm = fixture.run("named-fields", &format!("{label}-warm"), "first", "1");
    assert_eq!(warm.result, cold.result);
    for ((package, previous), cold) in packages.iter().zip(&before).zip(&cold_runs) {
        let run = new_package_run(package, previous);
        hot(&run);
        assert_eq!(run.summary["configuration"], cold.summary["configuration"]);
    }
    cold_runs
}

#[test]
fn nested_tool_dev_dependencies_are_ready_before_their_consumers_finish() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("nested_dev_tools");
    let members = fixture.nested_tool_workspace_with_compiler_dev_dependency();
    nested_cold_then_hot(&fixture, members, "nested-dev");
}

#[test]
fn nested_default_optional_dependencies_follow_the_configured_native_target() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("nested_optional_target");
    let members = fixture.nested_tool_workspace_with_default_optional_dependency();
    let output = Command::new("rustc")
        .arg("-vV")
        .env("RUSTUP_TOOLCHAIN", env!("ANALYSIS_TOOLCHAIN"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let version = String::from_utf8(output.stdout).unwrap();
    let target = version
        .lines()
        .find_map(|line| line.strip_prefix("host: "))
        .unwrap();
    let config = fixture.root.join("tools/rustc-analysis/.cargo");
    fs::create_dir_all(&config).unwrap();
    fs::write(
        config.join("config.toml"),
        format!("[build]\ntarget = {target:?}\n"),
    )
    .unwrap();

    let runs = nested_cold_then_hot(&fixture, members, "nested-default-target");
    let graph: Value = serde_json::from_slice(
        &fs::read(runs[2].directory.join("nested-order-unit-graph.json")).unwrap(),
    )
    .unwrap();
    let units = graph["units"].as_array().unwrap();
    let roots: Vec<_> = graph["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|root| root.as_u64().unwrap() as usize)
        .collect();
    assert!(roots.iter().all(|root| units[*root]["platform"] == target));
    assert!(roots.iter().any(|root| {
        let features = units[*root]["features"].as_array().unwrap();
        features.iter().any(|feature| feature == "default")
            && features.iter().any(|feature| feature == "runner-support")
    }));
    let mut reached = BTreeSet::new();
    let mut pending = roots;
    while let Some(index) = pending.pop() {
        if reached.insert(index) {
            pending.extend(
                units[index]["dependencies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|dependency| dependency["index"].as_u64().unwrap() as usize),
            );
        }
    }
    let runner = fixture
        .root
        .join("tools/rustc-analysis/runner/src/lib.rs")
        .canonicalize()
        .unwrap();
    assert!(
        reached.iter().any(|index| {
            units[*index]["target"]["src_path"]
                .as_str()
                .is_some_and(|source| Path::new(source).canonicalize().unwrap() == runner)
        }),
        "The default-enabled optional path dependency must be reachable in the configured target graph"
    );
}

#[test]
fn passive_dependencies_invalidate_by_source_hash_and_can_be_promoted_to_requested_rules() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("passive_dependency");
    let source = fixture.root.join("dependency/src/lib.rs");
    let original = b"pub struct ForeignTuple(pub usize);\npub const VALUE: usize = 4;\n";
    let replacement = b"pub struct ForeignTuple(pub usize);\npub const VALUE: usize = 8;\n";
    fs::write(&source, original).unwrap();
    let cold = fixture.run_cli_check(&fixture.root, &fixture.package, 0);
    changed(&cold);
    dependency_units_have_passive_inputs(&cold, &fixture);
    hot(&fixture.run_cli_check(&fixture.root, &fixture.package, 0));

    let metadata = fs::metadata(&source).unwrap();
    let modified = metadata.modified().unwrap();
    assert_ne!(original, replacement);
    assert_eq!(original.len(), replacement.len());
    fs::write(&source, replacement).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let preserved = fs::metadata(&source).unwrap();
    assert_eq!(preserved.modified().unwrap(), modified);
    assert_eq!(preserved.len(), metadata.len());

    let repaired = fixture.run_cli_check(&fixture.root, &fixture.package, 0);
    dependency_was_fresh(&repaired, &fixture);
    assert_eq!(count(&repaired, "recovered"), 1, "{}", repaired.summary);
    assert_eq!(count(&repaired, "attempts"), 2, "{}", repaired.summary);
    assert!(count(&repaired, "compiled") > 0);
    assert_eq!(
        repaired.summary["configuration"],
        cold.summary["configuration"]
    );
    hot(&fixture.run_cli_check(&fixture.root, &fixture.package, 0));

    let dependency = fixture.root.join("dependency");
    let selected = fixture.run_cli_check(&dependency, "fixture_dependency", 1);
    assert!(
        count(&selected, "compiled") > 0,
        "A passive report cannot substitute for a requested rule result"
    );
    assert_eq!(
        selected.summary["configuration"],
        repaired.summary["configuration"]
    );
    let active: Vec<Value> = fs::read_dir(selected.directory.join("fixture_dependency"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap())
        .filter(|report: &Value| report["target"]["source"] == normalized(&source).unwrap())
        .collect();
    assert!(!active.is_empty());
    assert!(
        active.iter().all(|report| report["analyzed"] == true
            && !report["findings"].as_array().unwrap().is_empty())
    );
    hot(&fixture.run_cli_check(&dependency, "fixture_dependency", 1));
    fixture.run_cli_check(&fixture.root, &fixture.package, 0);
}

#[test]
fn overridden_parent_cargo_paths_do_not_change_the_effective_configuration() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("parent_cargo_environment");
    let baseline = fixture.run("named-fields", "cold", "first", "1");
    changed(&baseline);
    for suffix in ["first", "second"] {
        let warm = fixture.run(
            "named-fields",
            &format!("parent-cargo-env-{suffix}"),
            "first",
            "1",
        );
        hot(&warm);
        assert_eq!(
            warm.summary["configuration"],
            baseline.summary["configuration"]
        );
        assert!(
            !fixture
                .root
                .join(format!("ignored-target-{suffix}"))
                .exists()
        );
        assert!(
            !fixture
                .root
                .join(format!("ignored-build-{suffix}"))
                .exists()
        );
    }
}

#[test]
fn changed_driver_bytes_invalidate_reports_at_the_same_wrapper_path() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("driver_bytes");
    let source_driver = driver();
    let copied_driver = fixture
        .root
        .join("driver-copy")
        .join(format!("rustc-analysis-driver{}", env::consts::EXE_SUFFIX));
    fs::create_dir_all(copied_driver.parent().unwrap()).unwrap();
    fs::copy(&source_driver, &copied_driver).unwrap();
    assert_ne!(
        normalized(&source_driver).unwrap(),
        normalized(&copied_driver).unwrap()
    );
    let original_size = fs::metadata(&source_driver).unwrap().len();
    assert_eq!(fs::metadata(&copied_driver).unwrap().len(), original_size);

    let baseline = fixture.run("named-fields", "driver-copy-cold", "first", "1");
    changed(&baseline);
    hot(&fixture.run("named-fields", "driver-copy-warm", "first", "1"));
    fs::OpenOptions::new()
        .append(true)
        .open(&copied_driver)
        .unwrap()
        .write_all(b"\nanalysis-driver-cache-regression\n")
        .unwrap();
    assert!(fs::metadata(&copied_driver).unwrap().len() > original_size);
    assert_eq!(fs::metadata(&source_driver).unwrap().len(), original_size);

    let modified = fixture.run("named-fields", "driver-copy-modified", "first", "1");
    changed(&modified);
    assert_ne!(
        modified.summary["configuration"],
        baseline.summary["configuration"]
    );
    let warm = fixture.run("named-fields", "driver-copy-modified-hot", "first", "1");
    hot(&warm);
    assert_eq!(
        warm.summary["configuration"],
        modified.summary["configuration"]
    );
    assert_eq!(fs::metadata(&source_driver).unwrap().len(), original_size);
}

#[test]
fn cargo_environment_config_respects_forced_values_and_parent_overrides() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("configured_environment");
    fixture.set_environment_config("configured-first", true);
    let forced = fixture.run("named-fields", "forced-cold", "parent-first", "1");
    changed(&forced);
    compiler_environment_matches(
        &forced,
        &fixture,
        "ANALYSIS_FIXTURE_VALUE",
        "configured-first",
    );
    let warm = fixture.run(
        "named-fields",
        "forced-parent-changed",
        "parent-second",
        "1",
    );
    hot(&warm);
    assert_eq!(
        warm.summary["configuration"],
        forced.summary["configuration"]
    );

    fixture.set_environment_config("configured-second", true);
    let configured = fixture.run(
        "named-fields",
        "configured-value-changed",
        "parent-second",
        "1",
    );
    changed(&configured);
    assert_ne!(
        configured.summary["configuration"],
        forced.summary["configuration"]
    );
    compiler_environment_matches(
        &configured,
        &fixture,
        "ANALYSIS_FIXTURE_VALUE",
        "configured-second",
    );
    let warm = fixture.run("named-fields", "configured-value-hot", "parent-third", "1");
    hot(&warm);
    assert_eq!(
        warm.summary["configuration"],
        configured.summary["configuration"]
    );

    fixture.set_environment_config("configured-second", false);
    let inherited = fixture.run("named-fields", "nonforced-first", "parent-first", "1");
    changed(&inherited);
    compiler_environment_matches(
        &inherited,
        &fixture,
        "ANALYSIS_FIXTURE_VALUE",
        "parent-first",
    );
    let parent = fixture.run(
        "named-fields",
        "nonforced-parent-changed",
        "parent-second",
        "1",
    );
    changed(&parent);
    assert_eq!(
        parent.summary["configuration"],
        inherited.summary["configuration"]
    );
    compiler_environment_matches(&parent, &fixture, "ANALYSIS_FIXTURE_VALUE", "parent-second");
    hot(&fixture.run("named-fields", "nonforced-hot", "parent-second", "1"));
}

#[cfg(windows)]
#[test]
fn lowercase_compiler_environment_reads_match_uppercase_windows_parent_keys() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("windows_environment_case");
    let source = fixture.root.join("src/main.rs");
    let mut text = fs::read_to_string(&source).unwrap();
    text.push_str("\nconst CASE_VALUE: &str = env!(\"analysis_fixture_case\");\n");
    fs::write(source, text).unwrap();
    let cold = fixture.run("named-fields", "windows-case-cold", "first", "1");
    changed(&cold);
    compiler_environment_matches(
        &cold,
        &fixture,
        "analysis_fixture_case",
        "uppercase-parent-value",
    );
    let warm = fixture.run("named-fields", "windows-case-warm", "first", "1");
    hot(&warm);
    assert_eq!(warm.summary["configuration"], cold.summary["configuration"]);
}

#[test]
fn dependency_features_and_profile_changes_do_not_reuse_stale_reports() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("compilation_inputs");
    let baseline = fixture.run_configured("named-fields", "baseline", "first", "1", &[], Some("0"));
    changed(&baseline);
    hot(&fixture.run_configured("named-fields", "baseline-hot", "first", "1", &[], Some("0")));

    fs::write(
        fixture.root.join("dependency/src/lib.rs"),
        "pub const VALUE: usize = 6;\n",
    )
    .unwrap();
    let dependency = fixture.run_configured(
        "named-fields",
        "dependency-changed",
        "first",
        "1",
        &[],
        Some("0"),
    );
    changed(&dependency);
    let messages = fs::read_to_string(
        dependency
            .directory
            .join(format!("{}-0.stdout.jsonl", fixture.package)),
    )
    .unwrap();
    assert!(
        messages
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .any(|value| {
                value["reason"] == "compiler-artifact"
                    && value["target"]["name"] == "fixture_dependency"
                    && value["fresh"] == false
            })
    );
    hot(&fixture.run_configured(
        "named-fields",
        "dependency-hot",
        "first",
        "1",
        &[],
        Some("0"),
    ));

    let features = fixture.run_configured(
        "named-fields",
        "features-changed",
        "first",
        "1",
        &["selected"],
        Some("0"),
    );
    changed(&features);
    assert_ne!(
        features.summary["configuration"],
        baseline.summary["configuration"]
    );
    hot(&fixture.run_configured(
        "named-fields",
        "features-hot",
        "first",
        "1",
        &["selected"],
        Some("0"),
    ));

    let profile = fixture.run_configured(
        "named-fields",
        "profile-changed",
        "first",
        "1",
        &["selected"],
        Some("1"),
    );
    changed(&profile);
    assert_ne!(
        profile.summary["configuration"],
        features.summary["configuration"]
    );
    let messages = fs::read_to_string(
        profile
            .directory
            .join(format!("{}-0.stdout.jsonl", fixture.package)),
    )
    .unwrap();
    let root_units: Vec<Value> = messages
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|value| {
            value["reason"] == "compiler-artifact"
                && value["target"]["name"] == fixture.package
                && value["profile"]["test"] == false
        })
        .collect();
    assert!(!root_units.is_empty());
    assert!(root_units.iter().all(|value| {
        value["profile"]["opt_level"] == "1"
            && value["features"]
                .as_array()
                .unwrap()
                .iter()
                .any(|feature| feature == "selected")
    }));
    hot(&fixture.run_configured(
        "named-fields",
        "profile-hot",
        "first",
        "1",
        &["selected"],
        Some("1"),
    ));
}

#[test]
fn adding_a_previously_absent_module_alternative_cannot_reuse_a_successful_report() {
    let _serial = host_test_guard();
    let fixture = Fixture::new("negative_module_probe");
    let source = fixture.root.join("src/main.rs");
    let mut text = fs::read_to_string(&source).unwrap();
    text.push_str("\nmod foo;\n");
    fs::write(source, text).unwrap();
    fs::write(
        fixture.root.join("src/foo.rs"),
        "pub const ITEM: usize = 1;\n",
    )
    .unwrap();
    changed(&fixture.run("named-fields", "cold", "first", "1"));
    hot(&fixture.run("named-fields", "warm", "first", "1"));
    fs::create_dir_all(fixture.root.join("src/foo")).unwrap();
    fs::write(
        fixture.root.join("src/foo/mod.rs"),
        "pub const ALTERNATIVE: usize = 2;\n",
    )
    .unwrap();
    let child = fixture.invoke("named-fields", "ambiguous-module", "first", "1");
    assert!(
        !child.status.success(),
        "The cached success must not hide a new native module ambiguity"
    );
    let diagnostic = String::from_utf8_lossy(&child.stderr);
    assert!(diagnostic.contains("E0761"), "{diagnostic}");
}
