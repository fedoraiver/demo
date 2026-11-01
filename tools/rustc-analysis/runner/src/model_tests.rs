//! 模型消费真实身份而非显示名；夹具只模拟编译器和装配边界的数据。
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(with_description: bool) -> Self {
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
            schema_version: 1,
            crate_name: "demo".into(),
            crate_identity: "compiled-crate".into(),
            source_files: vec![SourceFile {
                path: source.path.clone(),
                sha256: source.sha256.clone(),
            }],
            declarations: vec![
                Declaration {
                    id: "function".into(),
                    full_name: "demo::sample::system".into(),
                    name: "system".into(),
                    crate_name: "demo".into(),
                    kind: "Fn".into(),
                    source: Some(source.clone()),
                    evidence_hash: "body".into(),
                    ..Default::default()
                },
                Declaration {
                    id: "marker-declaration".into(),
                    full_name: "demo::sample::Marker".into(),
                    name: "Marker".into(),
                    crate_name: "demo".into(),
                    kind: "Struct".into(),
                    source: Some(source.clone()),
                    docs: "标识需要处理的实体。".into(),
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
        fixture.write("facts.json", &json!({"schemaVersion":1,"compiler":"fixed-compiler","configuration":"same-build","workspace":fixture.root,"packages":[],"units":[unit],"runtimeSha256":digest(fs::read(fixture.root.join("runtime.json")).unwrap())}));
        let items = if with_description {
            json!({"demo::sample::system":{"description":"处理带标记的实体。","summary":"处理实体。","evidenceHash":"body"}})
        } else {
            json!({})
        };
        fixture.write(
            "annotations.json",
            &json!({"schemaVersion":1,"items":items}),
        );
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
            &self.root.join("annotations.json"),
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
    let fixture = Fixture::new(true);
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
fn repeated_registration_retains_instances_and_access_capability() {
    let fixture = Fixture::new(true);
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
fn same_display_name_cannot_substitute_for_runtime_type_identity() {
    let fixture = Fixture::new(true);
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
fn missing_description_produces_a_source_backed_request() {
    let fixture = Fixture::new(false);
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("Chinese descriptions are pending")
    );
    let pending = fixture.read("pending-descriptions.json");
    assert_eq!(pending[0]["key"], "demo::sample::system");
    assert_eq!(pending[0]["evidenceHash"], "body");
    assert_eq!(pending[0]["sourceEntries"][0]["path"], "src/main.rs");
}

#[test]
fn changed_source_and_mixed_builds_are_rejected() {
    let fixture = Fixture::new(true);
    fs::write(fixture.root.join("src/main.rs"), "fn replacement() {}\n").unwrap();
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("fingerprint is stale")
    );
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["accesses"][0]["storage"] = json!("Local");
    facts["units"][0]["accesses"][0]["parameter"] = json!("state");
    fixture.write("facts.json", &facts);
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system|state"] = json!({"description":"保存该系统实例的处理进度。","summary":"保存处理进度。","evidenceHash":"body"});
    fixture.write("annotations.json", &annotations);
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
}

#[test]
fn stale_or_unbound_prose_requires_new_evidence() {
    for hash in [Some("previous-body"), None] {
        let fixture = Fixture::new(true);
        let mut annotations = fixture.read("annotations.json");
        if let Some(hash) = hash {
            annotations["items"]["demo::sample::system"]["evidenceHash"] = json!(hash);
        } else {
            annotations["items"]["demo::sample::system"]
                .as_object_mut()
                .unwrap()
                .remove("evidenceHash");
        }
        fixture.write("annotations.json", &annotations);
        assert!(
            fixture
                .build()
                .unwrap_err()
                .to_string()
                .contains("Chinese descriptions are pending")
        );
        let pending = fixture.read("pending-descriptions.json");
        assert_eq!(pending[0]["previousDescription"], "处理带标记的实体。");
        assert_eq!(pending[0]["evidenceHash"], "body");
    }
}

#[test]
fn helper_calls_preserve_immediate_and_queued_operation_contexts() {
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
fn changing_a_reachable_helper_invalidates_system_prose() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut helper = facts["units"][0]["declarations"][0].clone();
    helper["id"] = json!("helper-declaration");
    helper["fullName"] = json!("demo::sample::helper");
    helper["evidenceHash"] = json!("helper-before");
    facts["units"][0]["declarations"]
        .as_array_mut()
        .unwrap()
        .push(helper);
    let mut callable = facts["units"][0]["callables"][0].clone();
    callable["id"] = json!("helper-callable");
    callable["declaration"] = json!("helper-declaration");
    callable["systemTypeIds"] = json!([]);
    facts["units"][0]["callables"]
        .as_array_mut()
        .unwrap()
        .push(callable);
    facts["units"][0]["calls"] =
        json!([{"caller":"callable","callee":"helper-callable","source":null,"deferred":false}]);
    fixture.write("facts.json", &facts);
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("Chinese descriptions are pending")
    );
    let old_hash = fixture.read("pending-descriptions.json")[0]["evidenceHash"].clone();
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system"]["evidenceHash"] = old_hash.clone();
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();
    facts["units"][0]["declarations"][2]["evidenceHash"] = json!("helper-after");
    fixture.write("facts.json", &facts);
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("Chinese descriptions are pending")
    );
    assert_ne!(
        fixture.read("pending-descriptions.json")[0]["evidenceHash"],
        old_hash
    );
}

#[test]
fn system_and_set_conditions_own_their_access_evidence() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut declaration = facts["units"][0]["declarations"][0].clone();
    declaration["id"] = json!("predicate-declaration");
    declaration["fullName"] = json!("demo::sample::predicate");
    declaration["docs"] = json!("判断是否执行当前工作。");
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
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system|state"] = json!({"description":"保存该成员实例的处理状态。","summary":"保存成员状态。","evidenceHash":"body"});
    fixture.write("annotations.json", &annotations);
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
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
fn resource_supertrait_does_not_reclassify_resource_as_component() {
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
        let fixture = Fixture::new(true);
        let mut facts = fixture.read("facts.json");
        let mut local = facts["units"][0].clone();
        local["declarations"][0]["local"] = json!(true);
        let mut foreign = local.clone();
        foreign["crateName"] = json!("dependency-consumer");
        foreign["crateIdentity"] = json!("another-compiled-unit");
        foreign["declarations"][0]["local"] = json!(false);
        foreign["declarations"][0]["evidenceHash"] = json!("conservative-file-hash");
        facts["units"] = if foreign_first {
            json!([foreign, local])
        } else {
            json!([local, foreign])
        };
        fixture.write("facts.json", &facts);
        fixture.build().unwrap();
        assert!(
            fixture.read("model.json")["annotationsRequired"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn helper_ownership_does_not_expand_static_registration_targets() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let source = unit.declarations[0].source.clone();
    unit.declarations[0].full_name = "demo::sample::foo".into();
    unit.declarations[0].name = "foo".into();
    unit.declarations[0].docs = "执行自身工作，并调用共享辅助逻辑。".into();
    unit.callables[0].display = "demo::sample::foo".into();
    unit.declarations.extend([
        Declaration {
            id: "bar-declaration".into(),
            full_name: "demo::sample::bar".into(),
            name: "bar".into(),
            crate_name: "demo".into(),
            kind: "Fn".into(),
            docs: "执行独立工作，也可供其他函数调用。".into(),
            source: source.clone(),
            ..Default::default()
        },
        Declaration {
            id: "plugin-b-declaration".into(),
            full_name: "demo::sample::PluginB".into(),
            name: "PluginB".into(),
            crate_name: "demo".into(),
            kind: "Struct".into(),
            docs: "注册独立工作系统。".into(),
            source: source.clone(),
            ..Default::default()
        },
        Declaration {
            id: "plugin-b-build-declaration".into(),
            full_name: "demo::sample::PluginB::build".into(),
            name: "build".into(),
            crate_name: "demo".into(),
            kind: "AssocFn".into(),
            docs: "将独立工作系统加入调度。".into(),
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
