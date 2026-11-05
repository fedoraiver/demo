//! 未静态绑定的 trait 成员用途依赖与原生 impl 枚举证明；不为候选选择运行时实现。
use crate::identity::{BehaviorHashContext, Identities};
use analysis_contract::facts::{
    PurposeCoverage, PurposeCrateView, PurposeImplementation, PurposeInventory, PurposeMember,
    PurposeTrait,
};
use rustc_data_structures::{
    fingerprint::Fingerprint,
    stable_hash::{StableHash, StableHasher},
};
use rustc_hir::{
    def::DefKind,
    def_id::{CrateNum, DefId, LOCAL_CRATE},
};
use rustc_middle::ty;
use std::collections::{BTreeMap, HashSet};

fn declaration(identities: &Identities<'_>, id: DefId) -> String {
    format!("decl-{}", identities.definition(id))
}

fn builtin_trait(identities: &Identities<'_>, id: DefId) -> bool {
    let tcx = identities.tcx();
    let definition = tcx.trait_def(id);
    definition.has_auto_impl
        || definition.is_marker
        || definition.deny_explicit_impl
        || tcx.lang_items().iter().any(|(_, item)| item == id)
}

fn member(identities: &Identities<'_>, trait_id: DefId, id: DefId) -> Option<PurposeMember> {
    let tcx = identities.tcx();
    let item = tcx.associated_item(id);
    let trait_member = item.trait_item_or_self().ok()?;
    let has_value = tcx.defaultness(id).has_value();
    // 这些成员当前不能认证完整用途。仍枚举其确切身份、局部正文与签名，
    // 但不为必然回退的证据递归展开 const DAG 或加载普通方法的 MIR。
    let unmodeled = builtin_trait(identities, trait_id)
        || tcx
            .associated_items(trait_id)
            .in_definition_order()
            .any(|member| tcx.def_kind(member.def_id) == DefKind::AssocTy)
        || (tcx.def_kind(id) == DefKind::AssocFn
            && !tcx.is_const_fn(id)
            && !tcx.is_conditionally_const(id));
    let mut evidence = PurposeMember {
        trait_id: declaration(identities, trait_id),
        member_id: declaration(identities, trait_member),
        implementation_member_id: id.ne(&trait_member).then(|| declaration(identities, id)),
        has_value,
        unresolved_behavior: unmodeled,
        ..PurposeMember::default()
    };
    if unmodeled
        && let Some(local) = id.as_local()
        && let Some(hash) = identities.unmodeled_member_behavior(local)
    {
        evidence.evidence_hash = format!("{hash:?}");
        return Some(evidence);
    }
    if !unmodeled
        && let Some(local) = id.as_local()
        && let Some((hash, unresolved, dependencies)) = identities.member_behavior(local)
    {
        evidence.evidence_hash = format!("{hash:?}");
        evidence.dependencies = dependencies;
        evidence.unresolved_behavior |= unresolved;
        return Some(evidence);
    }
    let mut context = if unmodeled {
        BehaviorHashContext::unmodeled(identities, id)
    } else {
        BehaviorHashContext::new(identities, id)
    };
    context.require_helper_coverage();
    let mut hasher = StableHasher::new();
    // 默认缺省与确切签名独立于正文是否可从 metadata 取得。
    declaration(identities, id).stable_hash(&mut context, &mut hasher);
    has_value.stable_hash(&mut context, &mut hasher);
    let clauses: Vec<_> = tcx
        .clauses_of(id)
        .clauses
        .iter()
        .map(|(clause, _)| *clause)
        .collect();
    crate::portable::hash(tcx, &clauses, &context, &mut hasher);
    match tcx.def_kind(id) {
        DefKind::AssocFn => {
            crate::portable::hash(
                tcx,
                &tcx.fn_sig(id).instantiate_identity().skip_norm_wip(),
                &context,
                &mut hasher,
            );
        }
        DefKind::AssocTy if item.container == ty::AssocContainer::Trait && !has_value => {
            // rustc metadata 不为无默认值的 trait 关联类型编码 type_of 表项。
            // 保留确切身份与“无默认体”，不能把抽象投影当作已知初始化类型。
        }
        DefKind::AssocConst | DefKind::AssocTy => {
            crate::portable::hash(
                tcx,
                &tcx.type_of(id).instantiate_identity().skip_norm_wip(),
                &context,
                &mut hasher,
            );
        }
        _ => return None,
    }
    if has_value && !unmodeled {
        match tcx.def_kind(id) {
            DefKind::AssocConst => {
                if let Some(value) = tcx.trivial_const(id) {
                    crate::portable::hash(tcx, &value, &context, &mut hasher);
                } else if context.ctfe_mir_available(id) {
                    context.hash_mir(id, tcx.mir_for_ctfe(id), &mut hasher);
                } else {
                    evidence.unresolved_behavior = true;
                }
            }
            DefKind::AssocFn => {
                let body = if tcx.is_const_fn(id) {
                    context.ctfe_mir_available(id).then(|| tcx.mir_for_ctfe(id))
                } else {
                    tcx.is_mir_available(id).then(|| tcx.optimized_mir(id))
                };
                if let Some(body) = body {
                    context.hash_mir(id, body, &mut hasher);
                } else {
                    evidence.unresolved_behavior = true;
                }
            }
            _ => evidence.unresolved_behavior = true,
        }
    }
    evidence.evidence_hash = format!("{:?}", hasher.finish::<Fingerprint>());
    evidence.unresolved_behavior |= context.unresolved_behavior();
    evidence.dependencies = context.purpose_dependencies();
    Some(evidence)
}

