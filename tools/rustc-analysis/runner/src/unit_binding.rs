//! 单元身份来自 Cargo 图与实际 artifact；内容证据在成功编译后冻结。
use crate::{
    host::{Artifact, digest},
    report_cache::file_hash,
    unit_graph::{GraphBinding, UnitGraph, UnitQuery},
};
use analysis_contract::UnitReport;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    path::Path,
};

#[derive(Clone, Debug)]
pub(crate) struct BoundUnit {
    pub key: String,
    pub graph: GraphBinding,
}

#[derive(Debug)]
pub(crate) struct ResolutionFailure {
    pub artifacts: Vec<usize>,
    reason: String,
}

impl fmt::Display for ResolutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Cargo dependency-proof resolution failed for artifacts {:?}: {}",
            self.artifacts, self.reason
        )
    }
}

impl std::error::Error for ResolutionFailure {}

fn resolution_failure(artifacts: Vec<usize>, reason: impl Into<String>) -> anyhow::Error {
    ResolutionFailure {
        artifacts,
        reason: reason.into(),
    }
    .into()
}

pub(crate) fn report_key(unit_key: &str, test_harness: bool) -> String {
    digest(serde_json::to_vec(&json!({"unit":unit_key,"testHarness":test_harness})).unwrap())
}

pub(crate) fn environment_key(name: &str) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name.to_owned()
    }
}

fn environment_candidates(
    key: &str,
    scripts: Option<&Vec<Value>>,
    environment: &BTreeMap<String, String>,
) -> BTreeSet<Option<String>> {
    let parent = environment.get(key).map(|value| digest(value.as_bytes()));
    let Some(scripts) = scripts.filter(|scripts| !scripts.is_empty()) else {
        return BTreeSet::from([parent]);
    };
    scripts
        .iter()
        .map(|script| {
            let supplied = script["env"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .find_map(|pair| {
                    (pair[0]
                        .as_str()
                        .is_some_and(|name| environment_key(name) == key))
                    .then(|| pair[1].as_str())
                    .flatten()
                });
            supplied
                .or_else(|| {
                    (key == "OUT_DIR")
                        .then(|| script["out_dir"].as_str())
                        .flatten()
                })
                .map(|value| digest(value.as_bytes()))
                .or_else(|| parent.clone())
        })
        .collect()
}

pub(crate) fn candidates(artifacts: &[Artifact], graph: &UnitGraph) -> Result<Vec<Vec<BoundUnit>>> {
    artifacts
        .iter()
        .map(|artifact| {
            graph
                .candidates(&UnitQuery {
                    package: &artifact.package_id,
                    source: &artifact.target.source,
                    name: &artifact.target.name,
                    crate_types: &artifact.crate_types,
                    profile: &artifact.profile,
                    features: &artifact.features,
                    mode: &artifact.mode,
                })?
                .into_iter()
                .map(|graph| {
                    let key = digest(serde_json::to_vec(&json!({"package":artifact.package_id,"target":artifact.target,
                        "crateTypes":artifact.crate_types,"profile":artifact.profile,"features":artifact.features,
                        "mode":artifact.mode,"outputs":artifact.filenames,"graph":graph.class}))?);
                    Ok(BoundUnit { key, graph })
                })
                .collect()
        })
        .collect()
}

fn unique(candidates: Vec<Vec<BoundUnit>>) -> Result<Vec<BoundUnit>> {
    let uncertain: Vec<_> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidates)| candidates.len() != 1)
        .map(|(index, _)| index)
        .collect();
    if !uncertain.is_empty() {
        return Err(resolution_failure(
            uncertain,
            "Native inputs do not identify one dependency-proof class per artifact",
        ));
    }
    Ok(candidates
        .into_iter()
        .map(|mut candidates| candidates.pop().unwrap())
        .collect())
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct DependencyConstraint {
    producer: usize,
    extern_name: Option<String>,
}

struct DependencyEvidence {
    constraints: Vec<DependencyConstraint>,
    complete_extern_names: Option<BTreeSet<String>>,
}

