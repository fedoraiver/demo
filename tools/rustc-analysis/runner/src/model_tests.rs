//! 模型消费真实身份而非显示名；夹具只模拟编译器和装配边界的数据。
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn purpose_universe_tracks_impls_and_requires_complete_coverage() {
    let dependency = PurposeDependency {
        trait_id: "trait".into(),
        member_id: "member".into(),
    };
    let member = PurposeMember {
        trait_id: "trait".into(),
        member_id: "member".into(),
        has_value: true,
        evidence_hash: "default".into(),
        ..Default::default()
    };
    let view = |crate_id: &str| PurposeCrateView {
        crate_identity: crate_id.into(),
        metadata_hash: "v1".into(),
    };
    let coverage = |crate_id: &str| PurposeCoverage {
        crate_identity: crate_id.into(),
        metadata_hash: "v1".into(),
        complete: true,
        traits: Some(vec!["trait".into()]),
        ..Default::default()
    };
    let base = vec![
        PurposeInventory {
            crate_identity: "library".into(),
            metadata_hash: "v1".into(),
            required_crates: vec!["library".into(), "project".into()],
            required_views: vec![view("library"), view("project")],
            coverage: vec![coverage("library")],
            traits: vec![PurposeTrait {
                owner_crate: "library".into(),
                metadata_hash: "v1".into(),
                trait_id: "trait".into(),
                complete: true,
                members: vec![member.clone()],
                ..Default::default()
            }],
            ..Default::default()
        },
        PurposeInventory {
            crate_identity: "project".into(),
            metadata_hash: "v1".into(),
            required_views: vec![view("project")],
            coverage: vec![coverage("project")],
            ..Default::default()
        },
    ];
    let before = purpose_dependency_hash(&base, &dependency).unwrap();
    let mut with_impl = base.clone();
    with_impl[1].implementations.push(PurposeImplementation {
        owner_crate: "project".into(),
        metadata_hash: "v1".into(),
        trait_id: "trait".into(),
        implementation_id: "impl".into(),
        complete: true,
        header_hash: "header".into(),
        members: vec![PurposeMember {
            implementation_member_id: Some("impl-member".into()),
            evidence_hash: "body".into(),
            ..member.clone()
        }],
        ..Default::default()
    });
    let after = purpose_dependency_hash(&with_impl, &dependency).unwrap();
    assert_ne!(before, after, "Adding an impl changes the trait universe");
    let mut metadata_only = with_impl.clone();
    metadata_only[0].required_views[1].metadata_hash = "v2".into();
    metadata_only[1].metadata_hash = "v2".into();
    metadata_only[1].required_views[0].metadata_hash = "v2".into();
    metadata_only[1].coverage[0].metadata_hash = "v2".into();
    metadata_only[1].implementations[0].metadata_hash = "v2".into();
    assert_eq!(
        after,
        purpose_dependency_hash(&metadata_only, &dependency).unwrap(),
        "Native metadata gates matching views but must not enter portable purpose evidence"
    );
    let mut omitted = with_impl.clone();
    omitted[0].coverage.push(coverage("project"));
    assert!(
        purpose_dependency_hash(&omitted, &dependency).is_none(),
        "Two complete reports for one view cannot disagree on an empty impl set"
    );
    assert!(
        purpose_dependency_proof(&omitted, &dependency)
            .unwrap_err()
            .starts_with("conflicting-implementation-set:")
    );
    let mut changed_header = with_impl.clone();
    changed_header[1].implementations[0].header_hash = "changed-predicates".into();
    assert_ne!(
        after,
        purpose_dependency_hash(&changed_header, &dependency).unwrap()
    );
    let mut conflicting = with_impl.clone();
    let mut conflict = conflicting[1].implementations[0].clone();
    conflict.header_hash = "conflict".into();
    conflicting[0].implementations.push(conflict);
    conflicting[0].coverage.push(coverage("project"));
    assert!(purpose_dependency_hash(&conflicting, &dependency).is_none());
    let mut unproven_impl = with_impl.clone();
    unproven_impl[1].implementations[0].complete = false;
    assert!(purpose_dependency_hash(&unproven_impl, &dependency).is_none());
    with_impl[1].implementations[0].members[0].evidence_hash = "changed-body".into();
    assert_ne!(
        after,
        purpose_dependency_hash(&with_impl, &dependency).unwrap()
    );
    with_impl[1].implementations[0].members[0].unresolved_behavior = true;
    assert!(purpose_dependency_hash(&with_impl, &dependency).is_none());
    assert!(
        purpose_dependency_proof(&with_impl, &dependency)
            .unwrap_err()
            .starts_with("implementation-helper:")
    );
    let mut incomplete = base.clone();
    incomplete[1].coverage[0].complete = false;
    assert!(purpose_dependency_hash(&incomplete, &dependency).is_none());
    assert!(
        purpose_dependency_proof(&incomplete, &dependency)
            .unwrap_err()
            .starts_with("incomplete-certificate:")
    );
    incomplete = base.clone();
    incomplete[1].coverage[0].traits = Some(vec![]);
    assert!(purpose_dependency_hash(&incomplete, &dependency).is_none());
    assert!(
        purpose_dependency_proof(&incomplete, &dependency)
            .unwrap_err()
            .starts_with("missing-certificate:")
    );
    incomplete[0].coverage.push(coverage("project"));
    assert_eq!(
        before,
        purpose_dependency_hash(&incomplete, &dependency).unwrap(),
        "A matching metadata view may provide a scoped certificate"
    );
    incomplete = base.clone();
    incomplete[0].required_crates.push("missing".into());
    assert!(purpose_dependency_hash(&incomplete, &dependency).is_none());
    assert!(
        purpose_dependency_proof(&incomplete, &dependency)
            .unwrap_err()
            .starts_with("missing-view:")
    );
    incomplete = base.clone();
    incomplete[0].traits[0].complete = false;
    incomplete[0].traits[0].reason = "auto trait 的候选包含未建模的内建实现".into();
    assert!(purpose_dependency_hash(&incomplete, &dependency).is_none());
    let unsupported = purpose_dependency_proof(&incomplete, &dependency).unwrap_err();
    assert!(unsupported.starts_with("unsupported-trait:") && unsupported.contains("内建实现"));
    incomplete = base.clone();
    incomplete[0].traits[0].members[0].unresolved_behavior = true;
    assert!(
        purpose_dependency_proof(&incomplete, &dependency)
            .unwrap_err()
            .starts_with("default-helper:")
    );
    assert!(
        purpose_dependency_proof(
            &base,
            &PurposeDependency {
                member_id: "unknown".into(),
                ..dependency.clone()
            }
        )
        .unwrap_err()
        .starts_with("unknown-member:")
    );
    incomplete = base;
    incomplete[0].traits[0].members[0].has_value = false;
    incomplete[1].implementations.push(PurposeImplementation {
        owner_crate: "project".into(),
        metadata_hash: "v1".into(),
        trait_id: "trait".into(),
        implementation_id: "impl".into(),
        complete: true,
        header_hash: "header".into(),
        ..Default::default()
    });
    assert!(purpose_dependency_hash(&incomplete, &dependency).is_none());
    assert!(
        purpose_dependency_proof(&incomplete, &dependency)
            .unwrap_err()
            .starts_with("missing-default:")
    );
}

