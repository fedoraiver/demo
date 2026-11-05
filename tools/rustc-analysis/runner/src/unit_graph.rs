//! Cargo 原生图只提供依赖证明；实际 test harness 仍由编译产物和 rustc 报告区分。
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}

fn strings(value: &Value) -> BTreeSet<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

#[derive(Clone)]
pub(crate) struct UnitGraph {
    units: Vec<Value>,
    classes: Vec<String>,
}

pub(crate) struct UnitQuery<'a> {
    pub package: &'a str,
    pub source: &'a str,
    pub name: &'a str,
    pub crate_types: &'a [String],
    pub profile: &'a Value,
    pub features: &'a [String],
    pub mode: &'a str,
}

#[derive(Clone, Debug)]
pub(crate) struct GraphBinding {
    pub class: String,
    pub direct_dependencies: BTreeMap<String, BTreeSet<String>>,
    pub required_rust_extern_names: BTreeSet<String>,
    pub dependency_classes: BTreeSet<String>,
    pub build_script_packages: BTreeSet<String>,
}

fn requires_rust_extern(unit: &Value) -> Result<bool> {
    if unit["mode"] == "run-custom-build" {
        return Ok(false);
    }
    let kinds = unit["target"]["kind"]
        .as_array()
        .context("Missing Cargo dependency target kind")?
        .iter()
        .map(|kind| {
            kind.as_str()
                .context("Invalid Cargo dependency target kind")
        })
        .collect::<Result<Vec<_>>>()?;
    // Cargo 的 Target::is_linkable 只接受 Lib；即便 ExampleLib 产出 rlib 也不是 Rust extern。
    if kinds.len() == 1
        && matches!(
            kinds[0],
            "bin" | "example" | "test" | "bench" | "custom-build"
        )
    {
        return Ok(false);
    }
    ensure!(
        !kinds.is_empty()
            && kinds.iter().all(|kind| matches!(
                *kind,
                "lib" | "rlib" | "dylib" | "proc-macro" | "cdylib" | "staticlib"
            )),
        "Unsupported Cargo dependency target kind for Rust extern proof: {kinds:?}"
    );
    match unit["mode"].as_str() {
        Some("build" | "check") => {}
        Some("doc" | "doctest" | "docscrape" | "test" | "bench") => return Ok(false),
        mode => anyhow::bail!("Unsupported Cargo dependency mode for Rust extern proof: {mode:?}"),
    }
    let types = unit["target"]["crate_types"]
        .as_array()
        .context("Missing Cargo dependency crate types")?
        .iter()
        .map(|kind| kind.as_str().context("Invalid Cargo dependency crate type"))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !types.is_empty()
            && types.iter().all(|kind| matches!(
                *kind,
                "lib" | "rlib" | "dylib" | "proc-macro" | "cdylib" | "staticlib"
            )),
        "Unsupported Cargo dependency crate type for Rust extern proof: {types:?}"
    );
    // Cargo 将 artifact cdylib/staticlib 拆成独立单类型 unit，通过脚本环境提供它们。
    Ok(types
        .iter()
        .any(|kind| matches!(*kind, "lib" | "rlib" | "dylib" | "proc-macro")))
}