fn producer(path: &str, outputs: &[&[String]], sysroot: &str) -> Result<Option<usize>> {
    if path.starts_with(&format!("{sysroot}/")) {
        return Ok(None);
    }
    let exact: Vec<_> = outputs
        .iter()
        .enumerate()
        .filter(|(_, paths)| paths.iter().any(|candidate| candidate == path))
        .map(|(index, _)| index)
        .collect();
    let owners = if exact.is_empty() {
        let path = Path::new(path);
        outputs
            .iter()
            .enumerate()
            .filter(|(_, paths)| {
                paths.iter().any(|candidate| {
                    let candidate = Path::new(candidate);
                    path.parent() == candidate.parent()
                        && path.file_stem() == candidate.file_stem()
                        && matches!(
                            (
                                path.extension().and_then(|value| value.to_str()),
                                candidate.extension().and_then(|value| value.to_str())
                            ),
                            (Some("rmeta"), Some("rlib")) | (Some("rlib"), Some("rmeta"))
                        )
                })
            })
            .map(|(index, _)| index)
            .collect()
    } else {
        exact
    };
    ensure!(
        owners.len() == 1,
        "Compiler dependency path does not have one current Cargo producer: {path} ({} owners)",
        owners.len()
    );
    Ok(Some(owners[0]))
}

fn dependency_constraints(
    report: &UnitReport,
    outputs: &[&[String]],
    sysroot: &str,
) -> Result<DependencyEvidence> {
    let mut constraints = BTreeSet::new();
    for path in &report.inputs.binary_paths {
        if let Some(producer) = producer(path, outputs, sysroot)? {
            constraints.insert(DependencyConstraint {
                producer,
                extern_name: None,
            });
        }
    }
    for external in &report.inputs.externs {
        for path in &external.paths {
            if let Some(producer) = producer(path, outputs, sysroot)? {
                constraints.insert(DependencyConstraint {
                    producer,
                    extern_name: Some(external.name.replace('-', "_")),
                });
            }
        }
    }
    Ok(DependencyEvidence {
        constraints: constraints.into_iter().collect(),
        complete_extern_names: report.inputs.complete.then(|| {
            report
                .inputs
                .externs
                .iter()
                .map(|external| external.name.replace('-', "_"))
                .collect()
        }),
    })
}

fn supports(
    candidate: &BoundUnit,
    evidence: &DependencyEvidence,
    domains: &[BTreeSet<String>],
    forced: Option<(usize, &str)>,
) -> bool {
    if let Some(names) = &evidence.complete_extern_names
        && !candidate.graph.required_rust_extern_names.is_subset(names)
    {
        return false;
    }
    evidence.constraints.iter().all(|constraint| {
        let allowed = match &constraint.extern_name {
            Some(name) => candidate.graph.direct_dependencies.get(name),
            None => Some(&candidate.graph.dependency_classes),
        };
        let Some(allowed) = allowed else {
            return false;
        };
        if let Some((producer, class)) = forced
            && producer == constraint.producer
        {
            allowed.contains(class)
        } else {
            domains[constraint.producer]
                .iter()
                .any(|class| allowed.contains(class))
        }
    })
}

