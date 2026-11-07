//! Bevy 的组件、Bundle、required 和 BSN 协议；身份来自编译器 DefId。
use crate::entity::{
    analysis::{Engine, Outcome},
    mir_value::{Address, Datum, EntityNameCandidate, EntityStructure, Kind, Memory, NameParts},
};
use analysis_contract::entity_names::NameEvidence;
use anyhow::{Result, ensure};
use rustc_infer::infer::TyCtxtInferExt;
use rustc_middle::{
    mir::{Operand, TerminatorKind},
    ty::{self, Instance, Ty},
};
use rustc_span::Span;
use rustc_trait_selection::infer::InferCtxtExt;

impl<'tcx> Engine<'tcx> {
    pub fn name_expression_span(&self, mut span: Span) -> Option<Span> {
        if span.is_dummy() {
            return None;
        }
        // 宏转发的原始实参保留自身范围；宏定义生成的代码退回对应调用位置。
        while let Some(parent) = span.parent_callsite() {
            if parent.contains(span) {
                break;
            }
            span = parent;
        }
        Some(span)
    }

    fn name_argument_expression(
        &self,
        argument: &Datum<'tcx>,
        value: &Datum<'tcx>,
    ) -> Option<Span> {
        let argument_span = argument
            .argument_span
            .and_then(|span| self.name_expression_span(span));
        let mut reference_ty = argument.ty;
        let mut shared_text = self.text_type(reference_ty) && reference_ty.is_ref();
        while let ty::Ref(_, inner, mutability) = reference_ty.kind() {
            if mutability.is_mut() {
                shared_text = false;
                break;
            }
            reference_ty = *inner;
        }
        let origin = value
            .name_expression
            // 共享文本引用保留调用来源；可变引用的外层来源可能已被后续写入失效。
            .or_else(|| shared_text.then_some(argument.name_expression).flatten())
            .and_then(|span| self.name_expression_span(span));
        // helper 的形参只转发值，保留调用方已有来源；无来源时才使用当前实参。
        origin.or(argument_span)
    }

