//! 模型消费真实身份而非显示名；夹具只模拟编译器和装配边界的数据。
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn model_builds_without_language_annotations_and_keeps_source_evidence() {
    let fixture = Fixture::new();
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert_eq!(model["schemaVersion"], 2);
    assert_eq!(model["callGraph"]["schemaVersion"], 2);
    assert!(model.get("annotationsRequired").is_none());
    for object in model["objects"].as_array().unwrap() {
        assert!(object.get("description").is_none());
        assert!(object.get("display_summary").is_none());
    }
    assert!(!model["sourceFiles"].as_array().unwrap().is_empty());
    for filename in [
        "annotations.json",
        "pending-descriptions.json",
        "purpose-summary.json",
    ] {
        assert!(!fixture.root.join(filename).exists());
    }
}

#[test]
fn owning_structure_comparison_normalizes_records_and_preserves_distinct_instances() {
    let fixture = Fixture::new();
    let mut first: UnitFacts =
        serde_json::from_value(fixture.read("facts.json")["units"][0].clone()).unwrap();
    let mut access = first.accesses[0].clone();
    access.parameter = "another-query".into();
    first.accesses.push(access);
    first.types[0].roles.push("QueryData".into());
    first.calls.push(CallFact {
        caller: "callable".into(),
        callee: Some("helper".into()),
        ..Default::default()
    });
    let mut second = first.clone();
    second.accesses.reverse();
    second.accesses.push(second.accesses[0].clone());
    second.types[0].roles.reverse();
    second.types[0].display = "Marker".into();
    second.calls.push(second.calls[0].clone());
    assert_eq!(owning_structures(&first), owning_structures(&second));
    let mut generic = second.callables[0].clone();
    generic.id = "another-generic-instance".into();
    second.callables.push(generic);
    let original = owning_structures(&first);
    let expanded = owning_structures(&second);
    assert!(
        original
            .iter()
            .all(|(id, structure)| expanded.get(id) == Some(structure))
    );
    assert_eq!(expanded.len(), original.len() + 1);
}

#[test]
fn old_compiler_fact_units_are_rejected() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["schemaVersion"] = json!(2);
    fixture.write("facts.json", &facts);
    let error = fixture.build().unwrap_err().to_string();
    assert!(
        error.contains("Unsupported compiler unit schema"),
        "{error}"
    );
}

#[test]
fn old_compiler_fact_bundle_is_rejected() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["schemaVersion"] = json!(2);
    fixture.write("facts.json", &facts);
    let error = fixture.build().unwrap_err().to_string();
    assert!(error.contains("Unsupported analysis schema"), "{error}");
}