fn resolve_with_outputs(
    outputs: &[&[String]],
    mut candidates: Vec<Vec<BoundUnit>>,
    reports: &[Vec<&UnitReport>],
    sysroot: &str,
) -> Result<Vec<BoundUnit>> {
    ensure!(
        candidates.len() == outputs.len() && candidates.len() == reports.len(),
        "Compiler evidence does not cover the Cargo artifact index"
    );
    let empty: Vec<_> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidates)| candidates.is_empty())
        .map(|(index, _)| index)
        .collect();
    if !empty.is_empty() {
        return Err(resolution_failure(empty, "Cargo candidates are empty"));
    }
    let mut evidence = Vec::new();
    let mut invalid_evidence = Vec::new();
    let mut invalid_details = Vec::new();
    let mut consumers = vec![BTreeSet::new(); candidates.len()];
    for (index, reports) in reports.iter().enumerate() {
        let mut alternatives = Vec::new();
        let mut errors = Vec::new();
        for report in reports.iter().filter(|report| report.inputs.complete) {
            match dependency_constraints(report, outputs, sysroot) {
                Ok(constraints) => {
                    for constraint in &constraints.constraints {
                        consumers[constraint.producer].insert(index);
                    }
                    alternatives.push(constraints);
                }
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        if alternatives.is_empty() && !errors.is_empty() {
            invalid_evidence.push(index);
            invalid_details.extend(errors);
        }
        evidence.push(alternatives);
    }
    if !invalid_evidence.is_empty() {
        return Err(resolution_failure(
            invalid_evidence,
            format!(
                "No valid native dependency evidence: {}",
                invalid_details.join("; ")
            ),
        ));
    }
    // 报告是完整的备选证据；不能把不同报告的部分路径拼成一次原生编译。
    loop {
        let domains: Vec<BTreeSet<_>> = candidates
            .iter()
            .map(|values| values.iter().map(|unit| unit.graph.class.clone()).collect())
            .collect();
        let mut keep = Vec::new();
        let mut changed = false;
        let mut native_unsupported = Vec::new();
        let mut unsupported = Vec::new();
        for (index, values) in candidates.iter().enumerate() {
            let own: Vec<_> = values
                .iter()
                .map(|candidate| {
                    evidence[index].is_empty()
                        || evidence[index]
                            .iter()
                            .any(|report| supports(candidate, report, &domains, None))
                })
                .collect();
            if !own.iter().any(|&value| value) {
                native_unsupported.push(index);
            }
            let supported: Vec<_> = values
                .iter()
                .zip(own)
                .map(|(candidate, own)| {
                    own && consumers[index].iter().all(|&consumer| {
                        candidates[consumer].iter().any(|parent| {
                            evidence[consumer].iter().any(|report| {
                                supports(
                                    parent,
                                    report,
                                    &domains,
                                    Some((index, &candidate.graph.class)),
                                )
                            })
                        })
                    })
                })
                .collect();
            if !supported.iter().any(|&value| value) {
                unsupported.push(index);
            }
            changed |= supported.iter().any(|&value| !value);
            keep.push(supported);
        }
        // 先定位实际报告与候选不符的 consumer，避免把反向约束牵连的健康 producer 一起恢复。
        if !native_unsupported.is_empty() {
            return Err(resolution_failure(
                native_unsupported,
                "No dependency-proof class is supported by the artifact's native inputs",
            ));
        }
        if !unsupported.is_empty() {
            return Err(resolution_failure(
                unsupported,
                "Native consumer constraints do not support a dependency-proof class",
            ));
        }
        for (values, keep) in candidates.iter_mut().zip(keep) {
            let mut index = 0;
            values.retain(|_| {
                let value = keep[index];
                index += 1;
                value
            });
        }
        if !changed {
            return unique(candidates);
        }
    }
}

pub(crate) fn resolve(
    artifacts: &[Artifact],
    candidates: Vec<Vec<BoundUnit>>,
    reports: &[Vec<&UnitReport>],
    sysroot: &Path,
) -> Result<Vec<BoundUnit>> {
    let outputs: Vec<_> = artifacts
        .iter()
        .map(|artifact| artifact.filenames.as_slice())
        .collect();
    resolve_with_outputs(
        &outputs,
        candidates,
        reports,
        &analysis_contract::normalized(sysroot)?,
    )
}

#[derive(Default)]
pub(crate) struct Hashes {
    values: BTreeMap<String, String>,
}
impl Hashes {
    pub(crate) fn get(&mut self, path: &str) -> Result<String> {
        if let Some(hash) = self.values.get(path) {
            return Ok(hash.clone());
        }
        let hash = file_hash(Path::new(path))
            .with_context(|| format!("Cannot fingerprint compilation input {path}"))?;
        self.values.insert(path.to_owned(), hash.clone());
        Ok(hash)
    }
    pub(crate) fn files(&mut self, paths: &[String]) -> Result<Value> {
        paths
            .iter()
            .map(|path| Ok((path.clone(), self.get(path)?)))
            .collect::<Result<BTreeMap<_, _>>>()
            .map(|value| json!(value))
    }
}

pub(crate) fn observe_inputs(
    index: usize,
    report: &UnitReport,
    artifacts: &[Artifact],
    unit: &BoundUnit,
    scripts: &BTreeMap<String, Vec<Value>>,
    sysroot: &Path,
    environment: &BTreeMap<String, String>,
    configured_environment: &std::collections::BTreeSet<String>,
    hashes: &mut Hashes,
) -> Result<Value> {
    ensure!(
        report.inputs.complete && !report.inputs.files.is_empty(),
        "Unit has incomplete compiler input evidence: {:?}",
        report.inputs.gaps
    );
    let artifact = &artifacts[index];
    for alias in &report.inputs.aliases {
        ensure!(
            analysis_contract::normalized(Path::new(&alias.path))? == alias.resolved,
            "Compiler file alias changed: {}",
            alias.path
        );
    }
    for probe in &report.inputs.probes {
        ensure!(
            Path::new(&probe.path).try_exists()? == probe.exists,
            "Compiler file resolution changed: {}",
            probe.path
        );
    }
    let own_scripts = scripts.get(&artifact.package_id);
    for input in &report.inputs.env {
        let key = environment_key(&input.name);
        // Cargo checks its injected variables through native env-dep freshness; the complete
        // package metadata, unit configuration and build-script messages are also bound below.
        if key.starts_with("CARGO_") || configured_environment.contains(&key) {
            continue;
        }
        // 同包的 host/target 脚本不能按数组顺序配对。保守绑定完整消息集，
        // 只检查实际观察值属于当前集合；任一脚本消息变化都会使下方 proof 失效。
        let actual = environment_candidates(&key, own_scripts, environment);
        ensure!(
            actual.contains(&input.value_sha256),
            "Compiler environment changed after analysis: {}",
            input.name
        );
    }
    for source in &report.inputs.files {
        ensure!(
            hashes.get(&source.path)? == source.sha256,
            "Compiler source changed after analysis: {}",
            source.path
        );
    }
    let dep_info = report
        .inputs
        .dep_info
        .as_ref()
        .context("Missing native dep-info")?;
    ensure!(
        hashes.get(&dep_info.path)? == dep_info.sha256,
        "Compiler dep-info changed after analysis"
    );
    let sysroot = analysis_contract::normalized(sysroot)?;
    let outputs: Vec<_> = artifacts
        .iter()
        .map(|artifact| artifact.filenames.as_slice())
        .collect();
    dependency_constraints(report, &outputs, &sysroot)?;
    let mut build_scripts = BTreeMap::new();
    for package in &unit.graph.build_script_packages {
        let values = scripts
            .get(package)
            .context("Missing Cargo build-script output proof")?;
        build_scripts.insert(package, digest(serde_json::to_vec(values)?));
    }
    Ok(
        json!({"schemaVersion":2,"unit":unit.key,"graph":unit.graph.class,"packageMetadata":artifact.metadata,
        "artifact":hashes.files(&artifact.filenames)?,"buildScripts":build_scripts,
        "inputs":report.inputs,"binaries":hashes.files(&report.inputs.binary_paths)?,
        "outputs":hashes.files(&report.inputs.outputs)?}),
    )
}

pub(crate) fn precheck_cached(
    index: usize,
    report: &UnitReport,
    cached_proof: &Value,
    artifacts: &[Artifact],
    candidate: &BoundUnit,
    scripts: &BTreeMap<String, Vec<Value>>,
    sysroot: &Path,
    environment: &BTreeMap<String, String>,
    configured_environment: &BTreeSet<String>,
    hashes: &mut Hashes,
) -> Result<()> {
    let actual = observe_inputs(
        index,
        report,
        artifacts,
        candidate,
        scripts,
        sysroot,
        environment,
        configured_environment,
        hashes,
    )?;
    // 这里只核验不依赖全局单元选择的输入；宿主选定所有 class 后仍须比较完整 proof。
    for field in [
        "schemaVersion",
        "unit",
        "graph",
        "packageMetadata",
        "artifact",
        "buildScripts",
        "inputs",
        "binaries",
        "outputs",
    ] {
        ensure!(
            actual[field] == cached_proof[field],
            "Cached compiler input proof changed before dependency binding: {field}"
        );
    }
    Ok(())
}

pub(crate) fn proof(
    index: usize,
    report: &UnitReport,
    artifacts: &[Artifact],
    bound: &[BoundUnit],
    scripts: &BTreeMap<String, Vec<Value>>,
    sysroot: &Path,
    environment: &BTreeMap<String, String>,
    configured_environment: &BTreeSet<String>,
    hashes: &mut Hashes,
) -> Result<Value> {
    let unit = &bound[index];
    let mut value = observe_inputs(
        index,
        report,
        artifacts,
        unit,
        scripts,
        sysroot,
        environment,
        configured_environment,
        hashes,
    )?;
    let outputs: Vec<_> = artifacts
        .iter()
        .map(|artifact| artifact.filenames.as_slice())
        .collect();
    let constraints =
        dependency_constraints(report, &outputs, &analysis_contract::normalized(sysroot)?)?;
    let domains = bound
        .iter()
        .map(|binding| BTreeSet::from([binding.graph.class.clone()]))
        .collect::<Vec<_>>();
    ensure!(
        supports(unit, &constraints, &domains, None),
        "Native compiler dependencies do not match the selected Cargo proof class"
    );
    let mut dependencies = BTreeMap::new();
    for (other, binding) in artifacts.iter().zip(bound) {
        if unit.graph.dependency_classes.contains(&binding.graph.class) {
            dependencies.insert(binding.key.clone(), hashes.files(&other.filenames)?);
        }
    }
    value["dependencies"] = json!(dependencies);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bound(class: &str, dependencies: &[&str], direct: &[(&str, &str)]) -> BoundUnit {
        let mut direct_dependencies = BTreeMap::<String, BTreeSet<String>>::new();
        for &(name, class) in direct {
            direct_dependencies
                .entry(name.into())
                .or_default()
                .insert(class.into());
        }
        BoundUnit {
            key: format!("key-{class}"),
            graph: GraphBinding {
                class: class.into(),
                direct_dependencies,
                required_rust_extern_names: BTreeSet::new(),
                dependency_classes: dependencies.iter().map(|class| (*class).into()).collect(),
                build_script_packages: BTreeSet::new(),
            },
        }
    }

    fn report(binaries: &[&str], externs: &[(&str, &str)]) -> UnitReport {
        use analysis_contract::{
            ANALYSIS_SCHEMA_VERSION, ExternInput, Rule, UnitInputs, entity_names, named_fields,
        };
        UnitReport {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            rule: Rule::Architecture,
            analyzed: true,
            run: "producer".into(),
            configuration: "stable".into(),
            compiler: "pinned".into(),
            target: named_fields::Target {
                source: "/root/lib.rs".into(),
                name: "root".into(),
                test: false,
            },
            manifest_dir: "/root".into(),
            package: "root".into(),
            artifact_tag: "-actual".into(),
            crate_types: vec!["lib".into()],
            inputs: UnitInputs {
                complete: true,
                binary_paths: binaries.iter().map(|path| (*path).into()).collect(),
                externs: externs
                    .iter()
                    .map(|&(name, path)| ExternInput {
                        name: name.into(),
                        paths: vec![path.into()],
                        private: false,
                        add_prelude: true,
                        nounused: false,
                        force: false,
                        search_path: false,
                    })
                    .collect(),
                ..Default::default()
            },
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: None,
            failure: None,
        }
    }

    fn output(path: &str) -> Vec<String> {
        vec![path.into()]
    }

    fn requiring(mut unit: BoundUnit, names: &[&str]) -> BoundUnit {
        unit.graph.required_rust_extern_names = names.iter().map(|name| (*name).into()).collect();
        unit
    }

    #[test]
    fn complete_extern_tables_distinguish_normal_and_test_superset_classes() {
        let outputs = [
            output("/deps/libroot-normal.rlib"),
            output("/deps/libroot-test.rlib"),
            output("/deps/libcontract.rlib"),
            output("/deps/librunner.rlib"),
        ];
        let variants = vec![
            requiring(
                bound("normal", &["contract"], &[("fixture_contract", "contract")]),
                &["fixture_contract"],
            ),
            requiring(
                bound(
                    "test",
                    &["contract", "runner"],
                    &[
                        ("fixture_contract", "contract"),
                        ("fixture_runner", "runner"),
                    ],
                ),
                &["fixture_contract", "fixture_runner"],
            ),
        ];
        let candidates = vec![
            variants.clone(),
            variants,
            vec![bound("contract", &[], &[])],
            vec![bound("runner", &[], &[])],
        ];
        let normal = report(
            &["/deps/libcontract.rmeta"],
            &[("fixture_contract", "/deps/libcontract.rlib")],
        );
        let mut test = report(
            &["/deps/libcontract.rmeta"],
            &[
                ("fixture_contract", "/deps/libcontract.rlib"),
                ("fixture_runner", "/deps/librunner.rlib"),
            ],
        );
        // 未使用的 --extern 仍在原生完整表中；不能只从已加载 metadata 推断它不存在。
        assert!(
            !test
                .inputs
                .binary_paths
                .iter()
                .any(|path| path.contains("runner"))
        );
        let mut builtin = test.inputs.externs[0].clone();
        builtin.name = "proc_macro".into();
        builtin.paths.clear();
        test.inputs.externs.push(builtin);
        for reverse in [false, true] {
            let mut choices = candidates.clone();
            if reverse {
                for alternatives in &mut choices {
                    alternatives.reverse();
                }
            }
            let selected = resolve_with_outputs(
                &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                choices,
                &[vec![&normal], vec![&test], vec![], vec![]],
                "/sysroot",
            )
            .unwrap();
            assert_eq!(selected[0].graph.class, "normal");
            assert_eq!(selected[1].graph.class, "test");
        }
    }

    #[test]
    fn incomplete_extern_tables_cannot_exclude_a_dependency_superset() {
        let outputs = [
            output("/deps/libroot.rlib"),
            output("/deps/libcontract.rlib"),
            output("/deps/librunner.rlib"),
        ];
        let normal = requiring(
            bound("normal", &["contract"], &[("contract", "contract")]),
            &["contract"],
        );
        let test = requiring(
            bound(
                "test",
                &["contract", "runner"],
                &[("contract", "contract"), ("runner", "runner")],
            ),
            &["contract", "runner"],
        );
        let mut partial = report(
            &["/deps/libcontract.rmeta"],
            &[("contract", "/deps/libcontract.rlib")],
        );
        partial.inputs.complete = false;
        let paths = outputs.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let evidence = dependency_constraints(&partial, &paths, "/sysroot").unwrap();
        assert!(evidence.complete_extern_names.is_none());
        let domains = [
            BTreeSet::from(["normal".into(), "test".into()]),
            BTreeSet::from(["contract".into()]),
            BTreeSet::from(["runner".into()]),
        ];
        assert!(supports(&normal, &evidence, &domains, None));
        assert!(supports(&test, &evidence, &domains, None));
        let candidates = vec![
            vec![normal, test.clone()],
            vec![bound("contract", &[], &[])],
            vec![bound("runner", &[], &[])],
        ];
        assert!(
            resolve_with_outputs(
                &paths,
                candidates,
                &[vec![&partial], vec![], vec![]],
                "/sysroot",
            )
            .is_err()
        );
        partial.inputs.complete = true;
        let evidence = dependency_constraints(&partial, &paths, "/sysroot").unwrap();
        assert!(evidence.complete_extern_names.is_some());
        // 最终 proof 使用相同 supports；精确选择以后也不能忽略缺失的 required extern。
        assert!(!supports(&test, &evidence, &domains, None));
    }

    #[test]
    fn required_extern_coverage_cannot_be_merged_across_report_alternatives() {
        let outputs = [
            output("/deps/libroot.rlib"),
            output("/deps/liba.rlib"),
            output("/deps/libb.rlib"),
        ];
        let candidates = vec![
            vec![requiring(
                bound("root", &["a", "b"], &[("a", "a"), ("b", "b")]),
                &["a", "b"],
            )],
            vec![bound("a", &[], &[])],
            vec![bound("b", &[], &[])],
        ];
        let first = report(&[], &[("a", "/deps/liba.rlib")]);
        let second = report(&[], &[("b", "/deps/libb.rlib")]);
        let paths = outputs.iter().map(Vec::as_slice).collect::<Vec<_>>();
        for alternatives in [vec![&first, &second], vec![&second, &first]] {
            assert!(
                resolve_with_outputs(
                    &paths,
                    candidates.clone(),
                    &[alternatives, vec![], vec![]],
                    "/sysroot",
                )
                .is_err()
            );
        }
        let whole = report(&[], &[("a", "/deps/liba.rlib"), ("b", "/deps/libb.rlib")]);
        assert!(
            resolve_with_outputs(
                &paths,
                candidates,
                &[vec![&first, &whole, &second], vec![], vec![]],
                "/sysroot",
            )
            .is_ok()
        );
    }

    #[test]
    fn actual_metadata_paths_distinguish_equal_own_units_without_order_pairing() {
        let outputs = vec![
            output("/deps/libroot-x.rlib"),
            output("/deps/libroot-y.rlib"),
            output("/deps/libdep-a.rlib"),
            output("/deps/libdep-b.rlib"),
        ];
        let variants = vec![
            bound("root-a", &["dep-a"], &[("dep", "dep-a")]),
            bound("root-b", &["dep-b"], &[("dep", "dep-b")]),
        ];
        let candidates = vec![
            variants.clone(),
            variants,
            vec![bound("dep-a", &[], &[])],
            vec![bound("dep-b", &[], &[])],
        ];
        let first = report(&["/deps/libdep-b.rmeta"], &[("dep", "/deps/libdep-b.rlib")]);
        let second = report(&["/deps/libdep-a.rmeta"], &[("dep", "/deps/libdep-a.rlib")]);
        let reports = vec![vec![&first], vec![&second], vec![], vec![]];
        let selected = resolve_with_outputs(
            &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            candidates.clone(),
            &reports,
            "/sysroot",
        )
        .unwrap();
        assert_eq!(selected[0].graph.class, "root-b");
        assert_eq!(selected[1].graph.class, "root-a");
        let mut reversed_outputs = outputs.clone();
        reversed_outputs.reverse();
        let mut reversed_candidates = candidates;
        reversed_candidates.reverse();
        for choices in &mut reversed_candidates {
            choices.reverse();
        }
        let mut reversed_reports = reports;
        reversed_reports.reverse();
        let mut reversed = resolve_with_outputs(
            &reversed_outputs
                .iter()
                .map(Vec::as_slice)
                .collect::<Vec<_>>(),
            reversed_candidates,
            &reversed_reports,
            "/sysroot",
        )
        .unwrap();
        reversed.reverse();
        assert_eq!(
            selected
                .iter()
                .map(|unit| &unit.graph.class)
                .collect::<Vec<_>>(),
            reversed
                .iter()
                .map(|unit| &unit.graph.class)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn dependency_constraints_propagate_backwards_to_a_fixed_point() {
        let outputs = [
            output("/deps/libroot.rlib"),
            output("/deps/libmiddle.rlib"),
            output("/deps/libleaf.rlib"),
        ];
        let candidates = vec![
            vec![bound(
                "root",
                &["middle-a", "leaf-a"],
                &[("middle", "middle-a")],
            )],
            vec![
                bound("middle-a", &["leaf-a"], &[("leaf", "leaf-a")]),
                bound("middle-b", &["leaf-b"], &[("leaf", "leaf-b")]),
            ],
            vec![bound("leaf-a", &[], &[]), bound("leaf-b", &[], &[])],
        ];
        let root = report(
            &["/deps/libmiddle.rmeta"],
            &[("middle", "/deps/libmiddle.rlib")],
        );
        let middle = report(&["/deps/libleaf.rmeta"], &[("leaf", "/deps/libleaf.rlib")]);
        let selected = resolve_with_outputs(
            &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            candidates,
            &[vec![&root], vec![&middle], vec![]],
            "/sysroot",
        )
        .unwrap();
        assert_eq!(selected[1].graph.class, "middle-a");
        assert_eq!(selected[2].graph.class, "leaf-a");
    }

    #[test]
    fn named_externs_constrain_direct_edges_even_when_both_variants_are_transitive() {
        let outputs = [
            output("/deps/libroot.rlib"),
            output("/deps/libdep-a.rlib"),
            output("/deps/libdep-b.rlib"),
        ];
        let candidates = vec![
            vec![
                bound("root-a", &["dep-a", "dep-b"], &[("renamed", "dep-a")]),
                bound("root-b", &["dep-a", "dep-b"], &[("renamed", "dep-b")]),
            ],
            vec![bound("dep-a", &[], &[])],
            vec![bound("dep-b", &[], &[])],
        ];
        let renamed = report(
            &["/deps/libdep-a.rmeta", "/sysroot/lib/libstd.rlib"],
            &[("renamed", "/deps/libdep-a.rlib")],
        );
        let selected = resolve_with_outputs(
            &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            candidates.clone(),
            &[vec![&renamed], vec![], vec![]],
            "/sysroot",
        )
        .unwrap();
        assert_eq!(selected[0].graph.class, "root-a");
        let wrong_name = report(
            &["/deps/libdep-a.rmeta"],
            &[("wrong", "/deps/libdep-a.rlib")],
        );
        assert!(
            resolve_with_outputs(
                &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                candidates,
                &[vec![&wrong_name], vec![], vec![]],
                "/sysroot"
            )
            .is_err()
        );
    }

    #[test]
    fn report_alternatives_never_supply_a_partial_combined_proof() {
        let outputs = [
            output("/deps/libroot.rlib"),
            output("/deps/liba.rlib"),
            output("/deps/libb.rlib"),
            output("/deps/libc.rlib"),
            output("/deps/libd.rlib"),
        ];
        let candidates = vec![
            vec![bound("root", &["a", "d"], &[])],
            vec![bound("a", &[], &[])],
            vec![bound("b", &[], &[])],
            vec![bound("c", &[], &[])],
            vec![bound("d", &[], &[])],
        ];
        let first = report(&["/deps/liba.rmeta", "/deps/libb.rmeta"], &[]);
        let second = report(&["/deps/libc.rmeta", "/deps/libd.rmeta"], &[]);
        assert!(
            resolve_with_outputs(
                &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                candidates,
                &[vec![&first, &second], vec![], vec![], vec![], vec![]],
                "/sysroot"
            )
            .is_err()
        );
        let outputs = [
            output("/deps/libroot.rlib"),
            output("/deps/liba.rlib"),
            output("/deps/libb.rlib"),
        ];
        let choices = vec![
            vec![bound("root-a", &["a"], &[]), bound("root-b", &["b"], &[])],
            vec![bound("a", &[], &[])],
            vec![bound("b", &[], &[])],
        ];
        let first = report(&["/deps/liba.rmeta"], &[]);
        let second = report(&["/deps/libb.rmeta"], &[]);
        for reports in [vec![&first, &second], vec![&second, &first]] {
            assert!(
                resolve_with_outputs(
                    &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                    choices.clone(),
                    &[reports, vec![], vec![]],
                    "/sysroot"
                )
                .is_err()
            );
        }
    }

    #[test]
    fn missing_evidence_or_ambiguous_and_stale_producers_fail_closed() {
        let outputs = [output("/deps/libroot.rlib"), output("/deps/libdep.rlib")];
        let candidates = vec![
            vec![bound("root-a", &["dep"], &[]), bound("root-b", &[], &[])],
            vec![bound("dep", &[], &[])],
        ];
        assert!(
            resolve_with_outputs(
                &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                candidates.clone(),
                &[vec![], vec![]],
                "/sysroot"
            )
            .is_err()
        );
        for path in [
            "/old/libdep.rmeta",
            "/deps/libmissing.rmeta",
            "/deps/libdep.pdb",
        ] {
            let stale = report(&[path], &[]);
            assert!(
                resolve_with_outputs(
                    &outputs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                    candidates.clone(),
                    &[vec![&stale], vec![]],
                    "/sysroot"
                )
                .is_err()
            );
        }
        let duplicate = [output("/deps/libdep.rlib"), output("/deps/libdep.rlib")];
        assert!(
            producer(
                "/deps/libdep.rmeta",
                &duplicate.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                "/sysroot"
            )
            .is_err()
        );
    }

    #[test]
    fn resolution_failures_identify_only_the_artifacts_needing_recovery() {
        let outputs = [
            output("/deps/libfirst.rlib"),
            output("/deps/libproducer.rlib"),
            output("/deps/libsecond.rlib"),
        ];
        let outputs = outputs.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let failed = |choices, reports: Vec<Vec<&UnitReport>>| {
            let error = resolve_with_outputs(&outputs, choices, &reports, "/sysroot")
                .unwrap_err()
                .context("Host recovery preserves the typed resolution cause");
            error
                .downcast_ref::<ResolutionFailure>()
                .expect("Resolution errors must retain exact artifact indices")
                .artifacts
                .clone()
        };
        let native = report(
            &["/deps/libproducer.rmeta"],
            &[("dep", "/deps/libproducer.rlib")],
        );
        let inconsistent = vec![
            vec![bound("first", &["wrong"], &[("dep", "wrong")])],
            vec![bound("producer", &[], &[])],
            vec![bound("second", &[], &[])],
        ];
        assert_eq!(
            failed(inconsistent.clone(), vec![vec![&native], vec![], vec![]]),
            [0],
            "A bad consumer must not recover its otherwise healthy producer"
        );
        assert_eq!(
            failed(
                inconsistent.clone(),
                vec![vec![&native], vec![], vec![&native]]
            ),
            [0, 2]
        );
        let mut empty = inconsistent.clone();
        empty[1].clear();
        assert_eq!(failed(empty, vec![vec![], vec![], vec![]]), [1]);
        let mut ambiguous = inconsistent.clone();
        ambiguous[0].push(bound("first-other", &[], &[]));
        ambiguous[2].push(bound("second-other", &[], &[]));
        assert_eq!(failed(ambiguous, vec![vec![], vec![], vec![]]), [0, 2]);
        let stale = report(&["/old/libproducer.rmeta"], &[]);
        assert_eq!(
            failed(inconsistent, vec![vec![], vec![], vec![&stale]]),
            [2]
        );
        let contradictory_consumers = vec![
            vec![bound("first", &["producer-a"], &[("dep", "producer-a")])],
            vec![bound("producer-a", &[], &[]), bound("producer-b", &[], &[])],
            vec![bound("second", &["producer-b"], &[("dep", "producer-b")])],
        ];
        assert_eq!(
            failed(
                contradictory_consumers,
                vec![vec![&native], vec![], vec![&native]]
            ),
            [1],
            "Mutually incompatible consumer requirements identify the constrained producer"
        );
    }

    #[test]
    fn script_environment_candidates_preserve_host_target_and_parent_fallbacks() {
        let parent = BTreeMap::from([("VALUE".into(), "parent".into())]);
        let scripts = vec![
            json!({"out_dir":"host","env":[["VALUE","host-value"]]}),
            json!({"out_dir":"target","env":[]}),
        ];
        assert_eq!(
            environment_candidates("VALUE", Some(&scripts), &parent),
            BTreeSet::from([Some(digest("host-value")), Some(digest("parent"))])
        );
        assert_eq!(
            environment_candidates("OUT_DIR", Some(&scripts), &parent),
            BTreeSet::from([Some(digest("host")), Some(digest("target"))])
        );
        assert_eq!(
            environment_candidates("ABSENT", None, &parent),
            BTreeSet::from([None])
        );
        let mut reversed = scripts.clone();
        reversed.reverse();
        assert_eq!(
            environment_candidates("OUT_DIR", Some(&scripts), &parent),
            environment_candidates("OUT_DIR", Some(&reversed), &parent)
        );
    }
}
