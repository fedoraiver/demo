//! 独立子进程验证三规则共享的输入证明，避免测试环境变量和 rustc 会话互相污染。
use analysis_contract::{
    ANALYSIS_SCHEMA_VERSION, PackageOrigin, PackageTargetOrigin, Request, Rule, UnitReport,
    normalized,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    sysroot: PathBuf,
    package_origins: Vec<PackageOrigin>,
    primary: bool,
}

impl Fixture {
    fn new(name: &str, source: &[u8]) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/driver-inputs")
            .join(format!(
                "{name}-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let source_path = root.join("lib.rs");
        fs::write(&source_path, source).unwrap();
        let output = Command::new("rustc")
            .env("RUSTUP_TOOLCHAIN", env!("ANALYSIS_TOOLCHAIN"))
            .args(["--print", "sysroot"])
            .output()
            .unwrap();
        assert!(output.status.success());
        Self {
            root,
            source: source_path,
            sysroot: PathBuf::from(String::from_utf8(output.stdout).unwrap().trim()),
            package_origins: vec![],
            primary: true,
        }
    }

    fn run(
        &self,
        rule: Rule,
        run: &str,
        configuration: &str,
        extra: &[&str],
    ) -> (UnitReport, String) {
        let result = self.run_report(rule, run, configuration, extra);
        assert!(result.0.failure.is_none(), "{:?}", result.0.failure);
        result
    }

    fn run_report(
        &self,
        rule: Rule,
        run: &str,
        configuration: &str,
        extra: &[&str],
    ) -> (UnitReport, String) {
        self.run_report_with_outputs(
            rule,
            run,
            configuration,
            extra,
            &["--crate-type=lib", "--emit=metadata,dep-info"],
        )
    }

    fn run_report_with_outputs(
        &self,
        rule: Rule,
        run: &str,
        configuration: &str,
        extra: &[&str],
        outputs: &[&str],
    ) -> (UnitReport, String) {
        let directory = self.root.join(run);
        fs::create_dir_all(&directory).unwrap();
        let request = Request {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            run: run.into(),
            configuration: configuration.into(),
            compiler: env!("ANALYSIS_COMPILER").into(),
            workspace: normalized(&self.root).unwrap(),
            rule,
            sources: BTreeSet::from([normalized(&self.source).unwrap()]),
            manifest_dirs: BTreeSet::from([normalized(&self.root).unwrap()]),
            package_origins: self.package_origins.clone(),
        };
        let request_path = directory.join("request.input");
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
        let mut paths = vec![self.sysroot.join("bin"), self.sysroot.join("lib")];
        paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
        let mut command = Command::new(env!("CARGO_BIN_EXE_rustc-analysis-driver"));
        command
            .current_dir(&self.root)
            .env("PATH", env::join_paths(paths).unwrap())
            .env("ANALYSIS_REQUEST", &request_path)
            .env("ANALYSIS_REPORTS", &directory)
            .env("ANALYSIS_SYSROOT", &self.sysroot)
            .env("ANALYSIS_CONFIGURATION", configuration)
            .env("CARGO_MANIFEST_DIR", &self.root)
            .env("CARGO_PKG_NAME", "driver_fixture")
            .env("CARGO_PRIMARY_PACKAGE", "1")
            .env("DRIVER_INPUT_SECRET", "private-value-never-copy-to-report")
            .env_remove("DRIVER_INPUT_ABSENT")
            .arg(
                self.sysroot
                    .join("bin")
                    .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
            )
            .arg(&self.source)
            .args(["--crate-name=driver_fixture", "--edition=2024", "--out-dir"])
            .arg(&self.root)
            .args(outputs)
            .args(extra);
        if !self.primary {
            command.env_remove("CARGO_PRIMARY_PACKAGE");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let reports: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        assert_eq!(reports.len(), 1);
        let bytes = fs::read(&reports[0]).unwrap();
        let report: UnitReport = serde_json::from_slice(&bytes).unwrap();
        (report, String::from_utf8(bytes).unwrap())
    }
}

fn hash(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}

#[cfg(windows)]
const CREATE_DIRECTORY_ALIAS: &str = "New-Item -ItemType Junction -Path $env:ANALYSIS_INPUT_ALIAS_LINK -Target $env:ANALYSIS_INPUT_ALIAS_TARGET -ErrorAction Stop | Out-Null";

#[cfg(any(windows, unix))]
fn directory_alias(link: &Path, target: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link)
        .expect("The alias regression requires directory symlink support under tmp");
    #[cfg(windows)]
    {
        let output = Command::new("pwsh")
            .args(["-NoProfile", "-NonInteractive", "-Command", CREATE_DIRECTORY_ALIAS])
            .env("ANALYSIS_INPUT_ALIAS_LINK", link.to_string_lossy().trim_start_matches(r"\\?\"))
            .env("ANALYSIS_INPUT_ALIAS_TARGET", target.to_string_lossy().trim_start_matches(r"\\?\"))
            .output().expect("The alias regression requires PowerShell 7 to create an unprivileged junction under tmp");
        assert!(
            output.status.success(),
            "The alias regression requires a filesystem supporting directory junctions under tmp:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(any(windows, unix))]
fn remove_directory_alias(link: &Path) {
    #[cfg(unix)]
    fs::remove_file(link).unwrap();
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
}

#[cfg(any(windows, unix))]
fn retarget_macro_body(link: &Path, target: &Path) -> String {
    #[cfg(unix)]
    {
        format!(
            "std::fs::remove_file({:?}).unwrap(); std::os::unix::fs::symlink({:?}, {:?}).unwrap();",
            link.to_string_lossy(),
            target.to_string_lossy(),
            link.to_string_lossy()
        )
    }
    #[cfg(windows)]
    {
        format!(
            "std::fs::remove_dir({:?}).unwrap(); let status = std::process::Command::new(\"pwsh\").args({:?}).env(\"ANALYSIS_INPUT_ALIAS_LINK\", {:?}).env(\"ANALYSIS_INPUT_ALIAS_TARGET\", {:?}).status().unwrap(); assert!(status.success(), \"Creating the replacement junction under tmp failed\");",
            link.to_string_lossy(),
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                CREATE_DIRECTORY_ALIAS
            ],
            link.to_string_lossy().trim_start_matches(r"\\?\"),
            target.to_string_lossy().trim_start_matches(r"\\?\")
        )
    }
}

#[test]
fn all_rules_record_sources_binary_includes_and_hashed_environment_inputs() {
    let fixture = Fixture::new("native-inputs", b"mod leaf;\nconst TEXT: &str = include_str!(\"text.txt\");\nconst DATA: &[u8] = include_bytes!(\"bytes.bin\");\npub fn value() -> usize { TEXT.len() + DATA.len() + leaf::N + env!(\"DRIVER_INPUT_SECRET\").len() + option_env!(\"DRIVER_INPUT_ABSENT\").map(str::len).unwrap_or(0) }\n");
    fs::write(fixture.root.join("leaf.rs"), b"pub const N: usize = 2;\n").unwrap();
    fs::write(fixture.root.join("text.txt"), b"included text\r\n").unwrap();
    fs::write(fixture.root.join("bytes.bin"), [0, 255, 128, 4]).unwrap();
    for (index, rule) in [Rule::NamedFields, Rule::EntityNames, Rule::Architecture]
        .into_iter()
        .enumerate()
    {
        let (report, serialized) =
            fixture.run(rule, &format!("rule-{index}"), "stable-native-inputs", &[]);
        assert_eq!(report.schema_version, ANALYSIS_SCHEMA_VERSION);
        assert_eq!(report.rule, rule);
        assert!(report.analyzed);
        assert!(!report.target.test);
        assert!(
            !report.inputs.incremental,
            "The direct driver fixture did not request -Cincremental"
        );
        assert!(report.inputs.complete, "{:?}", report.inputs.gaps);
        for name in ["lib.rs", "leaf.rs", "text.txt", "bytes.bin"] {
            let path = fixture.root.join(name);
            let input = report
                .inputs
                .files
                .iter()
                .find(|input| input.path == normalized(&path).unwrap())
                .unwrap();
            assert_eq!(input.sha256, hash(&path));
        }
        let absent_module = fixture
            .root
            .join("leaf/mod.rs")
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/");
        assert!(
            report
                .inputs
                .probes
                .iter()
                .any(|probe| probe.path == absent_module && !probe.exists)
        );
        let secret = report
            .inputs
            .env
            .iter()
            .find(|input| input.name == "DRIVER_INPUT_SECRET")
            .unwrap();
        assert_eq!(
            secret.value_sha256.as_deref(),
            Some(
                format!(
                    "{:x}",
                    Sha256::digest(b"private-value-never-copy-to-report")
                )
                .as_str()
            )
        );
        assert_eq!(
            report
                .inputs
                .env
                .iter()
                .find(|input| input.name == "DRIVER_INPUT_ABSENT")
                .unwrap()
                .value_sha256,
            None
        );
        assert!(!serialized.contains("private-value-never-copy-to-report"));
        let mut legacy: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        legacy.as_object_mut().unwrap().remove("schema_version");
        assert!(serde_json::from_value::<UnitReport>(legacy).is_err());
        let mut missing_aliases: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        missing_aliases["inputs"]
            .as_object_mut()
            .unwrap()
            .remove("aliases");
        assert!(serde_json::from_value::<UnitReport>(missing_aliases).is_err());
        assert!(!report.inputs.binary_paths.is_empty());
        assert!(
            report
                .inputs
                .binary_paths
                .iter()
                .all(|path| Path::new(path).is_file())
        );
        let dep_info = report.inputs.dep_info.unwrap();
        assert_eq!(dep_info.sha256, hash(Path::new(&dep_info.path)));
        let dep_text = fs::read_to_string(dep_info.path).unwrap();
        assert!(dep_text.contains("# env-dep:ANALYSIS_CONFIGURATION=stable-native-inputs"));
        assert!(!dep_text.contains(&format!("rule-{index}")));
    }
}

#[test]
fn cargo_target_origins_identify_source_files_without_a_rust_extension() {
    let mut fixture = Fixture::new(
        "non-rust-extension",
        b"pub struct SelectedTuple(pub usize);\n",
    );
    let source = fixture.root.join("generated.input");
    fs::rename(&fixture.source, &source).unwrap();
    fixture.source = source;
    fixture.package_origins = vec![PackageOrigin {
        root: normalized(&fixture.root).unwrap(),
        identity: serde_json::json!({"source":"fixture","name":"driver_fixture","version":"0.1.0"})
            .to_string(),
        targets: vec![PackageTargetOrigin {
            source: normalized(&fixture.source).unwrap(),
            name: "driver_fixture".into(),
            kind: vec!["lib".into()],
        }],
    }];
    let (report, _) = fixture.run(
        Rule::NamedFields,
        "origin-target",
        "stable-origin-target",
        &[],
    );
    assert!(report.analyzed);
    assert_eq!(report.target.source, normalized(&fixture.source).unwrap());
    assert!(report.inputs.complete, "{:?}", report.inputs.gaps);
    assert!(
        !report.findings.is_empty(),
        "The selected non-.rs target must actually execute the rule"
    );
}

#[test]
fn run_provenance_is_untracked_and_harness_is_distinct_from_cfg_test() {
    let fixture = Fixture::new("run-and-harness", b"pub fn value() -> usize { 3 }\n");
    let (first, _) = fixture.run(Rule::NamedFields, "first-run", "stable-run-inputs", &[]);
    let (second, _) = fixture.run(Rule::NamedFields, "second-run", "stable-run-inputs", &[]);
    assert_ne!(first.run, second.run);
    assert_eq!(
        first.inputs.dep_info.as_ref().unwrap().sha256,
        second.inputs.dep_info.as_ref().unwrap().sha256
    );
    assert_eq!(first.inputs.files, second.inputs.files);
    assert_eq!(first.inputs.aliases, second.inputs.aliases);
    let (changed_configuration, _) = fixture.run(
        Rule::NamedFields,
        "changed-configuration",
        "changed-run-inputs",
        &[],
    );
    assert_ne!(
        first.inputs.dep_info.as_ref().unwrap().sha256,
        changed_configuration
            .inputs
            .dep_info
            .as_ref()
            .unwrap()
            .sha256
    );
    let (cfg_test, _) = fixture.run(
        Rule::NamedFields,
        "cfg-test",
        "stable-run-inputs",
        &["--cfg=test"],
    );
    assert!(!cfg_test.target.test);
    assert!(
        cfg_test
            .inputs
            .cfg
            .iter()
            .any(|(name, value)| name == "test" && value.is_none())
    );
    let (harness, _) = fixture.run(
        Rule::NamedFields,
        "actual-test",
        "stable-run-inputs",
        &["--test"],
    );
    assert!(harness.target.test);
    assert_eq!(cfg_test.crate_types, vec!["rlib"]);
    assert_eq!(harness.crate_types, vec!["bin"]);
}

#[test]
fn link_outputs_follow_native_crate_types_and_explicit_filenames() {
    let cases: [(&str, &str, &[u8], String); 3] = [
        ("linked-bin", "bin", b"fn main() {}\n", format!("driver_fixture{}", env::consts::EXE_SUFFIX)),
        ("linked-rlib", "rlib", b"pub fn value() -> usize { 1 }\n", "libdriver_fixture.rlib".into()),
        ("linked-proc-macro", "proc-macro", b"extern crate proc_macro;\n#[proc_macro]\npub fn passthrough(input: proc_macro::TokenStream) -> proc_macro::TokenStream { input }\n", format!("{}driver_fixture{}", env::consts::DLL_PREFIX, env::consts::DLL_SUFFIX)),
    ];
    for (name, crate_type, source, filename) in cases {
        let fixture = Fixture::new(name, source);
        let crate_argument = format!("--crate-type={crate_type}");
        let (report, _) = fixture.run_report_with_outputs(
            Rule::NamedFields,
            "linked-output",
            "stable-linked-output",
            &[],
            &[&crate_argument, "--emit=dep-info,link"],
        );
        assert!(report.failure.is_none(), "{:?}", report.failure);
        assert_eq!(report.crate_types, vec![crate_type]);
        assert!(report.inputs.complete, "{:?}", report.inputs.gaps);
        let actual = fixture.root.join(filename);
        assert!(
            actual.is_file(),
            "The driver must complete native linking: {}",
            actual.display()
        );
        assert!(
            report
                .inputs
                .outputs
                .contains(&normalized(&actual).unwrap()),
            "The report must name the actual linked output: {:?}",
            report.inputs.outputs
        );
        assert!(
            report
                .inputs
                .outputs
                .iter()
                .all(|path| Path::new(path).is_file()),
            "Output names must be physical files after Compilation::Continue: {:?}",
            report.inputs.outputs
        );
    }

    let fixture = Fixture::new("default-bin-type", b"fn main() {}\n");
    let (report, _) = fixture.run_report_with_outputs(
        Rule::NamedFields,
        "default-bin",
        "stable-default-bin",
        &[],
        &["--emit=metadata,dep-info"],
    );
    assert!(report.failure.is_none(), "{:?}", report.failure);
    assert_eq!(
        report.crate_types,
        vec!["bin"],
        "The default native crate type is not an empty argv list"
    );

    let fixture = Fixture::new("linked-explicit-bin", b"fn main() {}\n");
    let requested = fixture.root.join("requested-artifact.custom");
    let filename = requested.to_string_lossy().into_owned();
    let (report, _) = fixture.run_report_with_outputs(
        Rule::NamedFields,
        "explicit-output",
        "stable-linked-output",
        &["-o", &filename],
        &["--crate-type=bin", "--emit=dep-info,link"],
    );
    assert!(report.failure.is_none(), "{:?}", report.failure);
    assert!(report.inputs.complete, "{:?}", report.inputs.gaps);
    // 多产物编译按文件主名重建后缀；Linux 可执行文件的空后缀也会移除 .custom。
    let actual = requested.with_extension(env::consts::EXE_SUFFIX.trim_start_matches('.'));
    assert!(
        actual.is_file(),
        "Expected native linked output {}: {:?}",
        actual.display(),
        report.inputs.outputs
    );
    assert_eq!(actual.file_stem().unwrap(), "requested-artifact");
    assert!(
        report
            .inputs
            .outputs
            .contains(&normalized(&actual).unwrap())
    );
    assert!(
        report
            .inputs
            .outputs
            .iter()
            .all(|path| Path::new(path).is_file())
    );
}

#[test]
fn changing_a_loaded_source_during_macro_expansion_rejects_the_input_proof() {
    let fixture = Fixture::new(
        "source-read-time",
        b"mutate::change!();\npub fn value() -> usize { 1 }\n",
    );
    let macro_source = fixture.root.join("mutate.rs");
    fs::write(&macro_source, format!(
        "extern crate proc_macro;\n#[proc_macro]\npub fn change(_: proc_macro::TokenStream) -> proc_macro::TokenStream {{ std::fs::write({:?}, b\"pub fn changed() {{}}\\n\").unwrap(); proc_macro::TokenStream::new() }}\n",
        fixture.source.to_string_lossy()
    )).unwrap();
    let compiled = Command::new(
        fixture
            .sysroot
            .join("bin")
            .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
    )
    .arg(&macro_source)
    .args([
        "--crate-name=mutate",
        "--crate-type=proc-macro",
        "--edition=2024",
        "--out-dir",
    ])
    .arg(&fixture.root)
    .output()
    .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let library = fixture.root.join(format!(
        "{}mutate{}",
        env::consts::DLL_PREFIX,
        env::consts::DLL_SUFFIX
    ));
    let extern_argument = format!("--extern=mutate={}", library.display());
    let (report, _) = fixture.run_report(
        Rule::NamedFields,
        "source-mutated",
        "stable-source-read-time",
        &[&extern_argument],
    );
    assert!(
        report
            .failure
            .as_deref()
            .unwrap()
            .contains("Compiler input changed after it was read")
    );
    assert!(!report.inputs.complete);
}

#[test]
fn a_macro_registered_path_without_read_time_bytes_is_not_reusable() {
    let fixture = Fixture::new(
        "registered-path",
        b"const VALUE: usize = read_extra::read!();\npub fn value() -> usize { VALUE }\n",
    );
    let extra = fixture.root.join("extra.txt");
    fs::write(&extra, "11").unwrap();
    let macro_source = fixture.root.join("read_extra.rs");
    fs::write(&macro_source, format!(
        "#![feature(proc_macro_tracked_path)]\nextern crate proc_macro;\n#[proc_macro]\npub fn read(_: proc_macro::TokenStream) -> proc_macro::TokenStream {{ let path = {:?}; proc_macro::tracked::path(path); let old = std::fs::read_to_string(path).unwrap(); std::fs::write(path, b\"22\").unwrap(); old.parse().unwrap() }}\n",
        extra.to_string_lossy()
    )).unwrap();
    let compiled = Command::new(
        fixture
            .sysroot
            .join("bin")
            .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
    )
    .arg(&macro_source)
    .args([
        "--crate-name=read_extra",
        "--crate-type=proc-macro",
        "--edition=2024",
        "--out-dir",
    ])
    .arg(&fixture.root)
    .output()
    .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let library = fixture.root.join(format!(
        "{}read_extra{}",
        env::consts::DLL_PREFIX,
        env::consts::DLL_SUFFIX
    ));
    let extern_argument = format!("--extern=read_extra={}", library.display());
    let (report, _) = fixture.run(
        Rule::NamedFields,
        "registered-path",
        "stable-registered-path",
        &[&extern_argument],
    );
    assert!(!report.inputs.complete);
    assert!(
        report
            .inputs
            .gaps
            .iter()
            .any(|gap| gap.contains("no read-time content proof") && gap.contains("extra.txt"))
    );
    assert_eq!(
        report
            .inputs
            .files
            .iter()
            .find(|input| input.path == normalized(&extra).unwrap())
            .unwrap()
            .sha256,
        hash(&extra)
    );
}

#[cfg(any(windows, unix))]
#[test]
fn aliases_keep_logical_paths_when_an_existing_directory_link_is_retargeted() {
    let fixture = Fixture::new("directory-alias", b"mod linked;\nconst DATA: &[u8] = include_bytes!(\"linked/bytes.bin\");\npub fn value() -> usize { linked::value() + DATA.len() }\n");
    let first = fixture.root.join("first");
    let second = fixture.root.join("second");
    for (target, value) in [(&first, 1), (&second, 2)] {
        fs::create_dir_all(target).unwrap();
        fs::write(
            target.join("mod.rs"),
            "mod leaf;\npub fn value() -> usize { leaf::VALUE }\n",
        )
        .unwrap();
        fs::write(
            target.join("leaf.rs"),
            format!("pub const VALUE: usize = {value};\n"),
        )
        .unwrap();
        fs::write(target.join("bytes.bin"), [value, 255]).unwrap();
    }
    let link = fixture.root.join("linked");
    directory_alias(&link, &first);
    let (report, _) = fixture.run(
        Rule::NamedFields,
        "first-target",
        "stable-directory-alias",
        &[],
    );
    assert!(report.inputs.complete, "{:?}", report.inputs.gaps);
    for filename in ["mod.rs", "leaf.rs", "bytes.bin"] {
        let logical = link
            .join(filename)
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/");
        assert!(
            report
                .inputs
                .aliases
                .iter()
                .any(|alias| alias.path == logical
                    && alias.resolved == normalized(&first.join(filename)).unwrap()),
            "Missing logical alias for {filename}"
        );
    }
    let negative = link
        .join("leaf/mod.rs")
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    let probe = report
        .inputs
        .probes
        .iter()
        .find(|probe| probe.path == negative && !probe.exists)
        .expect("A negative module probe must retain its logical path through the link");
    remove_directory_alias(&link);
    directory_alias(&link, &second);
    assert!(
        first.join("leaf.rs").is_file(),
        "The old physical target must remain readable"
    );
    assert!(
        report
            .inputs
            .aliases
            .iter()
            .any(|alias| normalized(Path::new(&alias.path)).unwrap() != alias.resolved),
        "Changing only the link target must invalidate the old alias proof"
    );
    fs::create_dir_all(second.join("leaf")).unwrap();
    fs::write(
        second.join("leaf/mod.rs"),
        "pub const ALTERNATIVE: usize = 3;\n",
    )
    .unwrap();
    assert!(
        Path::new(&probe.path).exists(),
        "The old negative proof must now observe the replacement target"
    );
    assert!(!first.join("leaf/mod.rs").exists());
    fs::remove_file(second.join("leaf/mod.rs")).unwrap();
    let (replacement, _) = fixture.run(
        Rule::NamedFields,
        "second-target",
        "stable-directory-alias",
        &[],
    );
    assert!(replacement.inputs.complete, "{:?}", replacement.inputs.gaps);
    let leaf = link
        .join("leaf.rs")
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    assert!(
        replacement
            .inputs
            .aliases
            .iter()
            .any(|alias| alias.path == leaf
                && alias.resolved == normalized(&second.join("leaf.rs")).unwrap())
    );
    assert!(
        report
            .inputs
            .files
            .iter()
            .all(|input| hash(Path::new(&input.path)) == input.sha256),
        "Old physical file bytes alone cannot prove a logical alias is unchanged"
    );
}

#[cfg(any(windows, unix))]
#[test]
fn retargeting_a_loaded_directory_alias_during_expansion_rejects_the_proof() {
    let fixture = Fixture::new(
        "alias-read-time",
        b"mod linked;\nretarget::change!();\npub fn value() -> usize { linked::VALUE }\n",
    );
    let first = fixture.root.join("first");
    let second = fixture.root.join("second");
    for (target, value) in [(&first, 1), (&second, 2)] {
        fs::create_dir_all(target).unwrap();
        fs::write(
            target.join("mod.rs"),
            format!("pub const VALUE: usize = {value};\n"),
        )
        .unwrap();
    }
    let link = fixture.root.join("linked");
    directory_alias(&link, &first);
    let macro_source = fixture.root.join("retarget.rs");
    fs::write(&macro_source, format!("extern crate proc_macro;\n#[proc_macro]\npub fn change(_: proc_macro::TokenStream) -> proc_macro::TokenStream {{ {} proc_macro::TokenStream::new() }}\n", retarget_macro_body(&link, &second))).unwrap();
    let compiled = Command::new(
        fixture
            .sysroot
            .join("bin")
            .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
    )
    .arg(&macro_source)
    .args([
        "--crate-name=retarget",
        "--crate-type=proc-macro",
        "--edition=2024",
        "--out-dir",
    ])
    .arg(&fixture.root)
    .output()
    .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let library = fixture.root.join(format!(
        "{}retarget{}",
        env::consts::DLL_PREFIX,
        env::consts::DLL_SUFFIX
    ));
    let argument = format!("--extern=retarget={}", library.display());
    let (report, _) = fixture.run_report(
        Rule::NamedFields,
        "link-mutated",
        "stable-alias-read-time",
        &[&argument],
    );
    assert!(first.join("mod.rs").is_file());
    assert_eq!(
        normalized(&link.join("mod.rs")).unwrap(),
        normalized(&second.join("mod.rs")).unwrap()
    );
    assert!(
        report
            .failure
            .as_deref()
            .unwrap()
            .contains("Compiler path alias changed"),
        "{:?}",
        report.failure
    );
    assert!(!report.inputs.complete);
}