#[test]
fn entity_names_preserve_values_expressions_candidates_and_legacy_templates() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let source: SourceEvidence =
        serde_json::from_value(facts["units"][0]["accesses"][0]["source"].clone()).unwrap();
    let candidate =
        |value: Option<&str>, expression: Option<&str>, reason: Option<&str>| EntityNameCandidate {
            value: value.map(str::to_owned),
            expression: expression.map(|snippet| SourceEvidence {
                snippet: snippet.into(),
                role: "compiler-name-expression".into(),
                ..source.clone()
            }),
            reason: reason.map(str::to_owned),
        };
    let literal = candidate(
        Some("角色 :: Player / #1！"),
        Some("\"角色 :: Player / #1！\""),
        None,
    );
    let dynamic = candidate(
        None,
        Some("  format!(\"箱体 {}\", index)  "),
        Some("runtime index"),
    );
    let unknown = candidate(None, None, Some("opaque name source"));
    let cases = [
        ("literal", vec![literal.clone()]),
        ("same-name", vec![literal.clone()]),
        ("empty", vec![candidate(Some(""), Some("\"\""), None)]),
        ("whitespace", vec![candidate(Some("  "), None, None)]),
        ("dynamic", vec![dynamic.clone()]),
        ("legacy", vec![]),
        ("unknown", vec![unknown.clone()]),
        ("blank-expression", vec![candidate(None, Some("  "), None)]),
        (
            "alternatives",
            vec![
                candidate(Some("B"), None, None),
                unknown,
                candidate(Some("A"), None, None),
                candidate(Some("B"), None, None),
            ],
        ),
    ];

    let entities: Vec<_> = cases
        .into_iter()
        .map(|(id, name_candidates)| EntityTemplate {
            id: id.into(),
            creator: "callable".into(),
            source: Some(source.clone()),
            name_candidates,
            ..Default::default()
        })
        .collect();

    facts["units"][0]["entities"] = json!(entities);
    // 旧事实没有新增字段时继续反序列化，不要求重新提取才能显示明确的名称缺口。
    facts["units"][0]["entities"][5]
        .as_object_mut()
        .unwrap()
        .remove("nameCandidates");

    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let entity = |template: &str| {
        model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["templateId"] == template)
            .unwrap()
    };
    assert_eq!(entity("literal")["name"], "角色 :: Player / #1！");
    assert_eq!(entity("empty")["name"], "Name(\"\")");
    assert_eq!(entity("whitespace")["name"], "  ");
    assert_eq!(entity("dynamic")["name"], "  format!(\"箱体 {}\", index)  ");
    for id in ["legacy", "unknown", "blank-expression"] {
        assert_eq!(entity(id)["name"], "Entity @ src/main.rs:1");
        assert!(!entity(id)["sourceGaps"].as_array().unwrap().is_empty());
    }
    assert!(
        entity("legacy")["nameCandidates"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        entity("unknown")["nameCandidates"][0]["reason"],
        "opaque name source"
    );
    assert_eq!(
        entity("alternatives")["name"],
        "Name ∈ {A | B | Entity @ src/main.rs:1}"
    );
    assert_eq!(
        entity("alternatives")["nameCandidates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(entity("literal")["name"], entity("same-name")["name"]);
    assert_ne!(entity("literal")["id"], entity("same-name")["id"]);
    assert_eq!(entity("literal")["id"], identifier("entity", "literal"));

    let proof = &entity("dynamic")["nameCandidates"][0];
    assert_eq!(proof["expression"], "  format!(\"箱体 {}\", index)  ");
    assert!(proof["value"].is_null());
    assert_eq!(proof["sourceEntries"][0]["path"], "src/main.rs");
    assert_eq!(proof["sourceEntries"][0]["role"], "assembly");
    assert!(
        entity("dynamic")["sourceEntries"]
            .as_array()
            .unwrap()
            .contains(&proof["sourceEntries"][0]),
        "Without a structural assembly range, the exact name location remains a detail entry"
    );

    // 输入顺序和重复候选不改变名称、证据或持久身份。
    facts["units"][0]["entities"]
        .as_array_mut()
        .unwrap()
        .reverse();
    for template in facts["units"][0]["entities"].as_array_mut().unwrap() {
        if let Some(candidates) = template
            .get_mut("nameCandidates")
            .and_then(Value::as_array_mut)
        {
            candidates.reverse();
        }
    }
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    assert_eq!(fixture.read("model.json")["objects"], model["objects"]);

    // 名称表达式也必须通过统一源码校验，不能成为未核验的展示证据。
    let template = facts["units"][0]["entities"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|template| template["id"] == "dynamic")
        .unwrap();
    template["nameCandidates"][0]["expression"]["sha256"] = json!("stale-name-source");
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    assert!(
        fixture.read("model.json")["bindingErrors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error
                .as_str()
                .unwrap()
                .contains("Compiler source evidence changed"))
    );
}

#[test]
fn entity_name_locations_share_only_their_own_complete_assembly_span() {
    let fixture = Fixture::new();
    let contents = "fn system() {}\r\nstruct Marker;\r\n";
    fs::write(fixture.root.join("src/main.rs"), contents).unwrap();
    fs::write(fixture.root.join("src/helper.rs"), contents).unwrap();
    let mut runtime = fixture.read("runtime.json");
    runtime["sourceFingerprint"] = json!(source_fingerprint(&fixture.root).unwrap());
    fixture.replace_runtime(&runtime);
    let mut manifest = fixture.read("debugdump/manifest.json");
    manifest["sourceFingerprint"] = runtime["sourceFingerprint"].clone();
    fixture.write("debugdump/manifest.json", &manifest);
    let mut facts = fixture.read("facts.json");
    let source: SourceEvidence =
        serde_json::from_value(facts["units"][0]["accesses"][0]["source"].clone()).unwrap();
    let raw_hash = digest(contents);
    facts["units"][0]["sourceFiles"][0]["sha256"] = json!(raw_hash);
    facts["units"][0]["sourceFiles"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":fixture.root.join("src/helper.rs"),"sha256":raw_hash}));
    let assembly = SourceEvidence {
        expansions: vec![Expansion {
            name: "bsn!".into(),
            path: "src/main.rs".into(),
            line: 1,
            column: 1,
        }],
        ..source.clone()
    };
    let expression = SourceEvidence {
        column: 4,
        end_column: 10,
        snippet: "system".into(),
        role: "assembly".into(),
        ..source.clone()
    };
    let outside = SourceEvidence {
        line: 2,
        column: 1,
        end_line: 2,
        end_column: 14,
        ..expression.clone()
    };
    let incomplete = SourceEvidence {
        end_line: 0,
        end_column: 0,
        ..assembly.clone()
    };
    let empty = SourceEvidence {
        end_column: 1,
        ..assembly.clone()
    };
    let helper = SourceEvidence {
        path: fixture.root.join("src/helper.rs").to_string_lossy().into(),
        ..assembly.clone()
    };
    let cases = [
        ("parent", Some(assembly.clone()), expression.clone(), true),
        ("child", None, expression.clone(), false),
        (
            "branch-with-assembly",
            Some(assembly.clone()),
            expression.clone(),
            true,
        ),
        ("branch-without-assembly", None, expression.clone(), false),
        ("outside", Some(assembly.clone()), outside, false),
        ("helper", Some(helper), expression.clone(), false),
        (
            "partial-overlap",
            Some(assembly.clone()),
            SourceEvidence {
                end_line: 2,
                end_column: 1,
                ..expression.clone()
            },
            false,
        ),
        (
            "unknown-assembly-range",
            Some(incomplete),
            expression.clone(),
            false,
        ),
        (
            "empty-assembly-range",
            Some(empty),
            expression.clone(),
            false,
        ),
        (
            "reversed-assembly-range",
            Some(SourceEvidence {
                column: 8,
                end_column: 4,
                ..assembly.clone()
            }),
            expression.clone(),
            false,
        ),
        (
            "same-start-overrun",
            Some(assembly.clone()),
            SourceEvidence {
                column: 1,
                end_line: 2,
                end_column: 1,
                ..expression.clone()
            },
            false,
        ),
        (
            "unknown-name-range",
            Some(assembly.clone()),
            SourceEvidence {
                end_line: 0,
                end_column: 0,
                ..expression.clone()
            },
            false,
        ),
        (
            "different-hash",
            Some(assembly.clone()),
            SourceEvidence {
                sha256: raw_hash.clone(),
                ..expression.clone()
            },
            false,
        ),
        (
            "missing-hash",
            Some(SourceEvidence {
                sha256: String::new(),
                ..assembly.clone()
            }),
            SourceEvidence {
                sha256: String::new(),
                ..expression.clone()
            },
            false,
        ),
    ];

    let mut entities: Vec<_> = cases
        .iter()
        .map(|(id, assembly, expression, _)| EntityTemplate {
            id: (*id).into(),
            creator: "callable".into(),
            source: Some(source.clone()),
            source_evidence: assembly.iter().cloned().collect(),
            name_candidates: vec![EntityNameCandidate {
                value: Some((*id).into()),
                expression: Some(expression.clone()),
                reason: None,
            }],
            ..Default::default()
        })
        .collect();
    entities[0].children.push("child".into());
    entities[0].alternatives.push(EntityAlternativeGroup {
        id: "name-branches".into(),
        candidates: vec![
            "branch-with-assembly".into(),
            "branch-without-assembly".into(),
        ],
        source: Some(assembly),
        selection: "one-of".into(),
    });
    for entity in &mut entities[2..4] {
        entity.alternative_group = Some("name-branches".into());
        entity.alternative_selection = Some("one-of".into());
        entity.alternative_context = vec!["name-branches".into()];
        entity.possible = true;
    }

    facts["units"][0]["entities"] = json!(entities);

    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    for (id, assembly, expression, covered) in &cases {
        let entity = model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["templateId"] == *id)
            .unwrap();
        assert_eq!(entity["name"], *id);
        let proof = &entity["nameCandidates"][0]["sourceEntries"][0];
        assert_eq!(proof["path"], "src/main.rs");
        assert_eq!(proof["line"], expression.line);
        assert_eq!(proof["column"], expression.column);
        assert_eq!(proof["sha256"], raw_hash);
        let sources = entity["sourceEntries"].as_array().unwrap();
        assert_eq!(
            sources
                .iter()
                .filter(|entry| entry["role"] == "create")
                .count(),
            1
        );
        assert_eq!(sources.contains(proof), !*covered, "{id}");
        assert_eq!(
            sources
                .iter()
                .filter(|entry| entry["role"] == "assembly")
                .count(),
            usize::from(assembly.is_some()) + usize::from(!*covered),
            "{id}"
        );
    }
    assert_eq!(model["sourceFiles"].as_array().unwrap().len(), 2);
    assert_eq!(fixture.read("facts.json"), facts);
    facts["units"][0]["entities"][0]["nameCandidates"][0]["expression"]["sha256"] =
        json!("stale-name-source");
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    assert!(
        fixture.read("model.json")["bindingErrors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error
                .as_str()
                .unwrap()
                .contains("Compiler source evidence changed"))
    );
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ecs-architecture/model-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("debugdump")).unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname=\"fixture\"\nversion=\"0.0.0\"\n",
        )
        .unwrap();
        fs::write(root.join("Cargo.lock"), "version = 4\n").unwrap();
        fs::write(root.join("src/main.rs"), "fn system() {}\nstruct Marker;\n").unwrap();
        let root = root.canonicalize().unwrap();
        let fixture = Self { root };
        let source = SourceEvidence {
            path: fixture
                .root
                .join("src/main.rs")
                .to_string_lossy()
                .to_string(),
            line: 1,
            column: 1,
            end_line: 1,
            end_column: 15,
            role: "definition".into(),
            sha256: digest("fn system() {}\nstruct Marker;\n"),
            ..Default::default()
        };
        let unit = UnitFacts {
            schema_version: FACT_SCHEMA_VERSION,
            crate_name: "demo".into(),
            crate_identity: "compiled-crate".into(),
            source_files: vec![SourceFile {
                path: source.path.clone(),
                sha256: source.sha256.clone(),
            }],
            declarations: vec![
                Declaration {
                    id: "function".into(),
                    local: true,
                    full_name: "demo::sample::system".into(),
                    name: "system".into(),
                    crate_name: "demo".into(),
                    kind: "Fn".into(),
                    source: Some(source.clone()),

                    ..Default::default()
                },
                Declaration {
                    id: "marker-declaration".into(),
                    local: true,
                    full_name: "demo::sample::Marker".into(),
                    name: "Marker".into(),
                    crate_name: "demo".into(),
                    kind: "Struct".into(),
                    source: Some(source.clone()),

                    ..Default::default()
                },
            ],
            types: vec![TypeInstance {
                id: "marker-type".into(),
                declaration: Some("marker-declaration".into()),
                display: "demo::sample::Marker".into(),
                roles: vec!["Component".into()],
                runtime_type_id: Some("marker-runtime".into()),
                ..Default::default()
            }],
            callables: vec![Callable {
                id: "callable".into(),
                declaration: "function".into(),

                display: "demo::sample::system".into(),
                system_type_ids: vec!["system-runtime".into()],
                ..Default::default()
            }],
            accesses: vec![AccessFact {
                owner: "callable".into(),
                type_id: "marker-type".into(),
                mode: "mutable_access".into(),
                storage: "Component".into(),
                scope: "current".into(),
                parameter: "query".into(),
                source: Some(source),
            }],
            ..Default::default()
        };
        let dot = "digraph { node_first; node_second; }\n";
        let schedule_id = digest("main\0Update")[..16].to_owned();
        let dot_filename = format!("schedule-{schedule_id}.dot");
        fs::write(fixture.root.join("debugdump").join(&dot_filename), dot).unwrap();
        let runtime = RuntimeSnapshot {
            schema_version: 1,
            source_fingerprint: source_fingerprint(&fixture.root).unwrap(),
            target: "fixture-target".into(),
            features: vec!["debugdump".into()],
            schedules: vec![RuntimeSchedule {
                id: schedule_id,
                app: "main".into(),
                label: "Update".into(),
                dot_filename,
                dot_sha256: digest(dot),
                systems: ["first", "second"]
                    .into_iter()
                    .map(|key| RuntimeSystem {
                        key: key.into(),
                        graph_name: format!("node_{key}"),
                        name: "same display name".into(),
                        type_id: "system-runtime".into(),
                        access_scope: "finite".into(),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }],
        };
        fixture.write("runtime.json", &runtime);
        fixture.write("debugdump/manifest.json",&json!({"schemaVersion":1,"sourceFingerprint":runtime.source_fingerprint,"schedules":runtime.schedules.iter().map(|schedule|json!({"id":schedule.id,"app":schedule.app,"label":schedule.label,"filename":schedule.dot_filename,"sha256":schedule.dot_sha256})).collect::<Vec<_>>()}));
        fixture.write("facts.json", &json!({"schemaVersion":FACT_SCHEMA_VERSION,"compiler":"fixed-compiler","configuration":"same-build","workspace":fixture.root,"packages":[],"units":[unit],"runtimeSha256":digest(fs::read(fixture.root.join("runtime.json")).unwrap())}));
        fixture
    }
    fn write(&self, name: &str, value: &impl serde::Serialize) {
        fs::write(
            self.root.join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
    fn read(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.root.join(name)).unwrap()).unwrap()
    }
    fn build(&self) -> Result<()> {
        build(
            &self.root.join("facts.json"),
            &self.root.join("runtime.json"),
            &self.root.join("model.json"),
        )
    }
    fn replace_runtime(&self, value: &Value) {
        self.write("runtime.json", value);
        let mut facts = self.read("facts.json");
        facts["runtimeSha256"] = json!(digest(fs::read(self.root.join("runtime.json")).unwrap()));
        self.write("facts.json", &facts);
    }
}

#[test]
fn call_graph_sidecar_preserves_recursive_call_proofs_and_deduplicates_unit_copies() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let source = facts["units"][0]["declarations"][0]["source"].clone();
    let call = json!({"caller":"callable","callee":"callable","declaration":"function","source":source,"deferred":true,"conditions":[source]});
    facts["units"][0]["calls"] = json!([call, call]);
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let graph = &model["callGraph"];
    assert_eq!(graph["schemaVersion"], 2);
    assert_eq!(graph["format"], "ndjson");
    assert_eq!(graph["edgeCount"], 1);
    let path = fixture.root.join(graph["file"].as_str().unwrap());
    let bytes = fs::read(path).unwrap();
    assert_eq!(graph["sha256"], digest(&bytes));
    let lines: Vec<_> = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    assert_eq!(lines.len(), 1);
    let edge: Value = serde_json::from_slice(lines[0]).unwrap();
    assert_eq!(edge["caller"], "callable");
    assert_eq!(edge["callee"], "callable");
    assert_eq!(edge["deferred"], true);
    assert_eq!(edge["registeredOwners"].as_array().unwrap().len(), 2);
    assert_eq!(edge["conditions"].as_array().unwrap().len(), 1);
    assert_eq!(edge["sourceEntries"].as_array().unwrap().len(), 1);
}