#[test]
fn purpose_certificates_cannot_fill_a_missing_or_conflicting_native_view() {
    let dependency = PurposeDependency {
        trait_id: "trait".into(),
        member_id: "member".into(),
    };
    let view = |metadata: &str| PurposeCrateView {
        crate_identity: "project".into(),
        metadata_hash: metadata.into(),
    };
    let inventory = |metadata: &str| PurposeInventory {
        crate_identity: "project".into(),
        metadata_hash: metadata.into(),
        required_crates: vec!["project".into()],
        required_views: vec![view(metadata)],
        coverage: vec![PurposeCoverage {
            crate_identity: "project".into(),
            metadata_hash: metadata.into(),
            complete: true,
            ..Default::default()
        }],
        traits: vec![PurposeTrait {
            owner_crate: "project".into(),
            metadata_hash: metadata.into(),
            trait_id: "trait".into(),
            complete: true,
            members: vec![PurposeMember {
                trait_id: "trait".into(),
                member_id: "member".into(),
                has_value: true,
                evidence_hash: "default".into(),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    let first = inventory("v1");
    let baseline = purpose_dependency_hash(&[first.clone()], &dependency).unwrap();
    let second = inventory("v2");
    assert_eq!(
        baseline,
        purpose_dependency_hash(&[first.clone(), second.clone()], &dependency).unwrap(),
        "Equivalent complete views have the same portable purpose evidence"
    );

    let mut conflicting = second.clone();
    conflicting.implementations.push(PurposeImplementation {
        owner_crate: "project".into(),
        metadata_hash: "v2".into(),
        trait_id: "trait".into(),
        implementation_id: "impl".into(),
        header_hash: "header".into(),
        complete: true,
        ..Default::default()
    });
    assert!(
        purpose_dependency_hash(&[first.clone(), conflicting], &dependency).is_none(),
        "An empty complete impl set cannot be unioned with a different native view"
    );

    let mut missing = first.clone();
    missing.coverage[0].traits = Some(vec![]);
    missing.traits.clear();
    assert!(
        purpose_dependency_hash(&[missing.clone(), second.clone()], &dependency).is_none(),
        "A scoped certificate for v2 cannot certify the uncovered v1 view"
    );
    missing.required_views.push(view("v2"));
    missing.coverage.push(second.coverage[0].clone());
    missing.traits.push(second.traits[0].clone());
    assert!(
        purpose_dependency_hash(&[missing, second], &dependency).is_none(),
        "Importing a covered view does not cover another required view"
    );

    let mut unbound_certificate = first.clone();
    unbound_certificate.coverage.push(PurposeCoverage {
        crate_identity: "unloaded".into(),
        metadata_hash: "v1".into(),
        complete: true,
        ..Default::default()
    });
    assert!(
        purpose_dependency_hash(&[unbound_certificate], &dependency).is_none(),
        "A certificate must belong to a native view actually loaded by its producer"
    );
}

#[test]
fn certified_dispatch_reuses_unrelated_unit_and_invalidates_for_new_impl() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let dependency = PurposeDependency {
        trait_id: "trait".into(),
        member_id: "member".into(),
    };
    let member = PurposeMember {
        trait_id: "trait".into(),
        member_id: "member".into(),
        has_value: true,
        evidence_hash: "default".into(),
        ..Default::default()
    };
    facts["units"][0]["behaviorHash"] = json!("unit-before");
    facts["units"][0]["declarations"][0]["purposeDependencies"] = json!([dependency]);
    facts["units"][0]["calls"] = json!([CallFact {
        caller: "callable".into(),
        callee: None,
        declaration: Some("member".into()),
        unresolved_reason: Some("unresolved-call".into()),
        ..Default::default()
    }]);
    facts["units"][0]["purposeInventory"] = json!(PurposeInventory {
        crate_identity: "project".into(),
        metadata_hash: "v1".into(),
        required_crates: vec!["project".into()],
        required_views: vec![PurposeCrateView {
            crate_identity: "project".into(),
            metadata_hash: "v1".into()
        }],
        coverage: vec![PurposeCoverage {
            crate_identity: "project".into(),
            metadata_hash: "v1".into(),
            complete: true,
            ..Default::default()
        }],
        traits: vec![PurposeTrait {
            owner_crate: "project".into(),
            metadata_hash: "v1".into(),
            trait_id: "trait".into(),
            complete: true,
            members: vec![member.clone()],
            ..Default::default()
        }],
        ..Default::default()
    });
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let pending = fixture.read("pending-descriptions.json");
    let summary = fixture.read("purpose-summary.json");
    assert_eq!(summary["schemaVersion"], 1);
    assert!(summary["pending"].as_u64().unwrap() > 0);
    assert_eq!(summary["certified"], 1);
    assert_eq!(summary["fallback"], 0);
    assert!(summary["fallbacks"].as_array().unwrap().is_empty());
    let mut annotations = fixture.read("annotations.json");
    let purpose = pending
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "demo::sample::system")
        .unwrap();
    annotations["items"]["demo::sample::system"]["evidenceHash"] = purpose["evidenceHash"].clone();
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();

    assert!(
        fixture.read("purpose-summary.json")["annotationHits"]
            .as_u64()
            .unwrap()
            > 0
    );

    facts["units"][0]["calls"][0]["unresolvedReason"] = json!("dynamic-call");
    fixture.write("facts.json", &facts);
    assert!(
        fixture.build().is_err(),
        "A certified member identity must never hide an explicitly dynamic call"
    );
    let dynamic = fixture.read("purpose-summary.json");
    assert_eq!(dynamic["fallback"], 1);
    assert!(
        dynamic["fallbacks"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason.as_str().unwrap().starts_with("dynamic-call:"))
    );
    facts["units"][0]["calls"][0]["unresolvedReason"] = json!("unresolved-call");
    facts["units"][0]["behaviorHash"] = json!("unrelated-project-change");
    fixture.write("facts.json", &facts);
    fixture
        .build()
        .expect("Unrelated owning-unit behavior must not invalidate a certified trait dependency");
    facts["units"][0]["purposeInventory"]["implementations"] = json!([PurposeImplementation {
        owner_crate: "project".into(),
        metadata_hash: "v1".into(),
        trait_id: "trait".into(),
        implementation_id: "new-impl".into(),
        complete: true,
        header_hash: "header".into(),
        members: vec![PurposeMember {
            implementation_member_id: Some("impl-member".into()),
            evidence_hash: "implementation".into(),
            ..member
        }],
        ..Default::default()
    }]);
    fixture.write("facts.json", &facts);
    assert!(
        fixture.build().is_err(),
        "A new impl must invalidate the purpose"
    );
    facts["units"][0]["purposeInventory"]["implementations"][0]["complete"] = json!(false);
    facts["units"][0]["purposeInventory"]["implementations"][0]["reason"] =
        json!("specialization 成员没有完整覆盖");
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let summary = fixture.read("purpose-summary.json");
    assert_eq!(summary["fallback"], 1);
    assert!(
        summary["fallbacks"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| {
                let reason = reason.as_str().unwrap();
                reason.starts_with("incomplete-implementation:")
                    && reason.contains("specialization")
            }),
        "The production dependency cache retains the compiler's concrete fallback reason"
    );
}

#[test]
fn old_compiler_fact_units_are_not_treated_as_certified() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    facts["units"][0]["schemaVersion"] = json!(1);
    fixture.write("facts.json", &facts);
    let error = fixture.build().unwrap_err().to_string();
    assert!(
        error.contains("Unsupported compiler unit schema"),
        "{error}"
    );
}

#[test]
fn old_compiler_fact_bundle_is_rejected() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    facts["schemaVersion"] = json!(1);
    fixture.write("facts.json", &facts);
    let error = fixture.build().unwrap_err().to_string();
    assert!(error.contains("Unsupported analysis schema"), "{error}");
}

#[test]
fn entity_names_preserve_values_expressions_candidates_and_legacy_templates() {
    let fixture = Fixture::new(true);
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
    let mut annotations = fixture.read("annotations.json");
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
    for entity in &entities {
        annotations["items"][format!("entity:{}", entity.id)] = json!({"description":"在此创建点装配独立实体。","summary":"装配独立实体。","evidenceHash":entity_purpose_hash(entity, "body")});
    }
    facts["units"][0]["entities"] = json!(entities);
    // 旧事实没有新增字段时继续反序列化，不要求重新提取才能显示明确的名称缺口。
    facts["units"][0]["entities"][5]
        .as_object_mut()
        .unwrap()
        .remove("nameCandidates");
    fixture.write("annotations.json", &annotations);
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
    assert_eq!(entity("literal")["description"], "在此创建点装配独立实体。");
    assert_eq!(entity("literal")["display_summary"], "装配独立实体。");
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
    let fixture = Fixture::new(true);
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
    let mut annotations = fixture.read("annotations.json");
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
    for entity in &entities {
        annotations["items"][format!("entity:{}", entity.id)] = json!({"description":"保留该模板的名称与装配来源。","summary":"保留装配来源。","evidenceHash":entity_purpose_hash(entity, "body")});
    }
    facts["units"][0]["entities"] = json!(entities);
    fixture.write("annotations.json", &annotations);
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

#[test]
fn entity_name_metadata_spans_do_not_enter_purpose_evidence() {
    let mut entity = EntityTemplate {
        id: "named-template".into(),
        creator: "callable".into(),
        name_candidates: vec![EntityNameCandidate {
            value: Some("Player".into()),
            expression: Some(SourceEvidence {
                path: "src/main.rs".into(),
                line: 1,
                snippet: "\"Player\"".into(),
                ..Default::default()
            }),
            ..Default::default()
        }],
        ..Default::default()
    };
    let before = entity_purpose_hash(&entity, "creator-and-helper-behavior");
    let expression = entity.name_candidates[0].expression.as_mut().unwrap();
    expression.line = 40;
    expression.end_line = 40;
    expression.sha256 = "moved-source-hash".into();
    expression.expansions.push(Expansion {
        name: "bsn".into(),
        path: "src/main.rs".into(),
        line: 39,
        column: 3,
    });
    assert_eq!(
        before,
        entity_purpose_hash(&entity, "creator-and-helper-behavior")
    );
    // 初始化语义由 creator/helper 行为覆盖；显示候选不重复定义用途算法。
    entity.name_candidates.clear();
    assert_eq!(
        before,
        entity_purpose_hash(&entity, "creator-and-helper-behavior")
    );
    assert_ne!(
        before,
        entity_purpose_hash(&entity, "changed-creator-behavior")
    );
}

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
        schema_version: FACT_SCHEMA_VERSION,
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

    let fallback_summary = fixture.read("purpose-summary.json");
    assert_eq!(fallback_summary["fallback"], 1);
    let fallbacks = fallback_summary["fallbacks"].as_array().unwrap();
    assert_eq!(
        fallbacks.len(),
        1,
        "Repeated registrations retain one declaration-level fallback record"
    );
    assert_eq!(fallbacks[0]["declaration"], "function");
    assert_eq!(fallbacks[0]["name"], "demo::sample::system");
    assert!(
        fallbacks[0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason.as_str().unwrap().starts_with("compiler-unresolved:"))
    );

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
            schema_version: FACT_SCHEMA_VERSION,
            crate_name: "demo".into(),
            crate_identity: "compiled-crate".into(),
            purpose_inventory: PurposeInventory {
                crate_identity: "model-fixture".into(),
                metadata_hash: "fixture-view".into(),
                required_crates: vec!["model-fixture".into()],
                required_views: vec![PurposeCrateView {
                    crate_identity: "model-fixture".into(),
                    metadata_hash: "fixture-view".into(),
                }],
                coverage: vec![PurposeCoverage {
                    crate_identity: "model-fixture".into(),
                    metadata_hash: "fixture-view".into(),
                    complete: true,
                    ..Default::default()
                }],
                ..Default::default()
            },
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
                    evidence_hash: "body".into(),
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
                body_analyzed: true,
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
fn call_graph_and_representative_paths_are_stable_across_unit_and_call_order() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.behavior_hash = "stable-call-fixture".into();
    unit.declarations[0].docs = "通过辅助调用处理实体，并保留调用条件与代表路径。".into();
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
fn system_registration_sources_preserve_all_callable_sites_without_guessing_instances() {
    for positions in [vec![], vec![(1u64, 3u64)], vec![(1, 3), (2, 5)]] {
        let fixture = Fixture::new(true);
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
        let fixture = Fixture::new(true);
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
            body_analyzed: true,
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
        let mut annotations = fixture.read("annotations.json");
        annotations["items"]["demo::sample::system"]["evidenceHash"] = json!(digest(
            serde_json::to_vec(&BTreeMap::from([
                ("function", "body"),
                ("helper-declaration", "body")
            ]))
            .unwrap()
        ));
        fixture.write("annotations.json", &annotations);
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
    let fixture = Fixture::new(true);
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
    let fixture = Fixture::new(true);
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
        assert_eq!(marker["description"], "标识需要处理的实体。");
        assert_eq!(model["annotationsRequired"], json!([]));
        let mut purpose = fixture.read("purpose-summary.json");
        for field in ["compiler", "configuration", "inputs"] {
            assert_eq!(purpose[field], model[field]);
        }
        // 单元排列改变 facts 字节摘要；先检查真实绑定，再比较用途语义。
        purpose.as_object_mut().unwrap().remove("inputs");
        let output = json!({"objects":model["objects"],"relations":model["relations"],"features":model["features"],
            "purpose":purpose});
        if let Some(previous) = &previous {
            assert_eq!(previous, &output);
        }
        previous = Some(output);
    }
}

#[test]
fn feature_representatives_are_existing_plugins_and_stable_across_native_order() {
    let fixture = Fixture::new(true);
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
            docs: "装配该功能的已登记插件。".into(),
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
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::main"] =
        json!({"description":"装配示例插件。","summary":"装配插件。","evidenceHash":"body"});
    fixture.write("annotations.json", &annotations);
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
        let mut purpose = fixture.read("purpose-summary.json");
        for field in ["compiler", "configuration", "inputs"] {
            assert_eq!(purpose[field], model[field]);
        }
        purpose.as_object_mut().unwrap().remove("inputs");
        let projection = json!({"objects":model["objects"],"relations":model["relations"],"features":model["features"],"purpose":purpose});
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
    facts["units"][0]["behaviorHash"] = json!("helper-call-context");
    facts["units"][0]["declarations"][0]["docs"] =
        json!("调用辅助处理，并保留立即与延迟插入的上下文。");
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
fn purpose_only_calls_invalidate_prose_without_propagating_business_operations() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    let mut helper = unit.declarations[0].clone();
    helper.id = "purpose-helper".into();
    helper.full_name = "demo::sample::purpose_helper".into();
    helper.name = "purpose_helper".into();
    helper.evidence_hash = "helper-before".into();
    unit.declarations.push(helper);
    let mut callable = unit.callables[0].clone();
    callable.id = "purpose-helper-callable".into();
    callable.declaration = "purpose-helper".into();
    callable.system_type_ids.clear();
    unit.callables.push(callable);
    unit.purpose_calls.push(CallFact {
        caller: "callable".into(),
        callee: Some("purpose-helper-callable".into()),
        declaration: Some("purpose-helper".into()),
        ..Default::default()
    });
    unit.operations.push(OperationFact {
        id: "private-helper-insert".into(),
        owner: "purpose-helper-callable".into(),
        method: "insert".into(),
        target_type: Some("marker-type".into()),
        kind: "insert".into(),
        source: unit.declarations[0].source.clone(),
        scope: "current".into(),
        ..Default::default()
    });
    facts["units"][0] = json!(unit);
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let before = fixture.read("pending-descriptions.json")[0]["evidenceHash"].clone();
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system"]["evidenceHash"] = before.clone();
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();
    let model = fixture.read("model.json");
    assert_eq!(model["callGraph"]["edgeCount"], 0);
    assert!(
        !model["relations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|relation| relation["kind"] == "insert"),
        "Private purpose edges cannot assign business ownership or execution contexts"
    );
    facts["units"][0]["declarations"][2]["evidenceHash"] = json!("helper-after");
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    assert_ne!(
        fixture.read("pending-descriptions.json")[0]["evidenceHash"],
        before,
        "Private helper bodies still participate in purpose evidence"
    );
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
fn work_budget_causes_follow_exact_unresolved_declarations_without_changing_purpose_hashes() {
    for owner in ["function", "budget-helper"] {
        let fixture = Fixture::new(true);
        let mut facts = fixture.read("facts.json");
        let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
        unit.behavior_hash = "complete-owning-behavior".into();
        let mut helper = unit.declarations[0].clone();
        helper.id = "budget-helper".into();
        helper.full_name = "demo::sample::budget_helper".into();
        helper.name = "budget_helper".into();
        unit.declarations.push(helper);
        let mut callable = unit.callables[0].clone();
        callable.id = "budget-helper-callable".into();
        callable.declaration = "budget-helper".into();
        callable.system_type_ids.clear();
        unit.callables.push(callable);
        unit.calls.push(CallFact {
            caller: "callable".into(),
            callee: Some("budget-helper-callable".into()),
            declaration: Some("budget-helper".into()),
            ..Default::default()
        });
        unit.gaps = vec![
            Gap {
                owner: owner.into(),
                kind: "purpose-work-budget".into(),
                reason: "exact-declaration-budget".into(),
                ..Default::default()
            },
            Gap {
                owner: "callable".into(),
                kind: "purpose-work-budget".into(),
                reason: "callable-owner-must-not-match".into(),
                ..Default::default()
            },
            Gap {
                owner: owner.into(),
                kind: "other-kind".into(),
                reason: "other-kind-must-not-match".into(),
                ..Default::default()
            },
        ];
        facts["units"][0] = json!(unit);
        fixture.write("facts.json", &facts);
        assert!(fixture.build().is_err());
        let evidence = |fixture: &Fixture| {
            fixture
                .read("pending-descriptions.json")
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["key"] == "demo::sample::system")
                .unwrap()["evidenceHash"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let mut annotations = fixture.read("annotations.json");
        annotations["items"]["demo::sample::system"]["evidenceHash"] = json!(evidence(&fixture));
        fixture.write("annotations.json", &annotations);
        fixture.build().unwrap();
        assert_eq!(fixture.read("purpose-summary.json")["fallback"], 0);

        let declaration = facts["units"][0]["declarations"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|declaration| declaration["id"] == owner)
            .unwrap();
        declaration["unresolvedBehavior"] = json!(true);
        fixture.write("facts.json", &facts);
        assert!(fixture.build().is_err());
        let before = evidence(&fixture);
        let summary = fixture.read("purpose-summary.json");
        let fallback = summary["fallbacks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fallback| fallback["declaration"] == "function")
            .unwrap();
        let reasons = fallback["reasons"].as_array().unwrap();
        assert!(reasons.iter().any(|reason| {
            let reason = reason.as_str().unwrap();
            reason.starts_with("purpose-work-budget:")
                && reason.contains("exact-declaration-budget")
                && reason.contains(owner)
        }));
        assert!(!reasons.iter().any(|reason| {
            let reason = reason.as_str().unwrap();
            reason.contains("callable-owner-must-not-match")
                || reason.contains("other-kind-must-not-match")
        }));

        facts["units"][0]["gaps"][0]["reason"] = json!("updated-declaration-budget");
        fixture.write("facts.json", &facts);
        assert!(fixture.build().is_err());
        assert_eq!(
            evidence(&fixture),
            before,
            "Diagnostic wording must not enter the purpose fingerprint"
        );
        assert!(
            fixture.read("purpose-summary.json")["fallbacks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|fallback| fallback["declaration"] == "function")
                .flat_map(|fallback| fallback["reasons"].as_array().unwrap())
                .any(|reason| reason
                    .as_str()
                    .unwrap()
                    .contains("updated-declaration-budget"))
        );
    }
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
    facts["units"][0]["behaviorHash"] = json!("helper-owning-unit");
    facts["units"][0]["declarations"][2]["unresolvedBehavior"] = json!(true);
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let summary = fixture.read("purpose-summary.json");
    assert!(
        summary["fallbacks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|fallback| {
                fallback["declaration"] == "function"
                    && fallback["reasons"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|reason| {
                            let reason = reason.as_str().unwrap();
                            reason.starts_with("compiler-helper:")
                                && reason.contains("demo::sample::helper")
                        })
            }),
        "A caller's sidecar names the reachable helper that forced conservative fallback"
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
        body_analyzed: true,
        display: "demo::sample::registered_helper".into(),
        system_type_ids: vec!["helper-runtime".into()],
        ..Default::default()
    });
    unit.callables.push(Callable {
        id: "result-helper".into(),
        declaration: "helper-declaration".into(),
        body_analyzed: true,
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
    facts["units"][0]["behaviorHash"] = json!("owning-hir-with-runtime-callback");
    facts["units"][0]["gaps"] = json!([{"owner":"callable","kind":"dynamic-call","reason":"回调目标在运行时决定。","source":null}]);
    let mut second = facts["units"][0].clone();
    second["crateIdentity"] = json!("second-unit");
    facts["units"].as_array_mut().unwrap().push(second);
    fixture.write("facts.json", &facts);
    let error = fixture.build().unwrap_err().to_string();
    assert!(
        error.contains("Chinese descriptions are pending"),
        "{error}"
    );
    let pending = fixture.read("pending-descriptions.json");
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system"]["evidenceHash"] = pending
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "demo::sample::system")
        .unwrap()["evidenceHash"]
        .clone();
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();
    let summary = fixture.read("purpose-summary.json");
    assert_eq!(summary["fallback"], 1);
    assert!(
        summary["fallbacks"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason.as_str().unwrap().starts_with("dynamic-call:"))
    );
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
fn implicit_drop_diagnostics_stay_private_without_weakening_fallback_or_business_evidence() {
    let fixture = Fixture::new(true);
    let mut facts = fixture.read("facts.json");
    let mut unit: UnitFacts = serde_json::from_value(facts["units"][0].clone()).unwrap();
    unit.behavior_hash = "owning-behavior-v1".into();
    let first_source = unit.declarations[0].source.clone().unwrap();
    let mut second_source = first_source.clone();
    second_source.line = 2;
    second_source.end_line = 2;
    second_source.expansions.push(Expansion {
        name: "drop-fixture".into(),
        path: second_source.path.clone(),
        line: 2,
        column: 1,
    });
    let drop_reason = "隐式析构尚未解析完整 drop glue；保留用途回退。";
    let drop_gap = |source: &SourceEvidence| Gap {
        owner: "callable".into(),
        kind: "implicit-drop".into(),
        reason: drop_reason.into(),
        source: Some(source.clone()),
    };
    unit.gaps = vec![
        drop_gap(&first_source),
        drop_gap(&second_source),
        drop_gap(&first_source),
        Gap {
            owner: "callable".into(),
            kind: "dynamic-call".into(),
            reason: "业务回调目标在运行时决定。".into(),
            source: Some(first_source.clone()),
        },
        Gap {
            owner: "callable".into(),
            kind: "unresolved-call".into(),
            reason: "业务调用尚不能唯一解析。".into(),
            source: Some(second_source.clone()),
        },
        Gap {
            owner: "callable".into(),
            kind: "implicit-drop-other".into(),
            reason: "未知种类不得按名称前缀移动。".into(),
            source: Some(first_source.clone()),
        },
    ];
    unit.purpose_calls = [&first_source, &second_source]
        .into_iter()
        .map(|source| CallFact {
            caller: "callable".into(),
            callee: None,
            declaration: None,
            unresolved_reason: Some("implicit-drop".into()),
            source: Some(source.clone()),
            deferred: false,
            conditions: vec![],
        })
        .collect();
    unit.operations.push(OperationFact {
        id: "unresolved-spawn".into(),
        owner: "callable".into(),
        method: "resolved-spawn".into(),
        kind: "create".into(),
        source: Some(first_source.clone()),
        ..Default::default()
    });
    let mut second_unit = unit.clone();
    second_unit.crate_identity = "second-unit".into();
    facts["units"] = json!([unit, second_unit]);
    fixture.write("facts.json", &facts);
    let original_facts = fs::read(fixture.root.join("facts.json")).unwrap();
    assert!(
        fixture
            .build()
            .unwrap_err()
            .to_string()
            .contains("Chinese descriptions are pending")
    );
    let pending = fixture.read("pending-descriptions.json");
    let before_hash = pending
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "demo::sample::system")
        .unwrap()["evidenceHash"]
        .clone();
    let mut annotations = fixture.read("annotations.json");
    annotations["items"]["demo::sample::system"]["evidenceHash"] = before_hash.clone();
    fixture.write("annotations.json", &annotations);
    fixture.build().unwrap();
    assert_eq!(
        fs::read(fixture.root.join("facts.json")).unwrap(),
        original_facts,
        "Partitioning public output must not alter compiler facts or purpose calls"
    );
    let model = fixture.read("model.json");
    let summary = fixture.read("purpose-summary.json");
    for field in ["compiler", "configuration", "inputs"] {
        assert_eq!(summary[field], model[field]);
    }
    assert_eq!(summary["inputs"]["factsSha256"], digest(&original_facts));
    assert_eq!(summary["fallback"], 1);
    assert_eq!(summary["certified"], 0);
    assert_eq!(summary["pending"], 0);
    assert_eq!(
        summary["compilerGapSummary"],
        json!({"count":2,"byKind":{"implicit-drop":2}})
    );
    let private = summary["compilerGaps"].as_array().unwrap();
    assert_eq!(private.len(), 2);
    let public = model["analysisGaps"].as_array().unwrap();
    for kind in [
        "dynamic-call",
        "unresolved-call",
        "operation-target",
        "implicit-drop-other",
    ] {
        assert!(public.iter().any(|gap| gap["kind"] == kind), "{kind}");
    }
    assert!(public.iter().all(|gap| gap["kind"] != "implicit-drop"));
    for gap in private {
        assert_eq!(gap["kind"], "implicit-drop");
        assert_eq!(gap["owner"], "callable");
        assert_eq!(gap["reason"], drop_reason);
        assert_eq!(gap["unit"], "compiled-crate");
        assert_eq!(gap["units"], json!(["compiled-crate", "second-unit"]));
        assert_eq!(gap["sourceEntries"].as_array().unwrap().len(), 1);
        let counterpart_kind = if gap["sourceEntries"][0]["line"] == 1 {
            "dynamic-call"
        } else {
            "unresolved-call"
        };
        let counterpart = public
            .iter()
            .find(|entry| entry["kind"] == counterpart_kind)
            .unwrap();
        assert_eq!(gap["sourceEntries"], counterpart["sourceEntries"]);
        assert_eq!(gap["sourceEntries"][0]["path"], "src/main.rs");
        assert_eq!(gap["sourceEntries"][0]["sha256"], first_source.sha256);
    }
    assert!(
        private
            .iter()
            .any(|gap| gap["sourceEntries"][0]["expansions"][0]["name"] == "drop-fixture")
    );
    assert!(
        summary["fallbacks"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason.as_str().unwrap().starts_with("implicit-drop:"))
    );
    for object in model["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|object| object["kind"] == "System")
    {
        assert!(
            object["sourceGaps"]
                .as_array()
                .unwrap()
                .contains(&json!(drop_reason))
        );
    }

    // 删除诊断副本仍保留真实 opaque purpose calls，验证业务投影和用途门控未受输出分区影响。
    let mut control = facts.clone();
    for unit in control["units"].as_array_mut().unwrap() {
        unit["gaps"]
            .as_array_mut()
            .unwrap()
            .retain(|gap| gap["kind"] != "implicit-drop");
    }
    fixture.write("facts.json", &control);
    fixture.build().unwrap();
    let control_model = fixture.read("model.json");
    let control_summary = fixture.read("purpose-summary.json");
    assert_eq!(control_summary["fallback"], 1);
    assert_eq!(control_summary["compilerGaps"], json!([]));
    assert_eq!(
        control_summary["compilerGapSummary"],
        json!({"count":0,"byKind":{}})
    );
    for field in ["compiler", "configuration", "inputs"] {
        assert_eq!(control_summary[field], control_model[field]);
    }
    for (field, value) in model.as_object().unwrap() {
        if !matches!(field.as_str(), "objects" | "inputs") {
            assert_eq!(value, &control_model[field], "Business model field {field}");
        }
    }
    let mut objects = model["objects"].clone();
    for object in objects.as_array_mut().unwrap() {
        object["sourceGaps"]
            .as_array_mut()
            .unwrap()
            .retain(|reason| reason != drop_reason);
    }
    assert_eq!(objects, control_model["objects"]);

    for unit in facts["units"].as_array_mut().unwrap() {
        unit["gaps"]
            .as_array_mut()
            .unwrap()
            .retain(|gap| gap["kind"] == "implicit-drop");
    }
    fixture.write("facts.json", &facts);
    fixture.build().unwrap();
    let drop_only = fixture.read("purpose-summary.json");
    assert_eq!(drop_only["fallback"], 1);
    assert!(
        drop_only["fallbacks"][0]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .all(|reason| reason.as_str().unwrap().starts_with("implicit-drop:")),
        "Opaque drop calls alone must require owning fallback, independently of shared business gaps"
    );
    for unit in facts["units"].as_array_mut().unwrap() {
        unit["behaviorHash"] = json!("owning-behavior-v2");
    }
    fixture.write("facts.json", &facts);
    assert!(fixture.build().is_err());
    let changed = fixture.read("pending-descriptions.json");
    let after_hash = &changed
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "demo::sample::system")
        .unwrap()["evidenceHash"];
    assert_ne!(&before_hash, after_hash);
    let changed_summary = fixture.read("purpose-summary.json");
    assert_eq!(changed_summary["fallback"], 1);
    assert_eq!(changed_summary["compilerGapSummary"]["count"], 2);
    assert!(changed_summary["pending"].as_u64().unwrap() > 0);
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
            local: true,
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
            local: true,
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
            body_analyzed: true,
            display: "demo::sample::bar".into(),
            system_type_ids: vec!["bar-runtime".into()],
            ..Default::default()
        },
        Callable {
            id: "plugin-b-build".into(),
            declaration: "plugin-b-build-declaration".into(),
            body_analyzed: true,
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