    pub fn is_name(&self, ty: Ty<'tcx>) -> bool {
        self.identity(ty)
            .is_some_and(|(krate, name)| krate == "bevy_ecs" && name == "Name")
    }
    pub fn identity(&self, ty: Ty<'tcx>) -> Option<(String, String)> {
        match ty.peel_refs().kind() {
            ty::Adt(definition, _) => Some((
                self.tcx.crate_name(definition.did().krate).to_string(),
                self.tcx.item_name(definition.did()).to_string(),
            )),
            _ => None,
        }
    }
    pub fn implements(&mut self, ty: Ty<'tcx>, name: &str) -> bool {
        let Some(&trait_id) = self.traits.get(name) else {
            return false;
        };
        if let Some(&result) = self.trait_cache.get(&(ty, trait_id)) {
            return result;
        }
        let (context, param_env) = self.tcx.infer_ctxt().build_with_typing_env(self.env);
        let result = context
            .type_implements_trait(trait_id, [ty], param_env)
            .must_apply_modulo_regions();
        self.trait_cache.insert((ty, trait_id), result);
        result
    }
    pub fn relevant(&mut self, ty: Ty<'tcx>) -> bool {
        if let Some(&relevant) = self.relevance.get(&ty) {
            return relevant;
        }
        fn visit<'tcx>(
            engine: &mut Engine<'tcx>,
            ty: Ty<'tcx>,
            seen: &mut std::collections::HashSet<Ty<'tcx>>,
        ) -> bool {
            let ty = ty.peel_refs();
            if ty.is_unit() {
                return false;
            }
            if seen.len() >= 32 || !seen.insert(ty) {
                return false;
            }
            if engine.is_name(ty)
                || engine.implements(ty, "Scene")
                || engine.implements(ty, "SceneList")
            {
                return true;
            }
            if let ty::Adt(definition, args) = ty.kind()
                && definition.is_enum()
            {
                return definition
                    .variants()
                    .iter()
                    .flat_map(|variant| variant.fields.iter())
                    .any(|field| {
                        visit(
                            engine,
                            engine
                                .tcx
                                .normalize_erasing_regions(engine.env, field.ty(engine.tcx, args)),
                            seen,
                        )
                    });
            }
            crate::entity::mir_value::field_types(engine.tcx, ty)
                .into_iter()
                .any(|field| visit(engine, field, seen))
        }
        let relevant = visit(self, ty, &mut std::collections::HashSet::new());
        self.relevance.insert(ty, relevant);
        relevant
    }
    pub fn runtime_read(&self, instance: Instance<'tcx>, arguments: &[Datum<'tcx>]) -> bool {
        if self.tcx.crate_name(instance.def_id().krate).as_str() != "bevy_ecs"
            || self.forced.contains(&instance)
        {
            return false;
        }
        let method = self
            .tcx
            .opt_item_name(instance.def_id())
            .map(|name| name.to_string())
            .unwrap_or_default();
        matches!(
            method.as_str(),
            "get"
                | "get_mut"
                | "single"
                | "single_mut"
                | "iter"
                | "iter_mut"
                | "resource"
                | "resource_mut"
                | "get_resource"
                | "get_resource_mut"
        ) && arguments
            .first()
            .and_then(|value| self.identity(value.ty))
            .is_some_and(|(krate, name)| {
                krate == "bevy_ecs"
                    && matches!(
                        name.as_str(),
                        "World"
                            | "Query"
                            | "Res"
                            | "ResMut"
                            | "EntityRef"
                            | "EntityMut"
                            | "EntityWorldMut"
                    )
            })
    }
    pub fn text_type(&self, ty: Ty<'tcx>) -> bool {
        ty.peel_refs().is_str()
            || self.identity(ty).is_some_and(|(krate, name)| {
                matches!(krate.as_str(), "alloc" | "bevy_ecs")
                    && matches!(name.as_str(), "String" | "Cow" | "HashedStr")
            })
    }
    pub fn control_type(&self, ty: Ty<'tcx>) -> bool {
        matches!(
            ty.kind(),
            ty::Bool | ty::Int(_) | ty::Uint(_) | ty::Float(_) | ty::Char
        ) || matches!(ty.kind(), ty::Adt(definition, _) if definition.is_enum() && definition.did().is_local())
    }
    pub fn trait_method(
        &self,
        ty: Ty<'tcx>,
        trait_name: &str,
        method: &str,
    ) -> Result<Option<Instance<'tcx>>> {
        let Some(&trait_id) = self.traits.get(trait_name) else {
            return Ok(None);
        };
        let item = self
            .tcx
            .associated_items(trait_id)
            .in_definition_order()
            .find(|item| item.name().as_str() == method);
        match item {
            Some(item) => self.resolve(item.def_id, self.tcx.mk_args(&[ty.into()])),
            None => Ok(None),
        }
    }
    fn done(
        &self,
        memory: &Memory<'tcx>,
        value: Datum<'tcx>,
    ) -> Result<Option<Vec<Outcome<'tcx>>>> {
        Ok(Some(vec![Outcome {
            value,
            memory: memory.clone(),
        }]))
    }
    fn sink(&self, memory: &mut Memory<'tcx>, ty: Ty<'tcx>) -> Datum<'tcx> {
        let address = memory.allocate(Datum::new(
            ty,
            Kind::Sink {
                templates: vec![],
                parts: vec![],
                names: NameParts::default(),
                structure: EntityStructure::default(),
            },
        ));
        Datum::new(ty, Kind::Ref(address))
    }
    fn sink_address(&self, value: &Datum<'tcx>, memory: &Memory<'tcx>) -> Option<Address> {
        match &value.kind {
            Kind::Ref(address)
                if memory
                    .read(address)
                    .is_some_and(|value| matches!(value.kind, Kind::Sink { .. })) =>
            {
                Some(address.clone())
            }
            _ => None,
        }
    }
    fn add_part(&self, sink: &Datum<'tcx>, value: NameEvidence, memory: &mut Memory<'tcx>) {
        if let Some(address) = self.sink_address(sink, memory)
            && let Some(Datum {
                kind: Kind::Sink { parts, .. },
                ..
            }) = memory.cells.get_mut(address.cell)
        {
            parts.push(value);
        }
    }

    fn add_names(&self, sink: &Datum<'tcx>, value: NameParts, memory: &mut Memory<'tcx>) {
        if self.collect_structure
            && let Some(address) = self.sink_address(sink, memory)
            && let Kind::Sink { names, .. } = &mut memory.cells[address.cell].kind
        {
            names.extend(value);
        }
    }

    fn template_output(&mut self, ty: Ty<'tcx>) -> Option<Ty<'tcx>> {
        if !self.implements(ty, "Template") {
            return None;
        }
        let output = self
            .tcx
            .associated_items(self.traits["Template"])
            .in_definition_order()
            .find(|item| {
                item.opt_name()
                    .is_some_and(|name| name.as_str() == "Output")
            })?;
        Some(self.tcx.normalize_erasing_regions(
            self.env,
            ty::Unnormalized::new_wip(Ty::new_projection(
                self.tcx,
                ty::IsRigid::No,
                output.def_id,
                [ty],
            )),
        ))
    }

    fn unknown_scene_names(
        &mut self,
        sink: &Datum<'tcx>,
        reason: &str,
        memory: &mut Memory<'tcx>,
    ) -> Result<()> {
        if !self.collect_structure {
            return Ok(());
        }
        if let Some(address) = self.sink_address(sink, memory)
            && let Kind::Sink { templates, .. } = &memory.cells[address.cell].kind
        {
            let templates = templates.clone();
            // 未知场景也可能改写此前模板；后续明确赋值会替换这项名称元数据。
            for (template_ty, cell) in templates {
                let output = self.template_output(template_ty).unwrap_or(template_ty);
                if self
                    .component_types(output, 0)?
                    .iter()
                    .any(|ty| self.is_name(*ty))
                    || matches!(
                        output.kind(),
                        ty::Param(_) | ty::Dynamic(..) | ty::Alias(..)
                    )
                {
                    memory.cells[cell].name_uncertainty.push(reason.into());
                }
            }
        }
        self.add_names(sink, NameParts::potential_override(reason), memory);
        Ok(())
    }
    fn add_structure(
        &self,
        sink: &Datum<'tcx>,
        value: EntityStructure<'tcx>,
        memory: &mut Memory<'tcx>,
    ) {
        if !self.collect_structure {
            return;
        }
        if let Some(address) = self.sink_address(sink, memory)
            && let Kind::Sink { structure, .. } = &mut memory.cells[address.cell].kind
        {
            structure.components.extend(value.components);
            structure.required.extend(value.required);
            structure.children.extend(value.children);
            structure.alternatives.extend(value.alternatives);
            structure.gaps.extend(value.gaps);
        }
    }

    fn record_structure(&mut self, mut structure: EntityStructure<'tcx>, span: Span) {
        if self.collect_structure
            && let Some(creator) = self.instances.iter().rev().nth(1).copied()
        {
            if structure.name_candidates.is_empty() {
                structure
                    .name_candidates
                    .push(EntityNameCandidate::unresolved("创建时未确认 Name。"));
            }
            self.structural_creations
                .push(crate::entity::analysis::StructuralCreation {
                    creator,
                    span,
                    structure,
                });
        }
    }

    pub fn bundle_structure(&mut self, ty: Ty<'tcx>) -> Result<EntityStructure<'tcx>> {
        if !self.collect_structure {
            return Ok(EntityStructure::default());
        }
        let mut result = EntityStructure {
            components: self.component_types(ty, 0)?,
            ..EntityStructure::default()
        };
        if result.components.is_empty() && !ty.is_unit() {
            result
                .gaps
                .push(format!("Bundle 的组件类型未能唯一展开：{ty}"));
        }
        let mut pending = result.components.clone();
        let mut seen = std::collections::HashSet::new();
        while let Some(component) = pending.pop() {
            if !seen.insert(component) {
                continue;
            }
            self.required_name(component)?;
            let required = self
                .required_types
                .get(&component)
                .cloned()
                .unwrap_or_default();
            result.required.extend(required.iter().copied());
            pending.extend(required);
            if seen.len() > 128 {
                result.gaps.push("required 组件图达到分析预算。".into());
                break;
            }
        }
        result.components.sort_by_cached_key(|ty| ty.to_string());
        result.components.dedup();
        result.required.sort_by_cached_key(|ty| ty.to_string());
        result.required.dedup();
        Ok(result)
    }

    fn template(
        &self,
        sink: &Datum<'tcx>,
        ty: Ty<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Option<Address> {
        let sink_address = self.sink_address(sink, memory)?;
        let Kind::Sink { templates, .. } = &memory.cells[sink_address.cell].kind else {
            return None;
        };
        if let Some((_, cell)) = templates.iter().find(|(template_ty, _)| *template_ty == ty) {
            return Some(Address {
                cell: *cell,
                fields: vec![],
            });
        }
        let initial = if self.is_name(ty) {
            Datum::new(ty, Kind::Name(Some(String::new())))
        } else {
            self.unknown(ty, "runtime template default", memory)
        };
        let address = memory.allocate(initial);
        if let Kind::Sink { templates, .. } = &mut memory.cells[sink_address.cell].kind {
            templates.push((ty, address.cell));
        }
        Some(address)
    }
    fn insert_template(&self, sink: &Datum<'tcx>, value: Datum<'tcx>, memory: &mut Memory<'tcx>) {
        if let Some(address) = self.template(sink, value.ty, memory) {
            memory.write(self.tcx, &address, value);
        }
    }
    pub fn special_call(
        &mut self,
        instance: Instance<'tcx>,
        arguments: &[Datum<'tcx>],
        memory: &mut Memory<'tcx>,
        return_ty: Ty<'tcx>,
        span: Span,
    ) -> Result<Option<Vec<Outcome<'tcx>>>> {
        let id = instance.def_id();
        let name = self
            .tcx
            .opt_item_name(id)
            .map(|name| name.to_string())
            .unwrap_or_default();
        let krate = self.tcx.crate_name(id.krate).to_string();
        let values: Vec<_> = arguments
            .iter()
            .map(|value| memory.dereference(value))
            .collect();
        if krate == "bevy_ecs"
            && name == "clone"
            && let Some(value) = values.first()
            && value.ty == return_ty
            && (self.is_name(return_ty) || self.text_type(return_ty))
        {
            return self.done(memory, value.clone());
        }
        if krate == "bevy_ecs"
            && name == "from"
            && self
                .identity(return_ty)
                .is_some_and(|(_, name)| name == "HashedStr")
            && let Some(value) = values.first()
        {
            let mut result = value.clone();
            result.ty = return_ty;
            result.name_expression = arguments
                .first()
                .and_then(|argument| self.name_argument_expression(argument, value));
            return self.done(memory, result);
        }
        if krate == "bevy_ecs"
            && matches!(name.as_str(), "deref" | "deref_mut")
            && arguments
                .first()
                .and_then(|value| self.identity(value.ty))
                .is_some_and(|(_, name)| {
                    matches!(name.as_str(), "Res" | "ResMut" | "Local" | "Mut")
                })
        {
            self.forced.insert(instance);
        }
        if matches!(krate.as_str(), "bevy_ecs" | "bevy_scene")
            && matches!(
                name.as_str(),
                "spawn"
                    | "spawn_empty"
                    | "spawn_at"
                    | "spawn_empty_at"
                    | "spawn_batch"
                    | "spawn_scene"
                    | "queue_spawn_scene"
                    | "spawn_scene_list"
                    | "queue_spawn_scene_list"
            )
        {
            if self
                .owners
                .iter()
                .rev()
                .nth(1)
                .is_some_and(|owner| owner.is_local())
            {
                let site = self.site(span);
                let root = std::env::var("CARGO_MANIFEST_DIR")?.replace('\\', "/");
                if site.path.starts_with(&format!("{root}/")) {
                    let offset = usize::from(
                        self.tcx.def_kind(id) == rustc_hir::def::DefKind::AssocFn
                            && self.tcx.associated_item(id).is_method(),
                    );
                    let input = arguments.get(offset + usize::from(name == "spawn_at"));
                    let mut trace = self.trace.clone();
                    trace.pop();
                    for expansion in span.macro_backtrace() {
                        trace.push(format!("macro {}", expansion.kind.descr()));
                    }
                    if matches!(name.as_str(), "spawn_empty" | "spawn_empty_at") {
                        self.record_entity(&NameEvidence::Absent, &site, &trace, name.clone());
                        self.record_structure(EntityStructure::default(), span);
                    } else if let Some(input) = input {
                        if name == "spawn_batch" {
                            for (index, value) in self.list_values(input, memory).iter().enumerate()
                            {
                                let proof = self.bundle(value, memory)?;
                                let mut structure = self.bundle_structure(value.ty)?;
                                structure.name_candidates =
                                    self.bundle_names(value, memory)?.candidates();
                                self.record_structure(structure, span);
                                self.record_entity(
                                    &proof,
                                    &site,
                                    &trace,
                                    format!("{name}[{index}]"),
                                );
                            }
                        } else if matches!(
                            name.as_str(),
                            "spawn_scene_list" | "queue_spawn_scene_list"
                        ) {
                            let (proof, structures) = self.scene_list_structured(input, memory)?;
                            for structure in structures {
                                self.record_structure(structure, span);
                            }
                            self.record_entity(
                                &NameEvidence::Roots(proof),
                                &site,
                                &trace,
                                name.clone(),
                            );
                        } else {
                            let (proof, structure) = if name.contains("scene") {
                                self.scene_structured(input, memory)?
                            } else {
                                (self.bundle(input, memory)?, {
                                    let mut structure = self.bundle_structure(input.ty)?;
                                    structure.name_candidates =
                                        self.bundle_names(input, memory)?.candidates();
                                    structure
                                })
                            };
                            self.record_structure(structure, span);
                            self.record_entity(&proof, &site, &trace, name.clone());
                        }
                    }
                }
            }
            let value = self.unknown(return_ty, "entity creation result", memory);
            return self.done(memory, value);
        }
        if krate == "bevy_ecs"
            && self.is_name(return_ty)
            && matches!(name.as_str(), "new" | "from" | "default")
        {
            let content = if name == "default" {
                Some(String::new())
            } else {
                values.first().and_then(Datum::text)
            };
            let mut value = Datum::new(return_ty, Kind::Name(content));
            value.name_expression = arguments
                .first()
                .zip(values.first())
                .and_then(|(argument, value)| self.name_argument_expression(argument, value));
            return self.done(memory, value);
        }
        if krate == "bevy_ecs"
            && name == "set"
            && values.first().is_some_and(|value| self.is_name(value.ty))
        {
            if let Some(Datum {
                kind: Kind::Ref(address),
                ..
            }) = arguments.first()
            {
                let mut value = Datum::new(
                    values[0].ty,
                    Kind::Name(values.get(1).and_then(Datum::text)),
                );
                value.name_expression = arguments
                    .get(1)
                    .zip(values.get(1))
                    .and_then(|(argument, value)| self.name_argument_expression(argument, value));
                memory.write(self.tcx, address, value);
            }
            return self.done(memory, Datum::new(return_ty, Kind::Unit));
        }
        if krate == "bevy_scene"
            && matches!(
                name.as_str(),
                "get_or_insert_template" | "get_or_insert_from_template"
            )
            && let (Some(sink), ty::Ref(_, template_ty, _)) = (arguments.first(), return_ty.kind())
            && let Some(address) = self.template(sink, *template_ty, memory)
        {
            return self.done(memory, Datum::new(return_ty, Kind::Ref(address)));
        }
        if matches!(krate.as_str(), "bevy_scene" | "bevy_ecs")
            && matches!(
                name.as_str(),
                "insert_template" | "push_template" | "push_bundle_template"
            )
            && let (Some(sink), Some(value)) = (arguments.first(), values.get(1))
        {
            if name != "push_bundle_template" {
                self.insert_template(sink, value.clone(), memory);
            } else {
                let (proof, names) = self.template_parts(value, memory)?;
                let structure = self.bundle_structure(value.ty)?;
                self.add_structure(sink, structure, memory);
                self.add_part(sink, proof, memory);
                self.add_names(sink, names, memory);
            }
            return self.done(memory, Datum::new(return_ty, Kind::Unit));
        }
        if krate == "bevy_scene"
            && name == "resolve_inline"
            && values
                .first()
                .and_then(|value| self.identity(value.ty))
                .is_some_and(|(_, name)| name == "NameEntityReference")
        {
            if let (Some(value), Some(sink)) = (
                values.first().and_then(|value| value.fields().first()),
                arguments.get(2),
            ) {
                self.insert_template(sink, value.clone(), memory);
            }
            return self.done(memory, Datum::new(return_ty, Kind::Unit));
        }
        if krate == "bevy_scene"
            && name == "new"
            && self
                .identity(return_ty)
                .is_some_and(|(_, name)| name == "RelatedScenes")
        {
            return self.done(
                memory,
                Datum::new(
                    return_ty,
                    Kind::Aggregate {
                        fields: arguments.to_vec(),
                        variant: 0,
                    },
                ),
            );
        }
        if krate == "bevy_ecs" && name == "register_required" {
            if let (Some(sink), Some(constructor), Some(component_ty)) = (
                arguments.first(),
                values.get(1),
                instance.args.types().next(),
            ) {
                self.add_structure(
                    sink,
                    EntityStructure {
                        components: vec![component_ty],
                        ..EntityStructure::default()
                    },
                    memory,
                );
                let mut proofs = vec![];
                let mut names = vec![];
                for outcome in self.invoke(constructor.clone(), vec![], memory.clone(), span)? {
                    proofs.push(self.bundle(&outcome.value, &mut outcome.memory.clone())?);
                    if self.collect_structure {
                        names.push(self.bundle_names(&outcome.value, &mut outcome.memory.clone())?);
                    }
                }
                if proofs.is_empty() {
                    proofs.push(NameEvidence::Unknown(format!(
                        "required constructor for {component_ty} never returns"
                    )));
                }
                self.add_part(sink, NameEvidence::Alternatives(proofs), memory);
                if self.collect_structure {
                    let direct = self.is_name(component_ty);
                    if let Some(address) = self.sink_address(sink, memory)
                        && let Kind::Sink { names: stored, .. } =
                            &mut memory.cells[address.cell].kind
                    {
                        let names = NameParts::alternatives(names).into_required();
                        // 直接声明的 required Name 覆盖继承默认值，间接项按注册顺序填缺。
                        if direct {
                            stored.extend_direct_required(names);
                        } else {
                            stored.extend(names);
                        }
                    }
                }
            }
            return self.done(memory, Datum::new(return_ty, Kind::Unit));
        }
        if matches!(krate.as_str(), "core" | "alloc" | "std") {
            if matches!(name.as_str(), "call" | "call_mut" | "call_once")
                && let Some(callee) = values
                    .first()
                    .filter(|value| matches!(value.kind, Kind::Closure(..) | Kind::Function(..)))
            {
                let args = values
                    .get(1)
                    .map(|value| value.fields().to_vec())
                    .unwrap_or_default();
                return Ok(Some(self.invoke(
                    callee.clone(),
                    args,
                    memory.clone(),
                    span,
                )?));
            }
            if name == "new"
                && self
                    .identity(return_ty)
                    .is_some_and(|(krate, name)| krate == "alloc" && name == "Box")
                && let Some(value) = values.first()
            {
                return self.done(
                    memory,
                    Datum::new(return_ty, Kind::Boxed(Box::new(value.clone()))),
                );
            }
            if matches!(
                name.as_str(),
                "clone" | "to_owned" | "into" | "from" | "into_iter" | "into_binding_scene_bundle"
            ) && let Some(value) = values.first()
            {
                if self.is_name(return_ty) {
                    let mut result = Datum::new(return_ty, Kind::Name(value.text()));
                    result.name_expression = if self.is_name(value.ty) {
                        value.name_expression
                    } else {
                        arguments
                            .first()
                            .and_then(|argument| self.name_argument_expression(argument, value))
                    };
                    return self.done(memory, result);
                }
                let mut result = value.clone();
                result.ty = return_ty;
                if matches!(name.as_str(), "clone" | "to_owned" | "into_iter")
                    || matches!(value.kind, Kind::Text(_))
                {
                    return self.done(memory, result);
                }
                if self.text_type(return_ty) {
                    result.name_expression = arguments
                        .first()
                        .and_then(|argument| self.name_argument_expression(argument, value));
                    return self.done(memory, result);
                }
            }
            if name == "new"
                && self
                    .identity(return_ty)
                    .is_some_and(|(krate, name)| krate == "alloc" && name == "String")
            {
                return self.done(memory, Datum::new(return_ty, Kind::Text(String::new())));
            }
            if name == "type_name" {
                // 与运行时 intrinsic 使用同一格式器，保留 crate 路径及泛型参数。
                return self.done(
                    memory,
                    Datum::new(
                        return_ty,
                        Kind::Text(
                            instance
                                .args
                                .types()
                                .next()
                                .map(|ty| rustc_const_eval::util::type_name(self.tcx, ty))
                                .unwrap_or_default(),
                        ),
                    ),
                );
            }
        }
        Ok(None)
    }
    fn list_values(&self, value: &Datum<'tcx>, memory: &Memory<'tcx>) -> Vec<Datum<'tcx>> {
        let value = memory.dereference(value);
        match value.kind {
            Kind::Boxed(inner) => self.list_values(&inner, memory),
            Kind::Aggregate { fields, .. } => fields,
            _ => vec![value],
        }
    }
    pub fn component_types(&mut self, ty: Ty<'tcx>, depth: usize) -> Result<Vec<Ty<'tcx>>> {
        if depth > 32 {
            anyhow::bail!("Bundle component registration recurses too deeply for {ty}");
        }
        if self.is_name(ty) || self.implements(ty, "Component") {
            return Ok(vec![ty]);
        }
        if let Some(types) = self.bundle_types.get(&ty) {
            return Ok(types.clone());
        }
        let Some(instance) = self.trait_method(ty, "Bundle", "component_ids")? else {
            return Ok(vec![]);
        };
        ensure!(
            self.tcx.is_mir_available(instance.def_id()),
            "Necessary Bundle MIR is unavailable for {ty}"
        );
        let body = self.tcx.instance_mir(instance.def);
        let mut types = vec![];
        for block in body.basic_blocks.iter() {
            if let TerminatorKind::Call {
                func: Operand::Constant(function),
                ..
            } = &block.terminator().kind
            {
                let function = self.instantiate(instance, function.const_);
                if let ty::FnDef(id, args) = function.ty().kind() {
                    let args = self.tcx.instantiate_bound_regions_with_erased(*args);
                    let name = self.tcx.item_name(*id);
                    if self.tcx.crate_name(id.krate).as_str() == "bevy_ecs" {
                        if name.as_str() == "register_component"
                            && let Some(ty) = args.types().last()
                        {
                            types.push(ty);
                        }
                        if name.as_str() == "component_ids"
                            && let Some(ty) = args.types().next()
                        {
                            types.extend(self.component_types(ty, depth + 1)?);
                        }
                    }
                }
            }
        }
        self.bundle_types.insert(ty, types.clone());
        Ok(types)
    }
    fn find_component(
        &self,
        value: &Datum<'tcx>,
        ty: Ty<'tcx>,
        memory: &Memory<'tcx>,
    ) -> Option<Datum<'tcx>> {
        let value = memory.dereference(value);
        if value.ty == ty {
            return Some(value);
        }
        value
            .fields()
            .iter()
            .find_map(|value| self.find_component(value, ty, memory))
    }
    pub fn bundle(
        &mut self,
        value: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<NameEvidence> {
        let value = memory.dereference(value);
        if self.is_name(value.ty) {
            return Ok(NameEvidence::Name(match &value.kind {
                Kind::Name(name) => name.clone(),
                Kind::Aggregate { fields, .. } => fields.first().and_then(Datum::text),
                _ => None,
            }));
        }
        if self.implements(value.ty, "Component") {
            return self.required_name(value.ty);
        }
        if matches!(
            value.ty.kind(),
            ty::Param(_) | ty::Dynamic(..) | ty::Alias(..)
        ) {
            return Ok(NameEvidence::Unknown(format!(
                "unresolved component type {}",
                value.ty
            )));
        }
        let mut parts = vec![];
        for component_ty in self.component_types(value.ty, 0)? {
            let component = self
                .find_component(&value, component_ty, memory)
                .unwrap_or_else(|| {
                    self.unknown(component_ty, "bundle component content is dynamic", memory)
                });
            parts.push(self.bundle(&component, memory)?);
        }
        Ok(NameEvidence::Combined(parts))
    }

    fn bundle_names(
        &mut self,
        value: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<NameParts> {
        if !self.collect_structure {
            return Ok(NameParts::default());
        }
        let value = memory.dereference(value);
        if self.is_name(value.ty) {
            let content = match &value.kind {
                Kind::Name(value) => value.clone(),
                Kind::Aggregate { fields, .. } => fields.first().and_then(Datum::text),
                _ => None,
            };
            let expression = value.name_expression.or_else(|| {
                value
                    .fields()
                    .first()
                    .and_then(|field| field.name_expression.or(field.argument_span).or(field.span))
            });
            let candidate = EntityNameCandidate {
                reason: (content.is_none() && expression.is_none())
                    .then(|| "Name 内容与赋值表达式未能确认。".into()),
                expression,
                value: content,
            };
            let mut names = NameParts::explicit(candidate);
            for reason in &value.name_uncertainty {
                names.extend(NameParts::potential_override(reason));
            }
            return Ok(names);
        }
        if self.implements(value.ty, "Component") {
            self.required_name(value.ty)?;
            return Ok(self
                .required_names
                .get(&value.ty)
                .cloned()
                .unwrap_or_default());
        }
        if matches!(
            value.ty.kind(),
            ty::Param(_) | ty::Dynamic(..) | ty::Alias(..)
        ) {
            return Ok(NameParts::unresolved_required(format!(
                "组件类型未能确认：{}",
                value.ty
            )));
        }
        let mut names = NameParts::default();
        for component_ty in self.component_types(value.ty, 0)? {
            let component = self
                .find_component(&value, component_ty, memory)
                .unwrap_or_else(|| {
                    self.unknown(component_ty, "bundle component content is dynamic", memory)
                });
            names.extend(self.bundle_names(&component, memory)?);
        }
        Ok(names)
    }

    fn required_name(&mut self, ty: Ty<'tcx>) -> Result<NameEvidence> {
        if let Some(value) = self.required.get(&ty) {
            return Ok(value.clone());
        }
        if !self.proving.insert(ty) {
            return Ok(NameEvidence::Unknown(format!(
                "recursive required component graph for {ty}"
            )));
        }
        let mut parts = vec![];
        let mut names = vec![];
        if let Some(instance) =
            self.trait_method(ty, "Component", "register_required_components")?
        {
            self.forced.insert(instance);
            let body = self.tcx.instance_mir(instance.def);
            let mut memory = Memory::default();
            let mut arguments: Vec<_> = body
                .args_iter()
                .map(|local| {
                    self.unknown(
                        self.instantiate(instance, body.local_decls[local].ty),
                        "required registration argument",
                        &mut memory,
                    )
                })
                .collect();
            if let Some(argument) = arguments.get_mut(1) {
                *argument = self.sink(&mut memory, argument.ty);
            }
            let sink = arguments.get(1).cloned();
            for mut outcome in self.call(
                instance,
                arguments,
                memory,
                self.tcx.def_span(instance.def_id()),
            )? {
                if let Some(sink) = &sink {
                    if self.collect_structure {
                        let value = outcome.memory.dereference(sink);
                        if let Kind::Sink { structure, .. } = value.kind {
                            self.required_types
                                .entry(ty)
                                .or_default()
                                .extend(structure.components);
                        }
                    }
                    parts.push(self.sink_proof(sink, &mut outcome.memory)?);
                    if self.collect_structure
                        && let Kind::Sink { names: parts, .. } =
                            outcome.memory.dereference(sink).kind
                    {
                        names.push(parts);
                    }
                }
            }
        }
        let proof = NameEvidence::Required(Box::new(NameEvidence::Combined(parts)));
        self.proving.remove(&ty);
        self.required.insert(ty, proof.clone());
        if self.collect_structure {
            self.required_names
                .insert(ty, NameParts::alternatives(names).into_required());
        }
        Ok(proof)
    }
    fn sink_proof(
        &mut self,
        sink: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<NameEvidence> {
        let address = self.sink_address(sink, memory);
        let sink = memory.dereference(sink);
        let Kind::Sink {
            templates,
            mut parts,
            mut names,
            ..
        } = sink.kind
        else {
            return Ok(NameEvidence::Unknown("unresolved scene sink".into()));
        };
        for (_, cell) in templates {
            let value = memory.cells[cell].clone();
            let (proof, name) = self.template_parts(&value, memory)?;
            parts.push(proof);
            names.extend(name);
        }
        if let Some(address) = address
            && let Kind::Sink { names: stored, .. } = &mut memory.cells[address.cell].kind
        {
            *stored = names;
        }
        Ok(NameEvidence::Combined(parts))
    }
    fn template_parts(
        &mut self,
        value: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<(NameEvidence, NameParts)> {
        let mut value = value.clone();
        let uncertainty = std::mem::take(&mut value.name_uncertainty);
        let (proof, mut names) = self.template_known_parts(&value, memory)?;
        for reason in uncertainty {
            names.extend(NameParts::potential_override(reason));
        }
        Ok((proof, names))
    }

    fn template_known_parts(
        &mut self,
        value: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<(NameEvidence, NameParts)> {
        if self.is_name(value.ty)
            || self.implements(value.ty, "Component")
            || self.implements(value.ty, "Bundle")
        {
            return Ok((
                self.bundle(value, memory)?,
                self.bundle_names(value, memory)?,
            ));
        }
        if let Some(output_ty) = self.template_output(value.ty) {
            let has_name = self
                .component_types(output_ty, 0)?
                .iter()
                .any(|ty| self.is_name(*ty));
            if !has_name {
                let output = self.unknown(output_ty, "template output content is dynamic", memory);
                return Ok((
                    self.bundle(&output, memory)?,
                    self.bundle_names(&output, memory)?,
                ));
            }
            if let Some(instance) = self.trait_method(value.ty, "Template", "build_template")? {
                self.forced.insert(instance);
                let body = self.tcx.instance_mir(instance.def);
                let self_ty = self.instantiate(
                    instance,
                    body.local_decls[rustc_middle::mir::Local::from_usize(1)].ty,
                );
                let address = memory.allocate(value.clone());
                let argument = Datum::new(self_ty, Kind::Ref(address));
                let context_ty = self.instantiate(
                    instance,
                    body.local_decls[rustc_middle::mir::Local::from_usize(2)].ty,
                );
                let context = self.unknown(context_ty, "template evaluation context", memory);
                let mut proofs = vec![];
                let mut names = vec![];
                for mut outcome in self.call(
                    instance,
                    vec![argument, context],
                    memory.clone(),
                    self.tcx.def_span(instance.def_id()),
                )? {
                    if let Some(output) = outcome.value.fields().first() {
                        proofs.push(self.bundle(output, &mut outcome.memory)?);
                        names.push(self.bundle_names(output, &mut outcome.memory)?);
                    }
                }
                return Ok((
                    NameEvidence::Alternatives(proofs),
                    NameParts::alternatives(names),
                ));
            }
        }
        Ok((
            NameEvidence::Unknown(format!("unresolved component template output {}", value.ty)),
            NameParts::unresolved_required(format!("组件模板输出未能确认：{}", value.ty)),
        ))
    }
    fn sink_structure(
        &mut self,
        sink: &Datum<'tcx>,
        memory: &Memory<'tcx>,
    ) -> Result<EntityStructure<'tcx>> {
        if !self.collect_structure {
            return Ok(EntityStructure::default());
        }
        let sink = memory.dereference(sink);
        let Kind::Sink {
            templates,
            names,
            mut structure,
            ..
        } = sink.kind
        else {
            return Ok(EntityStructure {
                gaps: vec!["场景接收位置未能唯一解析。".into()],
                ..EntityStructure::default()
            });
        };
        for (template, _) in templates {
            let output_ty = if self.implements(template, "Template") {
                let trait_id = self.traits["Template"];
                let output = self
                    .tcx
                    .associated_items(trait_id)
                    .in_definition_order()
                    .find(|item| {
                        item.opt_name()
                            .is_some_and(|name| name.as_str() == "Output")
                    });
                if let Some(output) = output {
                    let projection =
                        Ty::new_projection(self.tcx, ty::IsRigid::No, output.def_id, [template]);
                    self.tcx
                        .normalize_erasing_regions(self.env, ty::Unnormalized::new_wip(projection))
                } else {
                    template
                }
            } else {
                template
            };
            let part = self.bundle_structure(output_ty)?;
            structure.components.extend(part.components);
            structure.required.extend(part.required);
            structure.gaps.extend(part.gaps);
        }
        structure.components.sort_by_cached_key(|ty| ty.to_string());
        structure.components.dedup();
        structure.required.sort_by_cached_key(|ty| ty.to_string());
        structure.required.dedup();
        structure.name_candidates = names.candidates();
        Ok(structure)
    }

    pub fn scene_structured(
        &mut self,
        value: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<(NameEvidence, EntityStructure<'tcx>)> {
        let sink = self.sink(memory, self.tcx.types.unit);
        let states = self.apply_scene(value, &sink, memory.clone())?;
        let mut proofs = vec![];
        let mut candidates: Vec<EntityStructure<'tcx>> = vec![];
        for mut state in states {
            proofs.push(self.sink_proof(&sink, &mut state)?);
            let mut part = self.sink_structure(&sink, &state)?;
            part.site = value.site.clone();
            part.span = value.span;
            if let Some(candidate) = candidates
                .iter_mut()
                .find(|candidate| candidate.same_shape(&part))
            {
                candidate.merge_name_candidates(&part);
            } else {
                candidates.push(part);
            }
        }
        let structure = if candidates.is_empty() {
            EntityStructure {
                gaps: vec!["场景协议没有可达返回状态，未提供结构候选。".into()],
                site: value.site.clone(),
                span: value.span,
                ..EntityStructure::default()
            }
        } else if candidates.len() == 1 {
            candidates.pop().expect("Single scene outcome")
        } else {
            EntityStructure {
                alternatives: vec![candidates],
                gaps: vec![
                    "保留各场景执行分支的独立结构候选；尚未导出候选与具体分支条件的关联。".into(),
                ],
                site: value.site.clone(),
                span: value.span,
                ..EntityStructure::default()
            }
        };
        Ok((NameEvidence::Alternatives(proofs), structure))
    }
    fn scene_list_structured(
        &mut self,
        value: &Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<(Vec<NameEvidence>, Vec<EntityStructure<'tcx>>)> {
        let value = memory.dereference(value);
        if let Kind::Boxed(inner) = &value.kind {
            return self.scene_list_structured(inner, memory);
        }
        if let Kind::Unknown(reason) = &value.kind {
            return Ok((
                vec![NameEvidence::Unknown(reason.clone())],
                vec![EntityStructure {
                    gaps: vec![reason.clone()],
                    ..EntityStructure::default()
                }],
            ));
        }
        if let Some((krate, name)) = self.identity(value.ty)
            && krate == "bevy_scene"
            && name == "EntityScene"
        {
            let (proof, mut structure) = self.scene_structured(&value.fields()[0], memory)?;
            structure.site = value.site.clone();
            structure.span = value.span;
            return Ok((
                vec![NameEvidence::Located {
                    site: value
                        .site
                        .clone()
                        .unwrap_or_else(|| self.site(rustc_span::DUMMY_SP)),
                    value: Box::new(proof),
                }],
                vec![structure],
            ));
        }
        if matches!(value.ty.kind(), ty::Tuple(_) | ty::Array(..))
            || self
                .identity(value.ty)
                .is_some_and(|(krate, name)| krate == "bevy_scene" && name == "SceneListScope")
        {
            let mut result = vec![];
            let mut structures = vec![];
            for field in value.fields() {
                let (proof, structure) = self.scene_list_structured(field, memory)?;
                result.extend(proof);
                structures.extend(structure);
            }
            return Ok((result, structures));
        }
        let reason = format!("dynamic SceneList {}", value.ty);
        Ok((
            vec![NameEvidence::Unknown(format!(
                "dynamic SceneList {}",
                value.ty
            ))],
            vec![EntityStructure {
                gaps: vec![reason],
                ..EntityStructure::default()
            }],
        ))
    }
    fn apply_scene(
        &mut self,
        value: &Datum<'tcx>,
        sink: &Datum<'tcx>,
        mut memory: Memory<'tcx>,
    ) -> Result<Vec<Memory<'tcx>>> {
        let value = memory.dereference(value);
        if let Kind::Boxed(inner) = &value.kind {
            return self.apply_scene(inner, sink, memory);
        }
        if let Kind::Unknown(reason) = &value.kind
            && !self.is_name(value.ty)
            && !self.implements(value.ty, "Component")
        {
            self.add_structure(
                sink,
                EntityStructure {
                    gaps: vec![reason.clone()],
                    ..EntityStructure::default()
                },
                &mut memory,
            );
            self.unknown_scene_names(sink, reason, &mut memory)?;
            self.add_part(sink, NameEvidence::Unknown(reason.clone()), &mut memory);
            return Ok(vec![memory]);
        }
        let identity = self.identity(value.ty);
        let fields = value.fields();
        if identity
            .as_ref()
            .is_some_and(|(krate, _)| krate == "bevy_scene")
        {
            match identity.as_ref().unwrap().1.as_str() {
                "SceneScope" | "EntityScene" => return self.apply_scene(&fields[0], sink, memory),
                "NameEntityReference" => {
                    self.insert_template(sink, fields[0].clone(), &mut memory);
                    return Ok(vec![memory]);
                }
                "RelatedScenes" => {
                    let (children, structures) =
                        self.scene_list_structured(&fields[0], &mut memory)?;
                    self.add_structure(
                        sink,
                        EntityStructure {
                            children: structures,
                            ..EntityStructure::default()
                        },
                        &mut memory,
                    );
                    self.add_part(sink, NameEvidence::Related(children), &mut memory);
                    return Ok(vec![memory]);
                }
                "SceneFunction" => {
                    let context =
                        self.unknown(self.tcx.types.unit, "scene resolution context", &mut memory);
                    let span = self.tcx.def_span(match &fields[0].kind {
                        Kind::Closure(id, ..) => *id,
                        _ => {
                            self.unknown_scene_names(sink, "场景函数体未能确认。", &mut memory)?;
                            return Ok(vec![memory]);
                        }
                    });
                    if let Kind::Closure(id, args, _) = fields[0].kind {
                        self.forced.insert(Instance::new_raw(id, args));
                    }
                    return Ok(self
                        .invoke(fields[0].clone(), vec![context, sink.clone()], memory, span)?
                        .into_iter()
                        .map(|outcome| outcome.memory)
                        .collect());
                }
                "TemplatePatch" => {
                    if let ty::Adt(_, args) = value.ty.kind()
                        && let Some(template_ty) = args.types().last()
                        && let Some(address) = self.template(sink, template_ty, &mut memory)
                    {
                        let argument = Datum::new(template_ty, Kind::Ref(address));
                        let context = self.unknown(
                            self.tcx.types.unit,
                            "template patch context",
                            &mut memory,
                        );
                        return Ok(self
                            .invoke(
                                fields[0].clone(),
                                vec![argument, context],
                                memory,
                                rustc_span::DUMMY_SP,
                            )?
                            .into_iter()
                            .map(|outcome| outcome.memory)
                            .collect());
                    }
                }
                _ => (),
            }
        }
        if matches!(value.ty.kind(), ty::Tuple(_)) {
            let mut states = vec![memory];
            for field in fields {
                let mut next = vec![];
                for state in states {
                    next.extend(self.apply_scene(field, sink, state)?);
                }
                states = next;
            }
            return Ok(states);
        }
        if self.is_name(value.ty) {
            self.insert_template(sink, value, &mut memory);
            return Ok(vec![memory]);
        }
        if self.implements(value.ty, "Component") || self.implements(value.ty, "Bundle") {
            let proof = self.bundle(&value, &mut memory)?;
            let names = self.bundle_names(&value, &mut memory)?;
            let structure = self.bundle_structure(value.ty)?;
            self.add_structure(sink, structure, &mut memory);
            self.add_part(sink, proof, &mut memory);
            self.add_names(sink, names, &mut memory);
            return Ok(vec![memory]);
        }
        if self.implements(value.ty, "Scene")
            && !matches!(value.ty.kind(), ty::Dynamic(..))
            && let Some(instance) = self.trait_method(value.ty, "Scene", "resolve")?
            && !matches!(instance.def, ty::InstanceKind::Virtual(..))
        {
            self.forced.insert(instance);
            let context =
                self.unknown(self.tcx.types.unit, "scene resolution context", &mut memory);
            let outcomes = self.call(
                instance,
                vec![value, context, sink.clone()],
                memory,
                self.tcx.def_span(instance.def_id()),
            )?;
            return Ok(outcomes.into_iter().map(|outcome| outcome.memory).collect());
        }
        let reason = match &value.kind {
            Kind::Unknown(reason) => reason.clone(),
            _ => format!("dynamic Scene {}", value.ty),
        };
        self.add_structure(
            sink,
            EntityStructure {
                gaps: vec![reason.clone()],
                ..EntityStructure::default()
            },
            &mut memory,
        );
        self.unknown_scene_names(sink, &reason, &mut memory)?;
        self.add_part(sink, NameEvidence::Unknown(reason), &mut memory);
        Ok(vec![memory])
    }
}