#[test]
fn call_graph_and_representative_paths_are_stable_across_unit_and_call_order() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let source = unit.declarations[0].source.clone().unwrap();
    let call = |caller: &str, callee: &str, column: usize| CallFact {
        caller: caller.into(),
        callee: Some(callee.into()),
        declaration: Some("function".into()),
        source: Some(SourceEvidence {
            column,
            ..source.clone()
        }),
        ..Default::default()
    };
    let left = call("callable", "left", 1);
    let right = call("callable", "right", 3);
    let (first_column, second_column) = if identifier("call", &left) < identifier("call", &right) {
        (1, 5)
    } else {
        (3, 7)
    };
    let mut conditional = call("join", "sink", 11);
    conditional.conditions.push(SourceEvidence {
        role: "condition".into(),
        snippet: "system()".into(),
        ..source.clone()
    });
    let mut deferred = conditional.clone();
    deferred.deferred = true;
    let mut opposite = conditional.clone();
    opposite.conditions[0].role = "unless".into();
    unit.calls = vec![
        left,
        right,
        call("left", "join", 5),
        call("right", "join", 7),
        call("join", "join", 9),
        conditional,
        deferred,
        opposite,
    ];
    let expected_ids: Vec<_> = unit
        .calls
        .iter()
        .map(|call| identifier("call", call))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    unit.calls.push(unit.calls[0].clone());
    unit.operations.push(OperationFact {
        id: "insert-in-join".into(),
        owner: "join".into(),
        method: "resolved-world-insert".into(),
        target_type: Some("marker-type".into()),
        kind: "insert".into(),
        scope: "current".into(),
        source: Some(source),
        ..Default::default()
    });
    let mut second = unit.clone();
    second.crate_identity = "second-compiled-unit".into();
    second.accesses.clear();
    second.operations.clear();
    // 第二单元只有导入的调用观测，不声称拥有已删去访问和操作的完整声明。
    for declaration in &mut second.declarations {
        declaration.local = false;
    }
    let mut previous = None;
    for (reverse_units, reverse_calls) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let mut units = vec![unit.clone(), second.clone()];
        if reverse_units {
            units.reverse();
        }
        if reverse_calls {
            for unit in &mut units {
                unit.calls.reverse();
            }
        }
        facts["units"] = json!(units);
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        let model = fixture.read("model.json");
        let graph = &model["callGraph"];
        assert_eq!(graph["schemaVersion"], 2);
        assert_eq!(graph["format"], "ndjson");
        assert_eq!(graph["edgeCount"], expected_ids.len());
        let bytes = fs::read(fixture.root.join(graph["file"].as_str().unwrap())).unwrap();
        assert_eq!(graph["sha256"], digest(&bytes));
        let edges: Vec<Value> = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(
            edges
                .iter()
                .map(|edge| edge["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            expected_ids
        );
        let owners: Vec<_> = model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|object| object["kind"] == "System")
            .map(|object| object["id"].clone())
            .collect();
        assert_eq!(owners.len(), 2);
        for edge in &edges {
            let native = unit
                .calls
                .iter()
                .find(|call| identifier("call", call) == edge["id"].as_str().unwrap())
                .unwrap();
            assert_eq!(edge["caller"], native.caller);
            assert_eq!(edge["callee"], json!(native.callee));
            assert_eq!(edge["deferred"], native.deferred);
            assert_eq!(edge["registeredOwners"], json!(owners));
            assert_eq!(edge["declaration"], "function");
            assert_eq!(edge["sourceEntries"].as_array().unwrap().len(), 1);
            assert_eq!(
                edge["sourceEntries"][0]["column"],
                native.source.as_ref().unwrap().column
            );
            assert_eq!(
                edge["conditions"].as_array().unwrap().len(),
                native.conditions.len()
            );
            for (condition, native) in edge["conditions"]
                .as_array()
                .unwrap()
                .iter()
                .zip(&native.conditions)
            {
                assert_eq!(condition["expression"], native.snippet);
                assert_eq!(condition["guardKind"], native.role);
            }
        }
        let conditional_edges: Vec<_> = edges
            .iter()
            .filter(|edge| edge["callee"] == "sink")
            .collect();
        assert_eq!(conditional_edges.len(), 3);
        for edge in &conditional_edges {
            assert_eq!(edge["conditions"].as_array().unwrap().len(), 1);
            assert_eq!(edge["conditions"][0]["expression"], "system()");
        }
        assert!(
            conditional_edges
                .iter()
                .any(|edge| edge["deferred"] == true)
        );
        assert!(
            conditional_edges
                .iter()
                .any(|edge| edge["conditions"][0]["guardKind"] == "unless")
        );
        let inserts: Vec<_> = model["relations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|relation| relation["kind"] == "insert")
            .collect();
        assert_eq!(inserts.len(), 2);
        for relation in inserts {
            let operations = relation["bodyOperations"].as_array().unwrap();
            assert_eq!(operations.len(), 1);
            assert_eq!(
                operations[0]["callChainScope"],
                "representative-static-path"
            );
            let chain = operations[0]["callChain"].as_array().unwrap();
            assert_eq!(chain.len(), 2);
            assert_eq!(chain[0]["column"], first_column);
            assert_eq!(chain[1]["column"], second_column);
        }
        let current = (
            bytes,
            model["objects"].clone(),
            model["relations"].clone(),
            graph.clone(),
        );
        if let Some(previous) = &previous {
            assert_eq!(previous, &current);
        }
        previous = Some(current);
    }
}

#[test]
fn repeated_registration_retains_instances_and_access_capability() {
    let fixture = Fixture::new();
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let systems: Vec<_> = model["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|object| object["kind"] == "System")
        .collect();
    assert_eq!(systems.len(), 2);
    assert_ne!(systems[0]["id"], systems[1]["id"]);
    let relations = model["relations"].as_array().unwrap();
    assert_eq!(
        relations
            .iter()
            .filter(|relation| relation["kind"] == "mutable_access")
            .count(),
        2
    );
    assert!(!relations.iter().any(|relation| matches!(
        relation["kind"].as_str(),
        Some("insert" | "remove" | "modify")
    )));
    assert_eq!(model["sourceFiles"].as_array().unwrap().len(), 1);
}

#[test]
fn system_registration_sources_preserve_all_callable_sites_without_guessing_instances() {
    for positions in [vec![], vec![(1u64, 3u64)], vec![(1, 3), (2, 5)]] {
        let fixture = Fixture::new();
        let mut facts = fixture.read("facts.json");
        let source = facts["units"][0]["declarations"][0]["source"].clone();
        let source_sha = source["sha256"].clone();
        let mut registrations = vec![];
        for &(line, column) in &positions {
            for role in ["registration", "operation"] {
                let mut proof = source.clone();
                proof["line"] = json!(line);
                proof["column"] = json!(column);
                proof["role"] = json!(role);
                registrations.push(json!({"owner":"plugin-build","kind":"add_systems",
                    "target":"callable","typeId":null,"source":proof}));
            }
        }
        let mut unrelated = source.clone();
        unrelated["column"] = json!(99);
        registrations.push(json!({"owner":"plugin-build","kind":"add_systems",
            "target":"other-callable","typeId":null,"source":unrelated}));
        registrations.push(json!({"owner":"plugin-build","kind":"add_systems",
            "target":"callable","typeId":null,"source":null}));
        facts["units"][0]["registrations"] = json!(registrations);
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        let model = fixture.read("model.json");
        let systems: Vec<_> = model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|object| object["kind"] == "System")
            .collect();
        assert_eq!(systems.len(), 2);
        assert_ne!(systems[0]["id"], systems[1]["id"]);
        for system in systems {
            let sources: Vec<_> = system["sourceEntries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|source| source["role"] == "registration")
                .collect();
            assert_eq!(sources.len(), positions.len());
            let actual: BTreeSet<_> = sources
                .iter()
                .map(|source| {
                    assert_eq!(source["path"], "src/main.rs");
                    assert_eq!(source["sha256"], source_sha);
                    assert_eq!(
                        source["label"],
                        if positions.len() > 1 {
                            "该函数的注册位置（不限于当前调度）"
                        } else {
                            "注册位置"
                        }
                    );
                    (
                        source["line"].as_u64().unwrap(),
                        source["column"].as_u64().unwrap(),
                    )
                })
                .collect();
            assert_eq!(actual, positions.iter().copied().collect());
        }
        registrations.reverse();
        facts["units"][0]["registrations"] = json!(registrations);
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        assert_eq!(fixture.read("model.json")["objects"], model["objects"]);
        assert_eq!(fixture.read("facts.json"), facts);
    }
}

#[test]
fn type_identity_preserves_native_declaration_across_display_and_storage_projections() {
    for storage in ["Component", "NonSend"] {
        let fixture = Fixture::new();
        let mut facts = fixture.read("facts.json");
        facts["units"][0]["declarations"][1]["local"] = json!(true);
        facts["units"][0]["types"][0]["display"] = json!("presentation::DifferentName");
        facts["units"][0]["accesses"][0]["storage"] = json!(storage);
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        let model = fixture.read("model.json");
        let object = model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["typeInstanceId"] == "marker-type" && object["kind"] == storage)
            .unwrap();
        assert_eq!(object["name"], "presentation::DifferentName");
        assert_eq!(
            object["typeIdentity"],
            json!({"declarationId":"marker-declaration","crateName":"demo",
                "defPath":"demo::sample::Marker","local":true,"roles":["Component"]})
        );
    }
}

