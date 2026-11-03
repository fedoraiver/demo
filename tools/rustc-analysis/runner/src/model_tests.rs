//! 模型消费真实身份而非显示名；夹具只模拟编译器和装配边界的数据。
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn entity_purpose_reuses_semantics_after_source_only_changes() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut entity = EntityTemplate {
        id: "stable-template".into(),
        creator: "callable".into(),
        source: serde_json::from_value(facts["units"][0]["accesses"][0]["source"].clone()).unwrap(),
        components: vec!["marker-type".into()],
        ..Default::default()
    };
    facts["units"][0]["entities"] = json!([entity]);
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let pending = fixture.read("pending-descriptions.json");
    let purpose = pending
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "Entity")
        .unwrap();
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["entity:stable-template"] = json!({"description":"在该创建点装配需要处理的标记实体。","summary":"装配标记实体。","evidenceHash":purpose["evidenceHash"]});
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();

    // 位置和完整文件校验随输入更新；声明、装配与用途语义保持不变。
    let contents = "\n\n\nfn system() {}\nstruct Marker;\nconst UNRELATED: u32 = 10;\n";
    fs::write(fixture.root.join("src/main.rs"), contents).unwrap();
    let hash = digest(contents);
    for declaration in facts["units"][0]["declarations"].as_array_mut().unwrap() {
        declaration["source"]["sha256"] = json!(hash);
        declaration["source"]["line"] = json!(4);
        declaration["source"]["endLine"] = json!(4);
    }
    facts["units"][0]["sourceFiles"][0]["sha256"] = json!(hash);
    facts["units"][0]["accesses"][0]["source"]["sha256"] = json!(hash);
    let source = entity.source.as_mut().unwrap();
    source.sha256 = hash;
    source.line += 3;
    source.end_line += 3;
    facts["units"][0]["entities"] = json!([entity]);
    fixture.write("facts.json", &facts);
    let mut runtime = fixture.read("runtime.json");
    runtime["sourceFingerprint"] = json!(source_fingerprint(&fixture.root).unwrap());
    fixture.replace_runtime(&runtime);
    let mut manifest = fixture.read("debugdump/manifest.json");
    manifest["sourceFingerprint"] = runtime["sourceFingerprint"].clone();
    fixture.write("debugdump/manifest.json", &manifest);
    fixture
        .build()
        .expect("Source-only movement must reuse the entity purpose");

    let mut facts = fixture.read("facts.json");
    facts["units"][0]["entities"][0]["components"] = json!([]);
    fixture.write("facts.json", &facts);
    assert!(
        fixture.build().is_err(),
        "An assembly change must invalidate the purpose"
    );
}

#[test]
fn entity_purpose_tracks_creator_and_reachable_helper_behavior() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["entities"] = json!([EntityTemplate {
        id: "semantic-template".into(),
        creator: "callable".into(),
        source: serde_json::from_value(facts["units"][0]["accesses"][0]["source"].clone()).unwrap(),
        ..Default::default()
    }]);
    let mut helper = facts["units"][0]["declarations"][0].clone();
    helper["id"] = json!("helper-definition");
    helper["name"] = json!("helper");
    helper["fullName"] = json!("demo::sample::helper");
    helper["evidenceHash"] = json!("helper-initializer-before");
    facts["units"][0]["declarations"]
        .as_array_mut()
        .unwrap()
        .push(helper);
    let mut callable = facts["units"][0]["callables"][0].clone();
    callable["id"] = json!("helper-callable");
    callable["declaration"] = json!("helper-definition");
    callable["display"] = json!("demo::sample::helper");
    callable["systemTypeIds"] = json!([]);
    facts["units"][0]["callables"]
        .as_array_mut()
        .unwrap()
        .push(callable);
    facts["units"][0]["calls"] = json!([CallFact {
        caller: "callable".into(),
        callee: Some("helper-callable".into()),
        declaration: Some("helper-definition".into()),
        ..Default::default()
    }]);
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let mut annotations = fixture.read("annotations.json");
    for purpose in fixture
        .read("pending-descriptions.json")
        .as_array()
        .unwrap()
    {
        annotations["items"][purpose["key"].as_str().unwrap()] = json!({"description":"创建该模板所需的命名和初始化数据。","summary":"创建命名与初始化数据。","evidenceHash":purpose["evidenceHash"]});
    }
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();
    for declaration in [0, 2] {
        let mut changed = facts.clone();
        changed["units"][0]["declarations"][declaration]["evidenceHash"] =
            json!("name-or-initializer-after");
        fixture.write("facts.json", &changed);
        assert!(fixture.build().is_err());
        assert!(
            fixture
                .read("pending-descriptions.json")
                .as_array()
                .unwrap()
                .iter()
                .any(|purpose| purpose["key"] == "entity:semantic-template")
        );
    }
}

