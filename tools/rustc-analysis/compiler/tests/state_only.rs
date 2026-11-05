//! 未选中单元保存完整输入证明，只有选中范围产生规则结果；本夹具不执行产物。
use analysis_contract::{ANALYSIS_SCHEMA_VERSION, Request, Rule, UnitReport, normalized};
use std::{
    collections::BTreeSet,
    env, fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn unselected_units_emit_complete_input_reports_without_rule_results() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tmp/rustc-analysis/fixtures/state-only")
        .join(format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let source = root.join("lib.rs");
    fs::write(
        &source,
        "#![allow(dead_code)]\npub struct UnselectedTuple(pub usize);\n",
    )
    .unwrap();
    let compiler = Command::new("rustc")
        .env("RUSTUP_TOOLCHAIN", env!("ANALYSIS_TOOLCHAIN"))
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(compiler.status.success());
    let sysroot = PathBuf::from(String::from_utf8(compiler.stdout).unwrap().trim());
    let mut paths = vec![sysroot.join("bin"), sysroot.join("lib")];
    paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
    let path = env::join_paths(paths).unwrap();
    for rule in [Rule::NamedFields, Rule::EntityNames, Rule::Architecture] {
        let invoke = |run: &str, configuration: &str, analyze: bool| {
            let reports = root.join(format!("{rule:?}-{run}"));
            fs::create_dir_all(&reports).unwrap();
            let request = Request {
                schema_version: ANALYSIS_SCHEMA_VERSION,
                run: run.into(),
                configuration: configuration.into(),
                compiler: env!("ANALYSIS_COMPILER").into(),
                workspace: normalized(&root).unwrap(),
                rule,
                sources: if analyze {
                    BTreeSet::from([normalized(&source).unwrap()])
                } else {
                    BTreeSet::new()
                },
                manifest_dirs: if analyze {
                    BTreeSet::from([normalized(&root).unwrap()])
                } else {
                    BTreeSet::new()
                },
                package_origins: vec![],
            };
            let request_path = reports.join("request.input");
            fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
            let output = Command::new(env!("CARGO_BIN_EXE_rustc-analysis-driver"))
                .current_dir(&root)
                .env("PATH", &path)
                .env("ANALYSIS_REQUEST", &request_path)
                .env("ANALYSIS_CONFIGURATION", configuration)
                .env("ANALYSIS_REPORTS", &reports)
                .env("ANALYSIS_SYSROOT", &sysroot)
                .env("CARGO_MANIFEST_DIR", &root)
                .env("CARGO_PKG_NAME", "state_only")
                .arg(
                    sysroot
                        .join("bin")
                        .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
                )
                .arg(&source)
                .args([
                    "--crate-name=build_script_build",
                    "--crate-type=lib",
                    "--edition=2024",
                    "--emit=metadata,dep-info",
                    "--out-dir",
                ])
                .arg(&root)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{rule:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let reports: Vec<_> = fs::read_dir(&reports)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                })
                .collect();
            assert_eq!(
                reports.len(),
                1,
                "Every real source compilation must emit one input report"
            );
            let report: UnitReport =
                serde_json::from_slice(&fs::read(&reports[0]).unwrap()).unwrap();
            assert_eq!(report.analyzed, analyze);
            assert!(report.failure.is_none(), "{:?}", report.failure);
            assert!(report.inputs.complete, "{:?}", report.inputs.gaps);
            assert!(
                report
                    .inputs
                    .files
                    .iter()
                    .any(|file| file.path == normalized(&source).unwrap())
            );
            if !analyze {
                assert!(
                    report.findings.is_empty(),
                    "Passive tuple structs must not produce named-field violations"
                );
                assert!(report.entities.entities.is_empty());
                assert!(report.entities.diagnostics.is_empty());
                assert!(report.facts.is_none());
            }
            let dep_info = fs::read_to_string(root.join("build_script_build.d")).unwrap();
            assert!(
                dep_info.contains(&format!("# env-dep:ANALYSIS_CONFIGURATION={configuration}")),
                "{dep_info}"
            );
            assert!(
                !dep_info.contains(&normalized(reports[0].parent().unwrap()).unwrap()),
                "Per-run request/report locations must not be tracked"
            );
            (dep_info, report)
        };
        let (first, _) = invoke("first", "state-only-configuration", false);
        let (second, _) = invoke("second", "state-only-configuration", false);
        assert_eq!(
            first, second,
            "Run provenance must not change native dep-info"
        );
        let (changed, _) = invoke("changed", "changed-state-only-configuration", false);
        assert_ne!(
            first, changed,
            "A new actual configuration must be a native compiler dependency"
        );
        if rule == Rule::NamedFields {
            let (_, selected) = invoke("selected", "state-only-configuration", true);
            assert!(
                !selected.findings.is_empty(),
                "The same tuple struct must produce a violation when selected"
            );
            let mut legacy = serde_json::to_value(&selected).unwrap();
            legacy.as_object_mut().unwrap().remove("analyzed");
            assert!(
                !serde_json::from_value::<UnitReport>(legacy)
                    .unwrap()
                    .analyzed,
                "A missing analysis role must fail closed"
            );
        }
    }
}