#[test]
fn same_display_name_cannot_substitute_for_runtime_type_identity() {
    let fixture = Fixture::new();
    let mut runtime = fixture.read("runtime.json");
    runtime["schedules"][0]["systems"][0]["typeId"] = json!("unrelated-runtime-type");
    fixture.replace_runtime(&runtime);
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("binding is incomplete")
    );
    assert!(
        !fixture.read("model.json")["bindingErrors"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn changed_source_and_mixed_builds_are_rejected() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("src/main.rs"), "fn replacement() {}\n").unwrap();
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("fingerprint is stale")
    );
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("runtime.json"),
        format!(
            "{}\n",
            fs::read_to_string(fixture.root.join("runtime.json")).unwrap()
        ),
    )
    .unwrap();
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("build provenance mismatch")
    );
}

#[test]
fn local_state_is_scoped_to_each_registration_and_slot() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["accesses"][0]["storage"] = json!("Local");
    facts["units"][0]["accesses"][0]["parameter"] = json!("state");
    fixture.write("facts.json", &facts);

    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let locals: Vec<_> = model["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|object| object["kind"] == "Local")
        .collect();
    assert_eq!(locals.len(), 2);
    assert_ne!(locals[0]["id"], locals[1]["id"]);
    let local_relations: Vec<_> = model["relations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|relation| {
            relation["parameterAccesses"]
                .as_array()
                .is_some_and(|accesses| accesses.iter().any(|access| access["storage"] == "Local"))
        })
        .collect();
    assert_eq!(local_relations.len(), 2);
    for relation in local_relations {
        assert_eq!(relation["scope"], "local");
        assert!(relation.get("parameter").is_none());
        assert_eq!(relation["parameterAccesses"][0]["scope"], "current");
        assert_eq!(relation["parameterAccesses"][0]["parameter"], "state");
        assert_eq!(relation["parameterAccesses"][0]["directRoot"], true);
    }
}

#[test]
fn partial_parameter_evidence_is_paired_and_independent_of_unit_order() {
    for with_direct_access in [true, false] {
        let fixture = Fixture::new();
        let mut facts = fixture.read("facts.json");
        let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
        let mut declaration = unit.declarations[0].clone();
        declaration.id = "helper-declaration".into();
        declaration.name = "helper".into();
        declaration.full_name = "demo::sample::helper".into();
        unit.declarations.push(declaration);
        unit.callables.push(Callable {
            id: "helper-callable".into(),
            declaration: "helper-declaration".into(),

            display: "demo::sample::helper".into(),
            ..Default::default()
        });
        unit.calls.push(CallFact {
            caller: "callable".into(),
            callee: Some("helper-callable".into()),
            declaration: Some("helper-declaration".into()),
            source: unit.declarations[0].source.clone(),
            ..Default::default()
        });
        let mut direct = unit.accesses[0].clone();
        direct.mode = "filter".into();
        direct.scope = "main".into();
        direct.parameter = "camera_query.0.filter".into();
        let mut helper = direct.clone();
        helper.owner = "helper-callable".into();
        helper.scope = "current".into();
        helper.parameter = "arg0.filter".into();
        let mut first = unit.clone();
        first.accesses = if with_direct_access {
            vec![direct]
        } else {
            vec![]
        };
        let mut second = unit;
        second.accesses = vec![helper.clone(), helper];
        for declaration in &mut second.declarations {
            declaration.local = false;
        }

        let mut previous = None;
        for reverse in [false, true] {
            facts["units"] = if reverse {
                json!([second, first])
            } else {
                json!([first, second])
            };
            fixture.write("facts.json", &facts);
            fixture.build().unwrap();
            let model = fixture.read("model.json");
            let relations: Vec<_> = model["relations"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|relation| relation.get("parameterAccesses").is_some())
                .cloned()
                .collect();
            assert_eq!(
                relations.len(),
                2,
                "One edge for each actual runtime registration"
            );
            for relation in &relations {
                assert!(
                    relation.get("scope").is_none(),
                    "A helper's current scope is not the registered entry's World"
                );
                assert!(
                    relation.get("parameter").is_none(),
                    "Do not choose one native parameter by arrival order"
                );
                let accesses = relation["parameterAccesses"].as_array().unwrap();
                assert_eq!(accesses.len(), if with_direct_access { 2 } else { 1 });
                assert!(
                    accesses
                        .iter()
                        .any(|access| access["callableId"] == "helper-callable"
                            && access["parameter"] == "arg0.filter"
                            && access["scope"] == "current"
                            && access["directRoot"] == false)
                );
                if with_direct_access {
                    assert!(
                        accesses
                            .iter()
                            .any(|access| access["callableId"] == "callable"
                                && access["parameter"] == "camera_query.0.filter"
                                && access["scope"] == "main"
                                && access["directRoot"] == true)
                    );
                }
                assert!(
                    accesses
                        .iter()
                        .all(|access| access["registeredOwner"] == relation["to"]
                            && access["storage"] == "Component"
                            && access["typeInstanceId"] == "marker-type"
                            && !access["sourceEntries"].as_array().unwrap().is_empty())
                );
            }
            if let Some(previous) = &previous {
                assert_eq!(previous, &relations);
            }
            previous = Some(relations);
        }
    }
}

#[test]
fn direct_parameter_consensus_preserves_only_unambiguous_compatible_scalars() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut first = facts["units"][0]["accesses"][0].clone();
    first["scope"] = json!("main");
    first["parameter"] = json!("query.left");
    let mut second = first.clone();
    second["parameter"] = json!("query.right");
    for accesses in [json!([first]), json!([first, second, first])] {
        facts["units"][0]["accesses"] = accesses;
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        let model = fixture.read("model.json");
        let relations: Vec<_> = model["relations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|relation| relation.get("parameterAccesses").is_some())
            .collect();
        assert_eq!(relations.len(), 2);
        for relation in relations {
            assert_eq!(relation["scope"], "main");
            let records = relation["parameterAccesses"].as_array().unwrap();
            if records.len() == 1 {
                assert_eq!(relation["parameter"], "query.left");
            } else {
                assert_eq!(records.len(), 2);
                assert!(relation.get("parameter").is_none());
            }
            assert!(records.iter().all(|record| record["directRoot"] == true));
        }
    }
}