#[test]
fn unresolved_uses_require_complete_portable_context_and_track_other_owning_units() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["behaviorHash"] = json!("caller-hir");
    facts["units"][0]["declarations"][0]["unresolvedBehavior"] = json!(true);
    let dependency = UnitFacts {
        schema_version: 1,
        crate_name: "implementation".into(),
        crate_identity: "implementation-unit".into(),
        behavior_hash: "impl-before".into(),
        source_files: serde_json::from_value(facts["units"][0]["sourceFiles"].clone()).unwrap(),
        ..Default::default()
    };
    facts["units"]
        .as_array_mut()
        .unwrap()
        .push(json!(dependency));
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let pending = fixture.read("pending-descriptions.json");
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system"]["evidenceHash"] =
        pending[0]["evidenceHash"].clone();
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();

    let mut changed = facts.clone();
    changed["units"][1]["behaviorHash"] = json!("impl-after");
    fixture.write("facts.json", &changed);
    assert!(
        fixture.build().is_err(),
        "An owning impl change must invalidate unresolved callers"
    );

    changed["units"][1]["behaviorHash"] = json!("");
    fixture.write("facts.json", &changed);
    let error = fixture.build().unwrap_err().to_string();
    assert!(error.contains("binding is incomplete"), "{error}");
    assert!(
        fixture.read("model.json")["bindingErrors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error
                .as_str()
                .unwrap()
                .contains("Portable owning-unit behavior evidence is incomplete"))
    );

    // 普通声明不因其他编译单元的无关变化扩大失效范围。
    changed["units"][0]["declarations"][0]["unresolvedBehavior"] = json!(false);
    annotations["items"]["demo::sample::system"]["evidenceHash"] = json!("body");
    fixture.write("annotations.json", &annotations);
    fixture.write("facts.json", &changed);
    fixture.build().unwrap();
}

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
fn type_identity_preserves_native_declaration_across_display_and_storage_projections() {
    for storage in ["Component", "NonSend"] {
        let fixture = Fixture::new(true);
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
fn generic_bounds_and_opaque_types_keep_access_facts_without_concrete_objects() {
    let fixture = Fixture::new(true);
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
    assert!(model["annotationsRequired"].as_array().unwrap().is_empty());
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
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.declarations[0].docs = "调用共用辅助处理。".into();
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
    let mut annotations = fixture.read("annotations.json");
    for key in [
        "demo::sample::system|state",
        "demo::sample::registered_helper|cache",
    ] {
        annotations["items"][key] = json!({"description":"保存此注册实例的局部处理状态。","summary":"保存局部状态。","evidenceHash":"body"});
    }
    annotations["items"]["demo::sample::system|state"]["evidenceHash"] = json!(digest(
        serde_json::to_vec(&BTreeMap::from([
            ("function", "body"),
            ("helper-declaration", "body")
        ]))
        .unwrap()
    ));
    fixture.write("annotations.json", &annotations);
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
    assert!(model["annotationsRequired"].as_array().unwrap().is_empty());
}

#[test]
fn creation_operations_bind_only_unique_root_templates_at_the_same_compiler_callsite() {
    let fixture = Fixture::new(true);
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
    let mut annotations = fixture.read("annotations.json");
    for entity in &unit.entities {
        annotations["items"][format!("entity:{}", entity.id)] = json!({"description":"此创建点装配独立实体。","summary":"装配独立实体。","evidenceHash":entity_purpose_hash(entity, "body")});
    }
    fixture.write("annotations.json", &annotations);
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
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
    let mut annotations = fixture.read("annotations.json");
    for entity in &unit.entities {
        annotations["items"][format!("entity:{}", entity.id)] = json!({"description":"保留此原生创建结构及其独立候选。","summary":"保留独立创建结构。","evidenceHash":entity_purpose_hash(entity, "body")});
    }
    fixture.write("annotations.json", &annotations);
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
fn conflicting_owning_unit_cfg_behavior_is_rejected() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut first = facts["units"][0].clone();
    first["declarations"][0]["local"] = json!(true);
    let mut second = first.clone();
    second["crateIdentity"] = json!("another-native-cfg-unit");
    second["declarations"][0]["evidenceHash"] = json!("different-cfg-body");
    for units in [json!([first, second]), json!([second, first])] {
        facts["units"] = units;
        fixture.write("facts.json", &facts);
        let error = fixture.build().unwrap_err().to_string();
        assert!(
            error.contains("Conflicting owning-unit behavior"),
            "{error}"
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