fn trait_evidence(identities: &Identities<'_>, id: DefId) -> PurposeTrait {
    let tcx = identities.tcx();
    let builtin = builtin_trait(identities, id);
    let mut result = PurposeTrait {
        owner_crate: identities.crate_identity(id.krate),
        metadata_hash: format!("{:?}", tcx.crate_hash(id.krate)),
        trait_id: declaration(identities, id),
        complete: !builtin,
        reason: if builtin {
            "auto、marker 或 lang item trait 的原生候选不由显式 impl 清单穷尽"
        } else {
            "原生 associated_items 完整枚举声明成员与默认体"
        }
        .into(),
        members: vec![],
    };
    for item in tcx.associated_items(id).in_definition_order() {
        if let Some(evidence) = member(identities, id, item.def_id) {
            result.members.push(evidence);
        } else {
            result.complete = false;
            result.reason = "trait 成员不能绑定到确切原生声明".into();
        }
    }
    result.members.sort_by(|a, b| a.member_id.cmp(&b.member_id));
    result
}

fn implementation(identities: &Identities<'_>, id: DefId) -> PurposeImplementation {
    let tcx = identities.tcx();
    let header = tcx.impl_trait_header(id);
    let trait_ref = header.trait_ref.instantiate_identity().skip_norm_wip();
    let trait_id = trait_ref.def_id;
    let mut context = BehaviorHashContext::new(identities, id);
    let mut hasher = StableHasher::new();
    crate::portable::hash(tcx, &trait_ref, &context, &mut hasher);
    let clauses: Vec<_> = tcx
        .clauses_of(id)
        .clauses
        .iter()
        .map(|(clause, _)| *clause)
        .collect();
    crate::portable::hash(tcx, &clauses, &context, &mut hasher);
    format!(
        "{:?}",
        (
            header.polarity,
            header.safety,
            header.constness,
            tcx.defaultness(id)
        )
    )
    .stable_hash(&mut context, &mut hasher);
    // 继承 specialization 成员或负实现不能按普通“override 否则 trait default”解释。
    let no_specialization = if id.is_local() {
        // impl_parent 只提供外部 metadata 查询；本地启用 specialization 时保守拒绝证书。
        !tcx.features().specialization() && !tcx.features().min_specialization()
    } else {
        tcx.impl_parent(id).is_none()
    };
    let complete = matches!(header.polarity, ty::ImplPolarity::Positive)
        && no_specialization
        && !context.unresolved_behavior()
        && context.purpose_dependencies().is_empty();
    let mut result = PurposeImplementation {
        owner_crate: identities.crate_identity(id.krate),
        metadata_hash: format!("{:?}", tcx.crate_hash(id.krate)),
        trait_id: declaration(identities, trait_id),
        implementation_id: declaration(identities, id),
        header_hash: format!("{:?}", hasher.finish::<Fingerprint>()),
        complete,
        reason: if complete {
            "原生 impl header、where predicates 与显式成员映射完整"
        } else {
            "负实现、specialization 或未规范化关联类型需要保守回退"
        }
        .into(),
        members: vec![],
    };
    for item in tcx.associated_items(id).in_definition_order() {
        if let Some(evidence) = member(identities, trait_id, item.def_id) {
            result.members.push(evidence);
        } else {
            result.complete = false;
            result.reason = "impl 成员未唯一映射到 trait 声明成员".into();
        }
    }
    result.members.sort_by(|a, b| a.member_id.cmp(&b.member_id));
    result
}