#[test]
fn local_parameter_evidence_keeps_storage_domain_without_choosing_a_world() {
    let access = AccessFact {
        owner: "root-callable".into(),
        type_id: "local-type".into(),
        mode: "mutable_access".into(),
        storage: "Local".into(),
        scope: "current".into(),
        parameter: "state".into(),
        source: None,
    };
    let first = parameter_relation_evidence(&access, "registered-root", true, &[]);
    let mut main = access;
    main.scope = "main".into();
    let second = parameter_relation_evidence(&main, "registered-root", true, &[]);
    let mut relations = BTreeMap::from([(
        "local".into(),
        json!({"sourceEntries":[],"parameterAccesses":[first["parameterAccesses"][0],second["parameterAccesses"][0]]}),
    )]);
    finish_parameter_relations(&mut relations);
    assert_eq!(
        relations["local"]["scope"], "local",
        "Local storage does not assert a root World"
    );
    assert!(relations["local"].get("parameter").is_none());
    assert_eq!(
        relations["local"]["parameterAccesses"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn native_type_display_candidates_are_stable_across_reordered_and_repeated_units() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.types[0].kind = "adt".into();
    unit.types[0].arguments = vec![
        TypeArgument {
            kind: "type".into(),
            value: "leaf-type".into(),
        },
        TypeArgument {
            kind: "const".into(),
            value: "7".into(),
        },
    ];
    unit.types.push(TypeInstance {
        id: "leaf-type".into(),
        kind: "value".into(),
        display: "u32".into(),
        ..Default::default()
    });
    let names = [
        "demo::sample::Marker<demo::sample::Leaf, 7>",
        "sample::Marker<sample::Leaf, 7>",
        "demo::sample::Marker<sample::Leaf, 7>",
    ];
    let variants: Vec<_> = names
        .iter()
        .map(|display| {
            let mut variant = unit.clone();
            variant.types[0].display = (*display).into();
            variant
        })
        .collect();
    let mut previous = None;
    for order in [vec![0, 1, 2], vec![2, 1, 0], vec![1, 0, 1, 2, 0]] {
        facts["units"] = json!(
            order
                .iter()
                .map(|index| &variants[*index])
                .collect::<Vec<_>>()
        );
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        let model = fixture.read("model.json");
        let marker = model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["typeInstanceId"] == "marker-type")
            .unwrap();
        for field in ["name", "rust_type", "fullName"] {
            assert_eq!(
                marker[field], names[0],
                "Only the observed display candidate is selected deterministically"
            );
        }
        assert_eq!(marker["declarationId"], "marker-declaration");

        let output = json!({"objects":model["objects"],"relations":model["relations"],"features":model["features"]});
        if let Some(previous) = &previous {
            assert_eq!(previous, &output);
        }
        previous = Some(output);
    }
}

#[test]
fn feature_representatives_are_existing_plugins_and_stable_across_native_order() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.declarations[0].name = "main".into();
    unit.declarations[0].full_name = "demo::main".into();
    unit.callables[0].display = "demo::main".into();
    let source = unit.declarations[0].source.clone();
    for (id, crate_name, path, name) in [
        (
            "plugin-a",
            "shared_crate",
            "shared_crate::PluginA",
            "PluginA",
        ),
        (
            "plugin-b",
            "shared_crate",
            "shared_crate::PluginB",
            "PluginB",
        ),
        (
            "only-plugin",
            "demo",
            "demo::only_feature::OnlyPlugin",
            "OnlyPlugin",
        ),
    ] {
        unit.declarations.push(Declaration {
            id: format!("{id}-declaration"),
            full_name: path.into(),
            name: name.into(),
            crate_name: crate_name.into(),
            kind: "Struct".into(),
            source: source.clone(),
            ..Default::default()
        });
        unit.types.push(TypeInstance {
            id: format!("{id}-type"),
            declaration: Some(format!("{id}-declaration")),
            display: path.into(),
            kind: "adt".into(),
            roles: vec!["Plugin".into()],
            ..Default::default()
        });
    }
    let mut second_access = unit.accesses[0].clone();
    second_access.parameter = "second_query".into();
    unit.accesses.push(second_access);
    let mut first = unit.clone();
    first.registrations.push(RegistrationFact {
        owner: "callable".into(),
        kind: "add_plugins".into(),
        type_id: Some("plugin-a-type".into()),
        source: source.clone(),
        ..Default::default()
    });
    let mut second = unit;
    second.registrations.push(RegistrationFact {
        owner: "callable".into(),
        kind: "add_plugins".into(),
        type_id: Some("plugin-b-type".into()),
        source,
        ..Default::default()
    });

    first.registrations.extend(second.registrations.clone());
    second.registrations = first.registrations.clone();
    let mut previous = None;
    for reverse in [false, true, false] {
        first.accesses.reverse();
        second.accesses.reverse();
        facts["units"] = if reverse {
            json!([second, first])
        } else {
            json!([first, second, first])
        };
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        let model = fixture.read("model.json");
        let objects = model["objects"].as_array().unwrap();
        let plugins: Vec<_> = objects
            .iter()
            .filter(|object| object["kind"] == "Plugin")
            .collect();
        assert_eq!(
            plugins.len(),
            3,
            "Selecting one representative does not remove other plugins"
        );
        let shared: Vec<_> = plugins
            .iter()
            .filter(|object| object["feature"] == "crate:shared_crate")
            .collect();
        assert_eq!(shared.len(), 2);
        let expected = shared
            .iter()
            .map(|object| object["id"].as_str().unwrap())
            .min()
            .unwrap();
        let features = model["features"].as_array().unwrap();
        let feature = features
            .iter()
            .find(|feature| feature["id"] == "crate:shared_crate")
            .unwrap();
        assert_eq!(feature["overviewNode"], expected);
        let representative = shared
            .iter()
            .find(|object| object["id"] == expected)
            .unwrap();
        assert_eq!(
            feature["plugin"],
            representative["name"]
                .as_str()
                .unwrap()
                .rsplit("::")
                .next()
                .unwrap()
        );
        assert_eq!(
            model["relations"]
                .as_array()
                .unwrap()
                .iter()
                .filter(
                    |relation| relation["kind"] == "registration" && relation["from"] == "app-main"
                )
                .count(),
            2
        );
        let only = plugins
            .iter()
            .find(|object| object["feature"] == "only_feature")
            .unwrap();
        let feature = features
            .iter()
            .find(|feature| feature["id"] == "only_feature")
            .unwrap();
        assert_eq!(feature["overviewNode"], only["id"]);
        assert_eq!(feature["plugin"], "OnlyPlugin");
        let application = features
            .iter()
            .find(|feature| feature["id"] == "application")
            .unwrap();
        assert_eq!(application["overviewNode"], "app-main");
        assert_eq!(application["plugin"], "App");
        let projection = json!({"objects":model["objects"],"relations":model["relations"],"features":model["features"]});
        if let Some(previous) = &previous {
            assert_eq!(previous, &projection);
        }
        previous = Some(projection);
    }
}

#[test]
fn automatic_feature_representatives_preserve_explicit_existing_choices() {
    let objects = BTreeMap::from([
        (
            "a-plugin".into(),
            json!({"id":"a-plugin","kind":"Plugin","feature":"feature","name":"crate::A"}),
        ),
        (
            "b-plugin".into(),
            json!({"id":"b-plugin","kind":"Plugin","feature":"feature","name":"crate::B"}),
        ),
    ]);
    for entry in [
        json!({"id":"feature","plugin":"Pinned label","overviewNode":"b-plugin"}),
        json!({"id":"feature","plugin":"Configured plugin label"}),
    ] {
        let mut features = BTreeMap::from([("feature".into(), entry.clone())]);
        finish_feature_overviews(&mut features, &objects);
        assert_eq!(features["feature"], entry);
    }
}

#[test]
fn helper_calls_preserve_immediate_and_queued_operation_contexts() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let source = facts["units"][0]["accesses"][0]["source"].clone();
    facts["units"][0]["calls"] = json!([
        {"caller":"callable","callee":"helper","source":source,"deferred":false},
        {"caller":"callable","callee":"helper","source":source,"deferred":true}
    ]);
    facts["units"][0]["operations"] = json!([{
        "id":"insert-in-helper","owner":"helper","method":"resolved-world-insert","targetType":"marker-type",
        "kind":"insert","deferred":false,"scope":"current","source":source,"callChain":[],"conditions":[source]
    }]);
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let inserts: Vec<_> = model["relations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|relation| relation["kind"] == "insert")
        .collect();
    assert_eq!(inserts.len(), 2);
    for relation in inserts {
        let operations = relation["bodyOperations"].as_array().unwrap();
        assert_eq!(operations.len(), 2);
        assert!(
            operations
                .iter()
                .any(|operation| operation["deferred"] == false)
        );
        assert!(
            operations
                .iter()
                .any(|operation| operation["deferred"] == true)
        );
        assert_eq!(operations[0]["callChain"][0]["path"], "src/main.rs");
        assert_eq!(operations[0]["conditions"][0]["path"], "src/main.rs");
    }
}

#[test]
fn automatic_system_sets_keep_real_ordering_endpoints() {
    let fixture = Fixture::new();
    let mut runtime = fixture.read("runtime.json");
    runtime["schedules"][0]["sets"] = json!([{"key":"automatic-second","graphName":"not-a-rendered-cluster","label":"SystemTypeSet(second)","typeId":"automatic-set-type","systemType":"system-runtime","conditions":[]}]);
    runtime["schedules"][0]["hierarchy"] = json!([{"from":"automatic-second","to":"second"}]);
    runtime["schedules"][0]["dependencies"] = json!([{"from":"first","to":"automatic-second"}]);
    fixture.replace_runtime(&runtime);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let relations = model["relations"].as_array().unwrap();
    let order: Vec<_> = relations
        .iter()
        .filter(|relation| relation["kind"] == "order")
        .collect();
    assert_eq!(order.len(), 1);
    assert_ne!(order[0]["from"], order[0]["to"]);
    assert_eq!(order[0]["nativeTo"], "automatic-second");
    assert!(
        !relations
            .iter()
            .any(|relation| relation["kind"] == "membership")
    );
    runtime["schedules"][0]["hierarchy"]
        .as_array_mut()
        .unwrap()
        .push(json!({"from":"automatic-second","to":"first"}));
    runtime["schedules"][0]["dependencies"] = json!([]);
    fixture.replace_runtime(&runtime);
    fixture.build().unwrap();
    assert!(
        !fixture.read("model.json")["relations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|relation| relation["kind"] == "membership")
    );
}

#[test]
fn system_and_set_conditions_own_their_access_evidence() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut declaration = facts["units"][0]["declarations"][0].clone();
    declaration["id"] = json!("predicate-declaration");
    declaration["fullName"] = json!("demo::sample::predicate");
    facts["units"][0]["declarations"]
        .as_array_mut()
        .unwrap()
        .push(declaration);
    let mut callable = facts["units"][0]["callables"][0].clone();
    callable["id"] = json!("predicate-callable");
    callable["declaration"] = json!("predicate-declaration");
    callable["systemTypeIds"] = json!(["predicate-runtime"]);
    facts["units"][0]["callables"]
        .as_array_mut()
        .unwrap()
        .push(callable);
    let mut access = facts["units"][0]["accesses"][0].clone();
    access["owner"] = json!("predicate-callable");
    access["mode"] = json!("read");
    facts["units"][0]["accesses"]
        .as_array_mut()
        .unwrap()
        .push(access);
    fixture.write("facts.json", &facts);
    let mut runtime = fixture.read("runtime.json");
    let condition = json!({"name":"predicate","typeId":"predicate-runtime"});
    runtime["schedules"][0]["systems"][0]["conditions"] = json!([condition]);
    runtime["schedules"][0]["sets"] = json!([{"key":"guarded-set","graphName":"clusternode_Set(guarded)","label":"native-anonymous-group","typeId":"anonymous-runtime","systemType":null,"anonymous":true,"conditions":[condition]}]);
    fixture.replace_runtime(&runtime);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let objects = model["objects"].as_array().unwrap();
    let predicates: Vec<_> = objects
        .iter()
        .filter(|object| object["runtimeTypeId"] == "predicate-runtime")
        .collect();
    assert_eq!(predicates.len(), 2);
    assert!(
        predicates
            .iter()
            .any(|object| object["registrationScope"] == "runtime-system-condition")
    );
    assert!(
        predicates
            .iter()
            .any(|object| object["registrationScope"] == "runtime-set-condition")
    );
    assert_eq!(
        model["relations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|relation| relation["kind"] == "read"
                && predicates
                    .iter()
                    .any(|predicate| predicate["id"] == relation["to"]))
            .count(),
        2
    );
}