impl UnitGraph {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let graph: Value = serde_json::from_slice(bytes).context("Invalid Cargo unit graph")?;
        ensure!(
            graph["version"] == 1,
            "Unsupported Cargo unit graph version"
        );
        let units = graph["units"]
            .as_array()
            .context("Missing Cargo units")?
            .clone();
        let mut hashes = vec![None; units.len()];
        let mut active = BTreeSet::new();
        fn visit(
            index: usize,
            units: &[Value],
            hashes: &mut [Option<String>],
            active: &mut BTreeSet<usize>,
        ) -> Result<String> {
            if let Some(hash) = hashes.get(index).and_then(Clone::clone) {
                return Ok(hash);
            }
            ensure!(active.insert(index), "Cyclic Cargo unit graph");
            let mut unit = units
                .get(index)
                .context("Cargo dependency index is outside its graph")?
                .clone();
            ensure!(
                unit["pkg_id"].is_string()
                    && unit["target"].is_object()
                    && unit["profile"].is_object()
                    && unit["mode"].is_string()
                    && unit["features"].is_array(),
                "Incomplete Cargo unit"
            );
            let dependencies = unit["dependencies"]
                .as_array()
                .context("Missing Cargo unit dependencies")?
                .clone();
            let mut edges = Vec::new();
            for mut edge in dependencies {
                let child = edge["index"]
                    .as_u64()
                    .context("Missing Cargo dependency index")?
                    as usize;
                let hash = visit(child, units, hashes, active)?;
                edge.as_object_mut()
                    .context("Invalid Cargo dependency")?
                    .remove("index");
                edge["unit"] = Value::String(hash);
                edges.push(edge);
            }
            edges.sort_by_key(|value| serde_json::to_string(value).unwrap());
            unit["dependencies"] = Value::Array(edges);
            unit["features"] = json!(strings(&unit["features"]));
            for field in ["kind", "crate_types"] {
                unit["target"][field] = json!(strings(&unit["target"][field]));
            }
            if let Some(source) = unit["target"]["src_path"].as_str() {
                unit["target"]["src_path"] = json!(source.replace('\\', "/"));
            }
            let hash = digest(&unit);
            hashes[index] = Some(hash.clone());
            active.remove(&index);
            Ok(hash)
        }
        for index in 0..units.len() {
            visit(index, &units, &mut hashes, &mut active)?;
        }
        Ok(Self {
            units,
            classes: hashes.into_iter().map(Option::unwrap).collect(),
        })
    }

    fn matches(unit: &Value, query: &UnitQuery<'_>) -> bool {
        let same_source = |value: &str| {
            let source = query.source.replace('\\', "/");
            value.replace('\\', "/") == source
                // Cargo 可保留 package.build 的 `../`；宿主和 rustc 报告已绑定真实文件。
                // 仅用规范路径补足同一文件匹配，不按文件名猜测或合并图节点。
                || analysis_contract::normalized(std::path::Path::new(value))
                    .is_ok_and(|value| value == source)
        };
        if unit["pkg_id"].as_str() != Some(query.package)
            || !unit["target"]["src_path"].as_str().is_some_and(same_source)
            || unit["target"]["name"]
                .as_str()
                .map(|value| value.replace('-', "_"))
                != Some(query.name.to_owned())
            || strings(&unit["target"]["crate_types"])
                != query.crate_types.iter().map(String::as_str).collect()
            || strings(&unit["features"]) != query.features.iter().map(String::as_str).collect()
            || unit["mode"].as_str() != Some(query.mode)
        {
            return false;
        }
        // Cargo profile.test、目标支持测试标记与 rustc 实际 harness 分别保存；
        // 原生图仅提供依赖证明，不能据这些字段推断报告的 harness。
        [
            "opt_level",
            "debuginfo",
            "debug_assertions",
            "overflow_checks",
        ]
        .into_iter()
        .all(|field| {
            query
                .profile
                .get(field)
                .is_none_or(|value| unit["profile"].get(field) == Some(value))
        })
    }

    fn class_binding(&self, class: String, candidates: Vec<usize>) -> Result<GraphBinding> {
        let mut direct_dependencies = BTreeMap::<String, BTreeSet<String>>::new();
        let mut required_rust_extern_names = BTreeSet::new();
        for &index in &candidates {
            for edge in self.units[index]["dependencies"]
                .as_array()
                .context("Missing Cargo dependencies")?
            {
                let child = edge["index"].as_u64().context("Missing dependency index")? as usize;
                if requires_rust_extern(&self.units[child])? {
                    let name = edge["extern_crate_name"]
                        .as_str()
                        .context("Missing Rust extern name in Cargo dependency proof")?;
                    required_rust_extern_names.insert(name.replace('-', "_"));
                }
                if let Some(name) = edge["extern_crate_name"].as_str() {
                    direct_dependencies
                        .entry(name.replace('-', "_"))
                        .or_default()
                        .insert(self.classes[child].clone());
                }
            }
        }
        let mut pending = candidates;
        let mut seen = BTreeSet::new();
        let mut dependency_classes = BTreeSet::new();
        let mut build_script_packages = BTreeSet::new();
        while let Some(index) = pending.pop() {
            if !seen.insert(index) {
                continue;
            }
            let unit = &self.units[index];
            if unit["mode"] == "run-custom-build" {
                build_script_packages.insert(
                    unit["pkg_id"]
                        .as_str()
                        .context("Missing build-script package")?
                        .to_owned(),
                );
            }
            for edge in unit["dependencies"]
                .as_array()
                .context("Missing Cargo dependencies")?
            {
                let child = edge["index"].as_u64().context("Missing dependency index")? as usize;
                dependency_classes.insert(self.classes[child].clone());
                pending.push(child);
            }
        }
        Ok(GraphBinding {
            class,
            direct_dependencies,
            required_rust_extern_names,
            dependency_classes,
            build_script_packages,
        })
    }

    pub fn candidates(&self, query: &UnitQuery<'_>) -> Result<Vec<GraphBinding>> {
        let mut classes = BTreeMap::<String, Vec<usize>>::new();
        for (index, unit) in self.units.iter().enumerate() {
            if Self::matches(unit, query) {
                classes
                    .entry(self.classes[index].clone())
                    .or_default()
                    .push(index);
            }
        }
        ensure!(
            !classes.is_empty(),
            "Cargo artifact has no dependency-proof candidate: {} {}",
            query.package,
            query.name
        );
        classes
            .into_iter()
            .map(|(class, indices)| self.class_binding(class, indices))
            .collect()
    }

    #[cfg(test)]
    pub fn binding(&self, query: &UnitQuery<'_>) -> Result<GraphBinding> {
        let mut candidates = self.candidates(query)?;
        ensure!(
            candidates.len() == 1,
            "Cargo artifact does not have one dependency-proof class: {} {} ({} classes)",
            query.package,
            query.name,
            candidates.len()
        );
        Ok(candidates.pop().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(package: &str, dependencies: Value) -> Value {
        json!({"pkg_id":package,"target":{"name":package,"src_path":format!("/{package}/src/lib.rs"),"crate_types":["lib"],"kind":["lib"],"test":true},"profile":{"opt_level":"1","debuginfo":0,"debug_assertions":true,"overflow_checks":true},"mode":"check","platform":null,"features":[],"dependencies":dependencies})
    }
    fn query() -> UnitQuery<'static> {
        UnitQuery {
            package: "root",
            source: "/root/src/lib.rs",
            name: "root",
            crate_types: &[],
            profile: &Value::Null,
            features: &[],
            mode: "check",
        }
    }
    #[test]
    fn graph_order_and_duplicate_projection_do_not_choose_a_harness() {
        let graph = json!({"version":1,"units":[unit("dep",json!([])),unit("root",json!([{"index":0,"extern_crate_name":"dep"}])),unit("root",json!([{"index":0,"extern_crate_name":"dep"}]))],"roots":[1,2]});
        let types = vec!["lib".to_owned()];
        let q = UnitQuery {
            crate_types: &types,
            ..query()
        };
        let first = UnitGraph::parse(&serde_json::to_vec(&graph).unwrap())
            .unwrap()
            .binding(&q)
            .unwrap();
        let reordered = json!({"version":1,"units":[unit("root",json!([{"index":1,"extern_crate_name":"dep"}])),unit("dep",json!([])),unit("root",json!([{"index":1,"extern_crate_name":"dep"}]))],"roots":[2,0]});
        let second = UnitGraph::parse(&serde_json::to_vec(&reordered).unwrap())
            .unwrap()
            .binding(&q)
            .unwrap();
        assert_eq!(first.class, second.class);
        assert_eq!(first.dependency_classes, second.dependency_classes);
    }
    #[test]
    fn non_equivalent_candidate_closures_are_rejected() {
        let graph = json!({"version":1,"units":[unit("dep",json!([])),unit("root",json!([])),unit("root",json!([{"index":0,"extern_crate_name":"dep"}]))]});
        let types = vec!["lib".to_owned()];
        let q = UnitQuery {
            crate_types: &types,
            ..query()
        };
        assert!(
            UnitGraph::parse(&serde_json::to_vec(&graph).unwrap())
                .unwrap()
                .binding(&q)
                .is_err()
        );
    }
    #[test]
    fn candidates_preserve_dependency_variants_and_exact_renamed_edges() {
        let first = unit("dep", json!([]));
        let mut second = first.clone();
        second["features"] = json!(["second"]);
        let parent = |index| {
            unit(
                "root",
                json!([{"index":index,"extern_crate_name":"renamed_dep"}]),
            )
        };
        let graph = UnitGraph::parse(
            &serde_json::to_vec(
                &json!({"version":1,"units":[first,second,parent(0),parent(1),parent(0)]}),
            )
            .unwrap(),
        )
        .unwrap();
        let types = vec!["lib".to_owned()];
        let candidates = graph
            .candidates(&UnitQuery {
                crate_types: &types,
                ..query()
            })
            .unwrap();
        assert_eq!(
            candidates.len(),
            2,
            "Equivalent projections alone are merged"
        );
        for candidate in candidates {
            assert_eq!(candidate.dependency_classes.len(), 1);
            assert_eq!(candidate.direct_dependencies.len(), 1);
            assert_eq!(
                candidate.direct_dependencies["renamed_dep"],
                candidate.dependency_classes
            );
        }
    }

    #[test]
    fn required_extern_names_match_rust_libraries_and_split_artifacts() {
        let dependency = |name: &str, kind: Value, types: Value, mode: &str| {
            let mut value = unit(name, json!([]));
            value["target"]["kind"] = kind;
            value["target"]["crate_types"] = types;
            value["mode"] = json!(mode);
            value
        };
        let children = vec![
            dependency("plain", json!(["lib"]), json!(["lib"]), "check"),
            dependency("explicit", json!(["rlib"]), json!(["rlib"]), "build"),
            dependency("dynamic", json!(["dylib"]), json!(["dylib"]), "build"),
            dependency(
                "macro",
                json!(["proc-macro"]),
                json!(["proc-macro"]),
                "build",
            ),
            dependency(
                "mixed",
                json!(["rlib", "cdylib"]),
                json!(["rlib", "cdylib"]),
                "build",
            ),
            dependency(
                "artifact_dynamic",
                json!(["cdylib"]),
                json!(["cdylib"]),
                "build",
            ),
            dependency(
                "artifact_static",
                json!(["staticlib"]),
                json!(["staticlib"]),
                "build",
            ),
            dependency("artifact_binary", json!(["bin"]), json!(["bin"]), "build"),
            dependency(
                "build_script",
                json!(["custom-build"]),
                json!(["bin"]),
                "build",
            ),
            dependency(
                "script_output",
                json!(["custom-build"]),
                json!(["bin"]),
                "run-custom-build",
            ),
            dependency(
                "example_library",
                json!(["example"]),
                json!(["rlib"]),
                "build",
            ),
            dependency("documentation", json!(["lib"]), json!(["lib"]), "doc"),
        ];
        let edges = children
            .iter()
            .enumerate()
            .map(|(index, _)| {
                json!({
                    "index": index + 1, "extern_crate_name": format!("renamed-{index}")
                })
            })
            .collect::<Vec<_>>();
        let units = std::iter::once(unit("root", json!(edges)))
            .chain(children)
            .collect::<Vec<_>>();
        let graph =
            UnitGraph::parse(&serde_json::to_vec(&json!({"version":1,"units":units})).unwrap())
                .unwrap();
        let types = vec!["lib".into()];
        let binding = graph
            .binding(&UnitQuery {
                crate_types: &types,
                ..query()
            })
            .unwrap();
        assert_eq!(
            binding.required_rust_extern_names,
            (0..5).map(|index| format!("renamed_{index}")).collect()
        );
        assert_eq!(binding.direct_dependencies.len(), 12);
        assert!(binding.build_script_packages.contains("script_output"));
    }

    #[test]
    fn unknown_rust_library_kinds_and_missing_extern_names_are_not_coverage_proof() {
        for (kind, types, mode, edge) in [
            (
                json!(["future-lib"]),
                json!(["rlib"]),
                "build",
                json!({"index":0,"extern_crate_name":"dep"}),
            ),
            (
                json!(["lib"]),
                json!(["future-type"]),
                "build",
                json!({"index":0,"extern_crate_name":"dep"}),
            ),
            (
                json!(["lib"]),
                json!(["rlib"]),
                "future-mode",
                json!({"index":0,"extern_crate_name":"dep"}),
            ),
            (json!(["lib"]), json!(["rlib"]), "check", json!({"index":0})),
        ] {
            let mut child = unit("dep", json!([]));
            child["target"]["kind"] = kind;
            child["target"]["crate_types"] = types;
            child["mode"] = json!(mode);
            let graph = UnitGraph::parse(
                &serde_json::to_vec(
                    &json!({"version":1,"units":[child,unit("root",json!([edge]))]}),
                )
                .unwrap(),
            )
            .unwrap();
            let types = vec!["lib".into()];
            assert!(
                graph
                    .candidates(&UnitQuery {
                        crate_types: &types,
                        ..query()
                    })
                    .is_err()
            );
        }
    }

    #[test]
    fn cycles_and_unknown_versions_are_not_dependency_evidence() {
        assert!(UnitGraph::parse(br#"{"version":2,"units":[]}"#).is_err());
        let graph = json!({"version":1,"units":[unit("root",json!([{"index":0}]))]});
        assert!(UnitGraph::parse(&serde_json::to_vec(&graph).unwrap()).is_err());
    }

    #[test]
    fn cargo_target_parent_segments_bind_to_the_exact_canonical_source() {
        use std::{
            fs,
            path::PathBuf,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/rustc-analysis/fixtures")
            .join(format!(
                "unit-source-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(root.join("member")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("build.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("other/build.rs"), "fn main() {}\n").unwrap();
        let mut value = unit("root", json!([]));
        value["target"]["src_path"] = json!(root.join("member/../build.rs"));
        let graph =
            UnitGraph::parse(&serde_json::to_vec(&json!({"version":1,"units":[value]})).unwrap())
                .unwrap();
        let types = vec!["lib".to_owned()];
        let source = analysis_contract::normalized(&root.join("build.rs")).unwrap();
        let other = analysis_contract::normalized(&root.join("other/build.rs")).unwrap();
        let q = UnitQuery {
            source: &source,
            crate_types: &types,
            ..query()
        };
        assert_eq!(graph.candidates(&q).unwrap().len(), 1);
        assert!(
            graph
                .candidates(&UnitQuery {
                    source: &other,
                    ..q
                })
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