/// 本地证书在无 ECS 协议的早退单元中也生成；sysroot 只证明实际依赖的 trait 子集。
pub(crate) fn collect(identities: &Identities<'_>) -> PurposeInventory {
    let tcx = identities.tcx();
    let local_identity = identities.crate_identity(LOCAL_CRATE);
    let crates: Vec<CrateNum> = std::iter::once(LOCAL_CRATE)
        .chain(tcx.crates(()).iter().copied())
        .collect();
    if tcx.sess.opts.unstable_opts.metadata_crate_hash && tcx.needs_metadata() {
        // 嵌入调用方未启用原生 HIR 回退时，after_analysis 尚无本地 metadata hash。
        // 不提前编码、不改写原生 provider；缺证书使消费方保守回退。
        return PurposeInventory {
            crate_identity: local_identity.clone(),
            required_crates: crates.iter().map(|&krate| identities.crate_identity(krate)).collect(),
            coverage: vec![PurposeCoverage {
                crate_identity: local_identity,
                complete: false,
                reason: "分析阶段尚无本地 metadata hash；嵌入调用方须采用 rustc 原生 metadata-crate-hash=no 才能认证视图".into(),
                ..PurposeCoverage::default()
            }],
            ..PurposeInventory::default()
        };
    }
    let mut result = PurposeInventory {
        crate_identity: local_identity.clone(),
        metadata_hash: format!("{:?}", tcx.crate_hash(LOCAL_CRATE)),
        required_crates: crates
            .iter()
            .map(|&krate| identities.crate_identity(krate))
            .collect(),
        required_views: crates
            .iter()
            .map(|&krate| PurposeCrateView {
                crate_identity: identities.crate_identity(krate),
                metadata_hash: format!("{:?}", tcx.crate_hash(krate)),
            })
            .collect(),
        coverage: vec![PurposeCoverage {
            crate_identity: local_identity,
            metadata_hash: format!("{:?}", tcx.crate_hash(LOCAL_CRATE)),
            complete: true,
            reason: "当前 cfg 下 HIR traits 与 all_local_trait_impls 完整枚举".into(),
            traits: None,
        }],
        traits: tcx
            .traits(LOCAL_CRATE)
            .iter()
            .map(|&id| trait_evidence(identities, id))
            .collect(),
        implementations: vec![],
    };
    let mut local_impls: Vec<_> = tcx
        .all_local_trait_impls(())
        .values()
        .flatten()
        .map(|id| id.to_def_id())
        .collect();
    local_impls.sort_by_key(|&id| identities.definition(id));
    for id in local_impls {
        result.implementations.push(implementation(identities, id));
    }
    let sysroot: Vec<_> = crates
        .into_iter()
        .filter(|&krate| {
            krate != LOCAL_CRATE
                && serde_json::from_str::<serde_json::Value>(&identities.crate_identity(krate))
                    .ok()
                    .is_some_and(|identity| {
                        identity.get("sysrootCrate").is_some()
                            && identity.get("compiler").and_then(serde_json::Value::as_str)
                                == Some(env!("ANALYSIS_COMPILER"))
                    })
        })
        .collect();
    // 同一 metadata 的 impl 表只读取/分组一次；请求闭包扩展时不重复扫描全部 impl。
    let sysroot_impls: BTreeMap<_, BTreeMap<_, Vec<_>>> = sysroot
        .iter()
        .map(|&krate| {
            let mut traits = BTreeMap::<String, Vec<DefId>>::new();
            for &id in tcx.trait_impls_in_crate(krate) {
                traits
                    .entry(declaration(identities, tcx.impl_trait_id(id)))
                    .or_default()
                    .push(id);
            }
            (krate, traits)
        })
        .collect();
    let mut covered = HashSet::new();
    let mut foreign_traits = BTreeMap::new();
    let mut foreign_impls = BTreeMap::new();
    loop {
        let mut requested: Vec<_> = identities
            .requested_traits()
            .difference(&covered)
            .copied()
            .collect();
        requested.sort_by_key(|&id| identities.definition(id));
        if requested.is_empty() {
            break;
        }
        for trait_id in requested {
            covered.insert(trait_id);
            if sysroot.contains(&trait_id.krate) {
                foreign_traits.insert(
                    (
                        declaration(identities, trait_id),
                        format!("{:?}", tcx.crate_hash(trait_id.krate)),
                    ),
                    trait_evidence(identities, trait_id),
                );
            }
            for &krate in &sysroot {
                // metadata encode_impls 枚举全部 HIR trait impls；只投影当前确切 trait。
                for &id in sysroot_impls[&krate]
                    .get(&declaration(identities, trait_id))
                    .into_iter()
                    .flatten()
                {
                    foreign_impls
                        .entry((
                            declaration(identities, id),
                            format!("{:?}", tcx.crate_hash(krate)),
                        ))
                        .or_insert_with(|| implementation(identities, id));
                }
            }
        }
    }
    let mut covered_ids: Vec<_> = covered
        .into_iter()
        .map(|id| declaration(identities, id))
        .collect();
    covered_ids.sort();
    for krate in sysroot {
        result.coverage.push(PurposeCoverage {
            crate_identity: identities.crate_identity(krate),
            metadata_hash: format!("{:?}", tcx.crate_hash(krate)),
            complete: true,
            reason: "pinned metadata trait_impls_in_crate 对列明 trait 的完整显式 impl 枚举；内建候选由 trait 证书另行拒绝".into(),
            traits: Some(covered_ids.clone()),
        });
    }
    result.traits.extend(foreign_traits.into_values());
    result.implementations.extend(foreign_impls.into_values());
    result.required_crates.sort();
    result.required_crates.dedup();
    result.required_views.sort();
    result.required_views.dedup();
    result
        .coverage
        .sort_by(|a, b| a.crate_identity.cmp(&b.crate_identity));
    result.traits.sort_by(|a, b| a.trait_id.cmp(&b.trait_id));
    result
        .implementations
        .sort_by(|a, b| a.implementation_id.cmp(&b.implementation_id));
    result
}