#[test]
fn unrendered_dependency_source_is_still_verified() {
    let fixture = Fixture::new();
    let helper = fixture.root.join("helper.rs");
    fs::write(&helper, "fn unused_source_evidence() {}\n").unwrap();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["sourceFiles"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":helper,"sha256":digest(fs::read(&helper).unwrap())}));
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    fs::write(&helper, "fn changed_source_evidence() {}\n").unwrap();
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("Compiler fact source is stale")
    );
}

#[test]
fn composite_members_keep_independent_local_slots() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["accesses"][0]["storage"] = json!("Local");
    facts["units"][0]["accesses"][0]["parameter"] = json!("state");
    let mut callable = facts["units"][0]["callables"][0].clone();
    callable["id"] = json!("other-concrete-callable");
    callable["arguments"] = json!([{"kind":"const","value":"1"}]);
    facts["units"][0]["callables"]
        .as_array_mut()
        .unwrap()
        .push(callable);
    let mut access = facts["units"][0]["accesses"][0].clone();
    access["owner"] = json!("other-concrete-callable");
    facts["units"][0]["accesses"]
        .as_array_mut()
        .unwrap()
        .push(access);
    fixture.write("facts.json", &facts);

    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let locals: Vec<_> = model["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|object| object["kind"] == "Local")
        .collect();
    assert_eq!(locals.len(), 4);
    assert_eq!(
        locals
            .iter()
            .map(|object| object["id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        4
    );
}

#[test]
fn unit_and_type_analysis_gaps_are_never_discarded() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["gaps"] = json!([
        {"owner":"unit","kind":"mir-budget","reason":"已达到实例分析预算。","source":null},
        {"owner":"marker-type","kind":"type-recursion","reason":"该类型的递归展开达到边界。","source":null}
    ]);
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert_eq!(model["analysisGaps"].as_array().unwrap().len(), 2);
    assert!(model["objects"].as_array().unwrap().iter().any(|object| {
        object["typeInstanceId"] == "marker-type"
            && object["sourceGaps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|gap| gap == "该类型的递归展开达到边界。")
    }));
}

#[test]
fn events_flow_to_receivers_and_triggers_flow_to_events() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["types"][0]["roles"] = json!(["Event"]);
    facts["units"][0]["accesses"][0]["mode"] = json!("event");
    facts["units"][0]["accesses"][0]["storage"] = json!("Event");
    facts["units"][0]["operations"] = json!([{"id":"trigger-event","owner":"callable","method":"resolved-trigger","targetType":"marker-type","kind":"trigger","deferred":false,"scope":"current","source":null,"callChain":[],"conditions":[]}]);
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let event = &model["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|object| object["kind"] == "Event")
        .unwrap()["id"];
    let relations = model["relations"].as_array().unwrap();
    assert_eq!(
        relations
            .iter()
            .filter(|relation| relation["kind"] == "event" && relation["from"] == *event)
            .count(),
        2
    );
    assert_eq!(
        relations
            .iter()
            .filter(|relation| relation["kind"] == "trigger" && relation["to"] == *event)
            .count(),
        2
    );
}

#[test]
fn unresolved_entity_operation_keeps_fact_and_context_without_inventing_template() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["operations"] = json!([{"id":"despawn-runtime-entity","owner":"callable","method":"resolved-despawn","targetType":null,"kind":"despawn","deferred":true,"scope":"current","source":null,"callChain":[],"conditions":[]}]);
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert!(
        !model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|object| object["kind"] == "Entity")
    );
    let gap = &model["analysisGaps"][0];
    assert_eq!(gap["kind"], "operation-target");
    assert_eq!(gap["operation"]["id"], "despawn-runtime-entity");
    assert_eq!(
        gap["operation"]["callContexts"].as_array().unwrap().len(),
        2
    );
    assert!(
        gap["operation"]["callContexts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|context| context["deferred"] == true)
    );
}

#[test]
fn generic_bounds_and_opaque_types_keep_access_facts_without_concrete_objects() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.types.extend([
        TypeInstance {
            id: "generic-component".into(),
            display: "C".into(),
            kind: "parameter".into(),
            roles: vec!["Component".into()],
            ..Default::default()
        },
        TypeInstance {
            id: "opaque-component".into(),
            declaration: Some("marker-declaration".into()),
            display: "impl Component".into(),
            kind: "projection".into(),
            roles: vec!["Component".into()],
            ..Default::default()
        },
        TypeInstance {
            id: "generic-plugin".into(),
            declaration: Some("marker-declaration".into()),
            display: "Plugin<C>".into(),
            kind: "adt".into(),
            roles: vec!["Plugin".into()],
            arguments: vec![TypeArgument {
                kind: "type".into(),
                value: "generic-component".into(),
            }],
            ..Default::default()
        },
        TypeInstance {
            id: "generic-self".into(),
            declaration: Some("marker-declaration".into()),
            display: "Self".into(),
            kind: "parameter".into(),
            roles: vec!["Plugin".into()],
            ..Default::default()
        },
        TypeInstance {
            id: "generic-array".into(),
            display: "[Marker; N]".into(),
            kind: "array".into(),
            arguments: vec![TypeArgument {
                kind: "type".into(),
                value: "marker-type".into(),
            }],
            ..Default::default()
        },
    ]);
    unit.accesses[0].type_id = "generic-component".into();
    let mut local = unit.accesses[0].clone();
    local.storage = "Local".into();
    local.parameter = "local-state".into();
    unit.accesses.push(local);
    let mut array = unit.accesses[1].clone();
    array.type_id = "generic-array".into();
    array.parameter = "array-state".into();
    unit.accesses.push(array);
    unit.operations.push(OperationFact {
        id: "opaque-write".into(),
        owner: "callable".into(),
        method: "resolved-write".into(),
        target_type: Some("opaque-component".into()),
        kind: "modify".into(),
        scope: "typed-value".into(),
        ..Default::default()
    });
    facts["units"][0] = serde_json::to_value(unit).unwrap();
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");

    assert!(
        model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .all(|object| !matches!(
                object["typeInstanceId"].as_str(),
                Some("generic-component" | "opaque-component" | "generic-plugin" | "generic-self")
            ) && object["kind"] != "Local")
    );
    let gaps = model["analysisGaps"].as_array().unwrap();
    assert!(gaps.iter().any(|gap| gap["kind"] == "type-resolution"
        && gap["owner"] == "generic-plugin"
        && gap["unresolvedType"] == "generic-component"));
    assert!(gaps.iter().any(|gap| gap["kind"] == "access-target"
        && gap["access"]["storage"] == "Component"
        && gap["access"]["typeId"] == "generic-component"
        && gap["access"]["source"]["path"] == "src/main.rs"
        && gap["access"]["source"]["endColumn"] == 15));
    assert!(gaps.iter().any(|gap| gap["kind"] == "access-target"
        && gap["access"]["storage"] == "Local"
        && gap["access"]["parameter"] == "local-state"));
    assert!(
        gaps.iter()
            .any(|gap| gap["kind"] == "access-target" && gap["unresolvedType"] == "generic-array")
    );
    assert!(
        gaps.iter().any(
            |gap| gap["kind"] == "operation-target" && gap["operation"]["id"] == "opaque-write"
        )
    );
}

