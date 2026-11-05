//! 缓存损坏、生产来源及 Cargo 依赖证明的独立回归，不调用编译器。
use crate::{
    report_cache::{ReportCache, file_hash},
    unit_graph::{UnitGraph, UnitQuery},
};
use analysis_contract::{
    ANALYSIS_SCHEMA_VERSION, Rule, UnitInputs, UnitReport, entity_names, named_fields,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct CacheFixture {
    root: PathBuf,
    cache: ReportCache,
    report: UnitReport,
    source: PathBuf,
    key: String,
}

impl CacheFixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/cache-v2")
            .join(format!(
                "{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&root).unwrap();
        let report = UnitReport {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            rule: Rule::NamedFields,
            analyzed: true,
            run: "original-producer".into(),
            configuration: "stable-configuration".into(),
            compiler: "pinned-compiler".into(),
            target: named_fields::Target {
                source: "/fixture/src/lib.rs".into(),
                name: "fixture".into(),
                test: false,
            },
            manifest_dir: "/fixture".into(),
            package: "fixture".into(),
            artifact_tag: "-0123456789abcdef".into(),
            crate_types: vec!["lib".into()],
            inputs: UnitInputs {
                complete: true,
                ..Default::default()
            },
            findings: vec![named_fields::Finding {
                name: "NeedsNamedField".into(),
                site: named_fields::Site {
                    path: "/fixture/src/lib.rs".into(),
                    line: 3,
                    column: 1,
                },
                definition: None,
                expansions: vec![],
            }],
            entities: entity_names::Report::default(),
            facts: None,
            failure: None,
        };
        let source = root.join("current-report.json");
        fs::write(&source, serde_json::to_vec(&report).unwrap()).unwrap();
        let cache = ReportCache::new(
            root.join("cache"),
            report.configuration.clone(),
            report.rule,
        )
        .unwrap();
        Self {
            root,
            cache,
            report,
            source,
            key: "a".repeat(64),
        }
    }

    fn store(&self) {
        self.cache
            .store(
                &self.key,
                &self.source,
                &self.report,
                json!({"inputs":"frozen-proof"}),
            )
            .unwrap();
    }

    fn index(&self) -> PathBuf {
        self.root
            .join("cache/units")
            .join(format!("{}.json", self.key))
    }

    fn record(&self) -> Value {
        serde_json::from_slice(&fs::read(self.index()).unwrap()).unwrap()
    }

    fn write_record(&self, record: &Value) {
        fs::write(self.index(), serde_json::to_vec(record).unwrap()).unwrap();
    }

    fn blob(&self) -> PathBuf {
        self.root.join("cache/reports").join(format!(
            "{}.json",
            self.record()["reportSha256"].as_str().unwrap()
        ))
    }
}

#[test]
fn report_cache_preserves_producer_bytes_and_cached_negative_findings() {
    let fixture = CacheFixture::new();
    assert!(fixture.cache.load(&fixture.key).unwrap().is_none());
    fixture.store();
    let source_hash = file_hash(&fixture.source).unwrap();
    assert_eq!(fixture.record()["reportSha256"], source_hash);
    assert_eq!(
        fs::read(fixture.blob()).unwrap(),
        fs::read(&fixture.source).unwrap()
    );
    let cached = fixture.cache.load(&fixture.key).unwrap().unwrap();
    assert_eq!(cached.report.run, "original-producer");
    assert_eq!(cached.proof, json!({"inputs":"frozen-proof"}));
    assert_eq!(cached.report.findings, fixture.report.findings);
    assert!(
        cached.report.failure.is_none(),
        "Rule violations remain valid reports rather than compiler failures"
    );
    let mut results = named_fields::Report::default();
    results.add(named_fields::Envelope {
        run: cached.report.run,
        configuration: cached.report.configuration,
        compiler: cached.report.compiler,
        target: cached.report.target,
        findings: cached.report.findings,
        failure: cached.report.failure,
    });
    assert_eq!(
        results.issues.len(),
        1,
        "A hot negative report must still fail its rule"
    );

    let second_key = "b".repeat(64);
    fixture
        .cache
        .store(
            &second_key,
            &fixture.source,
            &fixture.report,
            json!({"second":"proof"}),
        )
        .unwrap();
    assert_eq!(
        fs::read_dir(fixture.root.join("cache/reports"))
            .unwrap()
            .count(),
        1,
        "The same producer bytes share one immutable blob"
    );
    assert_eq!(
        fixture.cache.load(&second_key).unwrap().unwrap().report.run,
        "original-producer"
    );
    assert_eq!(
        file_hash(&fixture.blob()).unwrap(),
        source_hash,
        "Loading never rewrites old provenance for the current run"
    );
}

#[test]
fn report_cache_rejects_damaged_indexes_and_report_bytes() {
    let fixture = CacheFixture::new();
    fixture.store();
    let original_index = fs::read(fixture.index()).unwrap();
    let blob = fixture.blob();
    let original_blob = fs::read(&blob).unwrap();
    fs::write(fixture.index(), b"{broken index").unwrap();
    assert!(fixture.cache.load(&fixture.key).is_err());
    fs::write(fixture.index(), &original_index).unwrap();
    fs::write(&blob, b"report bytes changed").unwrap();
    assert!(fixture.cache.load(&fixture.key).is_err());
    fs::write(&blob, &original_blob).unwrap();
    assert!(fixture.cache.load(&fixture.key).unwrap().is_some());

    let mut record = fixture.record();
    record["producerRun"] = json!("a-different-producer");
    fixture.write_record(&record);
    assert!(
        fixture.cache.load(&fixture.key).is_err(),
        "An index may not relabel a report's producer"
    );
    fs::write(fixture.index(), original_index).unwrap();
    fs::remove_file(blob).unwrap();
    assert!(
        fixture.cache.load(&fixture.key).is_err(),
        "A surviving index is not evidence for a missing report"
    );
}

#[test]
fn report_cache_rejects_v1_contexts_and_incomplete_reports() {
    let fixture = CacheFixture::new();
    fixture.store();
    let index = fs::read(fixture.index()).unwrap();
    let mut record = fixture.record();
    record["schemaVersion"] = json!(1);
    fixture.write_record(&record);
    assert!(fixture.cache.load(&fixture.key).is_err());
    fs::write(fixture.index(), &index).unwrap();
    let mut old: Value = serde_json::from_slice(&fs::read(&fixture.source).unwrap()).unwrap();
    old["schema_version"] = json!(1);
    let old_source = fixture.root.join("old-report.json");
    fs::write(&old_source, serde_json::to_vec(&old).unwrap()).unwrap();
    let old_hash = file_hash(&old_source).unwrap();
    fs::copy(
        &old_source,
        fixture
            .root
            .join("cache/reports")
            .join(format!("{old_hash}.json")),
    )
    .unwrap();
    let mut record = fixture.record();
    record["reportSha256"] = json!(old_hash);
    fixture.write_record(&record);
    assert!(
        fixture.cache.load(&fixture.key).is_err(),
        "A v2 index cannot promote a v1 report"
    );
    old.as_object_mut().unwrap().remove("inputs");
    assert!(
        serde_json::from_value::<UnitReport>(old).is_err(),
        "Old input-free reports cannot silently acquire complete evidence"
    );

    fs::write(fixture.index(), &index).unwrap();
    let another_rule = ReportCache::new(
        fixture.root.join("cache"),
        fixture.report.configuration.clone(),
        Rule::EntityNames,
    )
    .unwrap();
    assert!(another_rule.load(&fixture.key).is_err());
    let another_configuration = ReportCache::new(
        fixture.root.join("cache"),
        "another-configuration".into(),
        fixture.report.rule,
    )
    .unwrap();
    assert!(another_configuration.load(&fixture.key).is_err());
    let mut incomplete: UnitReport =
        serde_json::from_slice(&fs::read(&fixture.source).unwrap()).unwrap();
    incomplete.inputs.complete = false;
    assert!(
        fixture
            .cache
            .store(&fixture.key, &fixture.source, &incomplete, Value::Null)
            .is_err()
    );
    incomplete.inputs.complete = true;
    incomplete.failure = Some("analysis failed".into());
    assert!(
        fixture
            .cache
            .store(&fixture.key, &fixture.source, &incomplete, Value::Null)
            .is_err()
    );
    assert_eq!(
        fs::read(fixture.index()).unwrap(),
        index,
        "Rejected replacement retains the previous valid cache entry"
    );
}

fn graph_unit(package: &str, source: &str, dependencies: Value) -> Value {
    json!({"pkg_id":package,"target":{"name":"shared-name","src_path":source,"crate_types":["lib"],"kind":["lib"],"test":true},
        "profile":{"opt_level":"1","debuginfo":0,"debug_assertions":true,"overflow_checks":true},
        "mode":"check","platform":null,"features":[],"dependencies":dependencies})
}

fn parse_graph(units: Vec<Value>) -> UnitGraph {
    UnitGraph::parse(&serde_json::to_vec(&json!({"version":1,"units":units})).unwrap()).unwrap()
}

#[test]
fn cargo_graph_keeps_same_named_packages_from_different_sources_separate() {
    let first = graph_unit("registry+one#shared@1.0.0", "/same/src/lib.rs", json!([]));
    let second = graph_unit("git+two#shared@1.0.0", "/same/src/lib.rs", json!([]));
    let graph = parse_graph(vec![first.clone(), second.clone()]);
    let crate_types = vec!["lib".into()];
    let query = UnitQuery {
        package: "registry+one#shared@1.0.0",
        source: "/same/src/lib.rs",
        name: "shared_name",
        crate_types: &crate_types,
        profile: &first["profile"],
        features: &[],
        mode: "check",
    };
    let one = graph.binding(&query).unwrap();
    let two = graph
        .binding(&UnitQuery {
            package: "git+two#shared@1.0.0",
            ..query
        })
        .unwrap();
    assert_ne!(one.class, two.class);
    assert!(
        graph
            .binding(&UnitQuery {
                package: "path+missing#shared@1.0.0",
                ..query
            })
            .is_err()
    );
}

#[test]
fn cargo_graph_profiles_select_exactly_and_platform_ambiguity_fails_closed() {
    let dev = graph_unit("root", "/root/lib.rs", json!([]));
    let mut release = dev.clone();
    release["profile"]["opt_level"] = json!("3");
    let graph = parse_graph(vec![dev.clone(), release.clone()]);
    let crate_types = vec!["lib".into()];
    let query = UnitQuery {
        package: "root",
        source: "/root/lib.rs",
        name: "shared_name",
        crate_types: &crate_types,
        profile: &dev["profile"],
        features: &[],
        mode: "check",
    };
    let selected = graph.binding(&query).unwrap();
    assert_ne!(
        selected.class,
        graph
            .binding(&UnitQuery {
                profile: &release["profile"],
                ..query
            })
            .unwrap()
            .class
    );
    assert!(
        graph
            .binding(&UnitQuery {
                profile: &Value::Null,
                ..query
            })
            .is_err(),
        "An unspecified profile cannot pick one of non-equivalent candidates"
    );

    let mut target = dev.clone();
    target["platform"] = json!("aarch64-unknown-linux-gnu");
    assert!(
        parse_graph(vec![dev.clone(), target])
            .binding(&query)
            .is_err(),
        "Host/target candidates cannot be paired by array order"
    );
}

#[test]
fn cargo_graph_reordering_preserves_transitive_and_build_script_evidence() {
    let leaf = graph_unit("leaf", "/leaf/lib.rs", json!([]));
    let mut script = graph_unit(
        "build-package",
        "/build/build.rs",
        json!([{"index":0,"extern_crate_name":"leaf"}]),
    );
    script["mode"] = json!("run-custom-build");
    let root = graph_unit(
        "root",
        "/root/lib.rs",
        json!([{"index":1,"extern_crate_name":"build_script"}]),
    );
    let first = parse_graph(vec![leaf.clone(), script.clone(), root.clone()]);
    let mut swapped_root = root.clone();
    swapped_root["dependencies"][0]["index"] = json!(2);
    script["dependencies"][0]["index"] = json!(1);
    let second = parse_graph(vec![swapped_root, leaf, script]);
    let crate_types = vec!["lib".into()];
    let query = UnitQuery {
        package: "root",
        source: "/root/lib.rs",
        name: "shared_name",
        crate_types: &crate_types,
        profile: &root["profile"],
        features: &[],
        mode: "check",
    };
    let original = first.binding(&query).unwrap();
    let swapped = second.binding(&query).unwrap();
    assert_eq!(original.class, swapped.class);
    assert_eq!(original.dependency_classes, swapped.dependency_classes);
    assert_eq!(
        original.build_script_packages,
        swapped.build_script_packages
    );
    assert!(original.build_script_packages.contains("build-package"));
    assert_eq!(original.dependency_classes.len(), 2);
}