#[test]
fn helper_local_values_preserve_origin_gaps_without_allocating_caller_storage() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let mut helper_declaration = unit.declarations[0].clone();
    helper_declaration.id = "helper-declaration".into();
    helper_declaration.full_name = "demo::sample::registered_helper".into();
    helper_declaration.name = "registered_helper".into();
    unit.declarations.push(helper_declaration);
    unit.callables.push(Callable {
        id: "registered-helper".into(),
        declaration: "helper-declaration".into(),

        display: "demo::sample::registered_helper".into(),
        system_type_ids: vec!["helper-runtime".into()],
        ..Default::default()
    });
    unit.callables.push(Callable {
        id: "result-helper".into(),
        declaration: "helper-declaration".into(),

        display: "demo::sample::registered_helper".into(),
        ..Default::default()
    });
    unit.accesses[0].storage = "Local".into();
    unit.accesses[0].parameter = "state".into();
    let mut helper_access = unit.accesses[0].clone();
    helper_access.owner = "registered-helper".into();
    helper_access.parameter = "cache".into();
    unit.accesses.push(helper_access);
    let mut indirect = unit.accesses[0].clone();
    indirect.owner = "result-helper".into();
    indirect.parameter = "arg0.0".into();
    indirect.source = None;
    unit.accesses.push(indirect);
    unit.calls.extend([
        CallFact {
            caller: "callable".into(),
            callee: Some("registered-helper".into()),
            ..Default::default()
        },
        CallFact {
            caller: "registered-helper".into(),
            callee: Some("result-helper".into()),
            ..Default::default()
        },
    ]);
    facts["units"][0] = serde_json::to_value(unit).unwrap();
    fixture.write("facts.json", &facts);
    let mut runtime = fixture.read("runtime.json");
    runtime["schedules"][0]["systems"][1]["typeId"] = json!("helper-runtime");
    fixture.replace_runtime(&runtime);

    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let objects = model["objects"].as_array().unwrap();
    let locals: Vec<_> = objects
        .iter()
        .filter(|object| object["kind"] == "Local")
        .collect();
    assert_eq!(locals.len(), 2);
    assert!(
        locals
            .iter()
            .all(|object| object["callableId"] != "result-helper")
    );
    let helper_root = objects
        .iter()
        .find(|object| object["runtimeTypeId"] == "helper-runtime")
        .unwrap();
    let helper_local = locals
        .iter()
        .find(|object| object["callableId"] == "registered-helper")
        .unwrap();
    let linked: Vec<_> = model["relations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|relation| relation["to"] == helper_local["id"])
        .collect();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0]["from"], helper_root["id"]);
    let gaps = model["analysisGaps"].as_array().unwrap();
    assert!(gaps.iter().any(|gap| gap["kind"] == "local-origin"
        && gap["owner"] == "registered-helper"
        && gap["rootOwners"].as_array().unwrap().len() == 1
        && gap["registeredOwners"].as_array().unwrap().len() == 1));
    assert!(gaps.iter().any(|gap| gap["kind"] == "local-origin"
        && gap["owner"] == "result-helper"
        && gap["registeredOwners"].as_array().unwrap().len() == 2
        && gap["rootOwners"].as_array().unwrap().is_empty()
        && gap["access"]["parameter"] == "arg0.0"));
}

#[test]
fn creation_operations_bind_only_unique_root_templates_at_the_same_compiler_callsite() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let source = unit.accesses[0].source.clone();
    let mut method_source = source.clone().unwrap();
    method_source.column = 4;
    let root = EntityTemplate {
        id: "root-template".into(),
        creator: "callable".into(),
        source: Some(method_source.clone()),
        components: vec!["marker-type".into()],
        children: vec!["child-template".into()],
        ..Default::default()
    };
    let child = EntityTemplate {
        id: "child-template".into(),
        creator: "callable".into(),
        source: Some(method_source),
        ..Default::default()
    };
    unit.operations.push(OperationFact {
        id: "create-root".into(),
        owner: "callable".into(),
        method: "resolved-spawn".into(),
        target_type: None,
        kind: "create".into(),
        deferred: true,
        scope: "current".into(),
        source: source.clone(),
        conditions: source.into_iter().collect(),
        ..Default::default()
    });
    unit.entities.extend([root, child]);

    facts["units"][0] = serde_json::to_value(&unit).unwrap();
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert!(model["analysisGaps"].as_array().unwrap().is_empty());
    let root_id = identifier("entity", "root-template");
    let create: Vec<_> = model["relations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|relation| relation["kind"] == "create" && relation["to"] == root_id)
        .collect();
    assert_eq!(create.len(), 2);
    for relation in create {
        assert_eq!(relation["bodyOperations"][0]["operationId"], "create-root");
        assert_eq!(relation["bodyOperations"][0]["deferred"], true);
        assert_eq!(
            relation["bodyOperations"][0]["conditions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let operation = &unit.operations[0];
    let mut ambiguous = unit.entities.clone();
    let mut second = ambiguous[0].clone();
    second.id = "another-root".into();
    ambiguous.push(second);
    assert!(creation_target(operation, &creation_templates(&ambiguous)).is_none());
    let mut other_owner = operation.clone();
    other_owner.owner = "other-callable".into();
    assert!(creation_target(&other_owner, &creation_templates(&unit.entities)).is_none());
    let mut other_end = operation.clone();
    other_end.source.as_mut().unwrap().end_column += 1;
    assert!(creation_target(&other_end, &creation_templates(&unit.entities)).is_none());
    let mut other_expansion = operation.clone();
    other_expansion
        .source
        .as_mut()
        .unwrap()
        .expansions
        .push(Expansion {
            name: "another-macro".into(),
            ..Default::default()
        });
    assert!(creation_target(&other_expansion, &creation_templates(&unit.entities)).is_none());
}

#[test]
fn tuple_bundle_operations_keep_known_components_and_the_unresolved_remainder() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.types.extend([
        TypeInstance {
            id: "opaque-bundle".into(),
            display: "impl Bundle".into(),
            kind: "projection".into(),
            roles: vec!["Bundle".into()],
            ..Default::default()
        },
        TypeInstance {
            id: "partial-tuple".into(),
            kind: "tuple".into(),
            arguments: vec![
                TypeArgument {
                    kind: "type".into(),
                    value: "opaque-bundle".into(),
                },
                TypeArgument {
                    kind: "type".into(),
                    value: "marker-type".into(),
                },
            ],
            ..Default::default()
        },
        TypeInstance {
            id: "manual-bundle".into(),
            kind: "adt".into(),
            roles: vec!["Bundle".into()],
            fields: vec![TypeField {
                name: "unrelated-field".into(),
                type_id: "marker-type".into(),
                ..Default::default()
            }],
            ..Default::default()
        },
    ]);
    for target in ["partial-tuple", "manual-bundle"] {
        unit.operations.push(OperationFact {
            id: format!("insert-{target}"),
            owner: "callable".into(),
            method: "resolved-insert".into(),
            target_type: Some(target.into()),
            kind: "insert".into(),
            scope: "current".into(),
            ..Default::default()
        });
    }
    facts["units"][0] = serde_json::to_value(unit).unwrap();
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let insert: Vec<_> = model["relations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|relation| relation["kind"] == "insert")
        .collect();
    assert_eq!(insert.len(), 2);
    assert!(insert.iter().all(
        |relation| relation["bodyOperations"].as_array().unwrap().len() == 1
            && relation["bodyOperations"][0]["operationId"] == "insert-partial-tuple"
    ));
    let gaps = model["analysisGaps"].as_array().unwrap();
    let partial = gaps
        .iter()
        .find(|gap| gap["operation"]["id"] == "insert-partial-tuple")
        .unwrap();
    assert_eq!(
        partial["operation"]["unresolvedParts"],
        json!(["opaque-bundle"])
    );
    assert_eq!(
        partial["operation"]["resolvedTargets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        gaps.iter()
            .any(|gap| gap["operation"]["id"] == "insert-manual-bundle")
    );
}

#[test]
fn repeated_dependency_gaps_merge_all_unit_provenance_without_duplicate_source_gaps() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["gaps"] = json!([{"owner":"callable","kind":"dynamic-call","reason":"回调目标在运行时决定。","source":null}]);
    let mut second = facts["units"][0].clone();
    second["crateIdentity"] = json!("second-unit");
    facts["units"].as_array_mut().unwrap().push(second);
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let gaps = model["analysisGaps"].as_array().unwrap();
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0]["units"], json!(["compiled-crate", "second-unit"]));
    for object in model["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|object| object["kind"] == "System")
    {
        assert_eq!(object["sourceGaps"], json!(["回调目标在运行时决定。"]));
    }
}

#[test]
fn structure_alternatives_preserve_group_boundaries_sources_and_real_children() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let source = unit.declarations[0].source.clone();
    let mut button = unit.types[0].clone();
    button.id = "button-type".into();
    button.runtime_type_id = Some("button-runtime".into());
    unit.types.push(button);
    let mut extra_source = source.clone().unwrap();
    extra_source.line = 2;
    extra_source.end_line = 2;
    extra_source.expansions.push(Expansion {
        name: "fixture-macro".into(),
        path: extra_source.path.clone(),
        line: 2,
        column: 1,
    });
    let group = |id: &str, candidates: Vec<&str>| EntityAlternativeGroup {
        id: id.into(),
        candidates: candidates.into_iter().map(str::to_owned).collect(),
        source: source.clone(),
        selection: "one-of".into(),
    };
    unit.entities.push(EntityTemplate {
        id: "choice-host".into(),
        creator: "callable".into(),
        source: source.clone(),
        alternatives: vec![
            group("shape-choice", vec!["text-choice", "button-choice"]),
            group("independent-choice", vec!["other-a", "other-b"]),
        ],
        gaps: vec![Gap {
            owner: "choice-host".into(),
            kind: "entity-alternative".into(),
            reason: "具体分支条件尚未导出；独立候选组不组合。".into(),
            source: source.clone(),
        }],
        ..Default::default()
    });
    for (id, component, child, group) in [
        (
            "text-choice",
            "marker-type",
            Some("text-child"),
            "shape-choice",
        ),
        (
            "button-choice",
            "button-type",
            Some("button-child"),
            "shape-choice",
        ),
        ("other-a", "marker-type", None, "independent-choice"),
        ("other-b", "button-type", None, "independent-choice"),
    ] {
        unit.entities.push(EntityTemplate {
            id: id.into(),
            creator: "callable".into(),
            source: source.clone(),
            components: vec![component.into()],
            children: child.into_iter().map(str::to_owned).collect(),
            alternative_group: Some(group.into()),
            alternative_selection: Some("one-of".into()),
            alternative_context: vec![group.into()],
            possible: true,
            source_evidence: vec![extra_source.clone()],
            ..Default::default()
        });
        if let Some(child) = child {
            unit.entities.push(EntityTemplate {
                id: child.into(),
                creator: "callable".into(),
                source: source.clone(),
                components: vec![component.into()],
                alternative_context: vec![group.into()],
                possible: true,
                ..Default::default()
            });
        }
    }
    unit.operations.push(OperationFact {
        id: "spawn-host".into(),
        owner: "callable".into(),
        method: "resolved-spawn".into(),
        kind: "create".into(),
        source: source.clone(),
        ..Default::default()
    });

    facts["units"][0] = serde_json::to_value(unit).unwrap();
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let objects = model["objects"].as_array().unwrap();
    let relations = model["relations"].as_array().unwrap();
    let host = objects
        .iter()
        .find(|object| object["templateId"] == "choice-host")
        .unwrap();
    assert_eq!(host["alternativeGroups"].as_array().unwrap().len(), 2);
    let alternative: Vec<_> = relations
        .iter()
        .filter(|relation| relation["kind"] == "alternative")
        .collect();
    assert_eq!(alternative.len(), 4);
    assert!(
        alternative
            .iter()
            .all(|relation| relation["from"] == host["id"]
                && relation["possible"] == true
                && relation["selection"] == "one-of")
    );
    for (candidate, child, component) in [
        ("text-choice", "text-child", "marker-type"),
        ("button-choice", "button-child", "button-type"),
    ] {
        let candidate = objects
            .iter()
            .find(|object| object["templateId"] == candidate)
            .unwrap();
        let child = objects
            .iter()
            .find(|object| object["templateId"] == child)
            .unwrap();
        assert_eq!(candidate["alternativeGroup"], "shape-choice");
        assert_eq!(child["alternativeContext"], json!(["shape-choice"]));
        assert!(
            candidate["sourceEntries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["line"] == 2
                    && !entry["expansions"].as_array().unwrap().is_empty())
        );
        assert!(
            relations
                .iter()
                .any(|relation| relation["from"] == candidate["id"]
                    && relation["to"] == child["id"]
                    && relation["kind"] == "relationship"
                    && relation["possible"] == true)
        );
        let contains: Vec<_> = relations
            .iter()
            .filter(|relation| {
                relation["from"] == candidate["id"] && relation["kind"] == "contains"
            })
            .collect();
        assert_eq!(contains.len(), 1);
        assert_eq!(
            contains[0]["to"],
            identifier("type", (component, "Component"))
        );
        assert_eq!(contains[0]["alternativeContext"], json!(["shape-choice"]));
        assert!(
            !relations.iter().any(|relation| relation["kind"] == "create"
                && (relation["to"] == candidate["id"] || relation["to"] == child["id"]))
        );
    }
    assert!(
        !relations
            .iter()
            .any(|relation| relation["kind"] == "contains" && relation["from"] == host["id"])
    );
    assert_eq!(
        relations
            .iter()
            .filter(|relation| relation["kind"] == "create")
            .count(),
        2
    );
    assert!(
        model["analysisGaps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|gap| gap["kind"] == "entity-alternative")
    );
}

#[test]
fn resource_supertrait_does_not_reclassify_resource_as_component() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["types"][0]["roles"] = json!(["Component", "Resource"]);
    facts["units"][0]["accesses"][0]["storage"] = json!("Resource");
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert_eq!(
        model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|object| object["kind"] == "Resource")
            .count(),
        1
    );
    assert!(
        !model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|object| object["kind"] == "Component")
    );
}

#[test]
fn runtime_access_without_compiler_type_is_reported_explicitly() {
    let fixture = Fixture::new();
    let mut runtime = fixture.read("runtime.json");
    runtime["schedules"][0]["systems"][0]["accesses"] =
        json!([{"typeId":"unknown-type","name":"runtime-created data","mode":"read"}]);
    fixture.replace_runtime(&runtime);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert_eq!(model["analysisGaps"][0]["kind"], "runtime-access-type");
    assert_eq!(model["analysisGaps"][0]["access"]["typeId"], "unknown-type");
    assert!(
        !model["objects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|object| object["name"] == "runtime-created data")
    );
}

#[test]
fn owning_unit_hir_evidence_wins_regardless_of_unit_order() {
    for foreign_first in [true, false] {
        let fixture = Fixture::new();
        let mut facts = fixture.read("facts.json");
        let mut local = facts["units"][0].clone();
        local["declarations"][0]["local"] = json!(true);
        let mut foreign = local.clone();
        foreign["crateName"] = json!("dependency-consumer");
        foreign["crateIdentity"] = json!("another-compiled-unit");
        foreign["declarations"][0]["local"] = json!(false);
        foreign["declarations"][0]["source"] = json!(null);
        facts["units"] = if foreign_first {
            json!([foreign, local])
        } else {
            json!([local, foreign])
        };
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
    }
}

#[test]
fn conflicting_owning_unit_structures_are_rejected() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut first = facts["units"][0].clone();
    first["declarations"][0]["local"] = json!(true);
    let mut second = first.clone();
    second["crateIdentity"] = json!("another-native-cfg-unit");
    second["accesses"][0]["mode"] = json!("shared_access");
    for units in [json!([first, second]), json!([second, first])] {
        facts["units"] = units;
        fixture.write("facts.json", &facts);
        let error = fixture.build().unwrap_err().to_string();
        assert!(
            error.contains("Conflicting owning-unit architecture structure"),
            "{error}"
        );
    }
}

#[test]
fn helper_ownership_does_not_expand_static_registration_targets() {
    let fixture = Fixture::new();
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let source = unit.declarations[0].source.clone();
    unit.declarations[0].full_name = "demo::sample::foo".into();
    unit.declarations[0].name = "foo".into();
    unit.callables[0].display = "demo::sample::foo".into();
    unit.declarations.extend([
        Declaration {
            id: "bar-declaration".into(),
            local: true,
            full_name: "demo::sample::bar".into(),
            name: "bar".into(),
            crate_name: "demo".into(),
            kind: "Fn".into(),
            source: source.clone(),
            ..Default::default()
        },
        Declaration {
            id: "plugin-b-declaration".into(),
            full_name: "demo::sample::PluginB".into(),
            name: "PluginB".into(),
            crate_name: "demo".into(),
            kind: "Struct".into(),
            source: source.clone(),
            ..Default::default()
        },
        Declaration {
            id: "plugin-b-build-declaration".into(),
            local: true,
            full_name: "demo::sample::PluginB::build".into(),
            name: "build".into(),
            crate_name: "demo".into(),
            kind: "AssocFn".into(),
            source: source.clone(),
            ..Default::default()
        },
    ]);
    unit.types.extend([
        TypeInstance {
            id: "plugin-b-type".into(),
            declaration: Some("plugin-b-declaration".into()),
            display: "demo::sample::PluginB".into(),
            kind: "adt".into(),
            roles: vec!["Plugin".into()],
            ..Default::default()
        },
        TypeInstance {
            id: "plugin-b-reference".into(),
            kind: "reference".into(),
            arguments: vec![TypeArgument {
                kind: "type".into(),
                value: "plugin-b-type".into(),
            }],
            ..Default::default()
        },
    ]);
    unit.callables.extend([
        Callable {
            id: "bar-callable".into(),
            declaration: "bar-declaration".into(),

            display: "demo::sample::bar".into(),
            system_type_ids: vec!["bar-runtime".into()],
            ..Default::default()
        },
        Callable {
            id: "plugin-b-build".into(),
            declaration: "plugin-b-build-declaration".into(),

            display: "demo::sample::PluginB::build".into(),
            parameters: vec![Parameter {
                slot: "self".into(),
                type_id: "plugin-b-reference".into(),
                source: source.clone(),
            }],
            ..Default::default()
        },
    ]);
    unit.calls.push(CallFact {
        caller: "callable".into(),
        callee: Some("bar-callable".into()),
        declaration: Some("bar-declaration".into()),
        source: source.clone(),
        ..Default::default()
    });
    unit.accesses.push(AccessFact {
        owner: "bar-callable".into(),
        type_id: "marker-type".into(),
        mode: "read".into(),
        storage: "Component".into(),
        scope: "current".into(),
        parameter: "query".into(),
        source: source.clone(),
    });
    unit.registrations.push(RegistrationFact {
        owner: "plugin-b-build".into(),
        kind: "add_systems".into(),
        target: Some("bar-callable".into()),
        source,
        ..Default::default()
    });
    facts["units"][0] = serde_json::to_value(unit).unwrap();
    fixture.write("facts.json", &facts);
    let mut runtime = fixture.read("runtime.json");
    runtime["schedules"][0]["systems"][0]["name"] = json!("foo");
    runtime["schedules"][0]["systems"][1]["name"] = json!("bar");
    runtime["schedules"][0]["systems"][1]["typeId"] = json!("bar-runtime");
    fixture.replace_runtime(&runtime);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    let objects = model["objects"].as_array().unwrap();
    let foo = objects
        .iter()
        .find(|object| object["runtimeTypeId"] == "system-runtime")
        .unwrap();
    let bar = objects
        .iter()
        .find(|object| object["runtimeTypeId"] == "bar-runtime")
        .unwrap();
    let plugin = objects
        .iter()
        .find(|object| object["typeInstanceId"] == "plugin-b-type")
        .unwrap();
    let relations = model["relations"].as_array().unwrap();
    // foo 继承 bar 的访问证据，注册归属仍只连接真正注册的 bar 实例。
    assert!(
        relations
            .iter()
            .any(|relation| relation["kind"] == "read" && relation["to"] == foo["id"])
    );
    let registered: Vec<_> = relations
        .iter()
        .filter(|relation| relation["kind"] == "registration" && relation["from"] == plugin["id"])
        .map(|relation| relation["to"].clone())
        .collect();
    assert_eq!(registered, vec![bar["id"].clone()]);
}
