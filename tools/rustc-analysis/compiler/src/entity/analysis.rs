//! 直接读取编译器类型与 MIR；所有分析均发生在 TyCtxt 的有效期内。
use crate::entity::mir_value::{
    Address, Constraint, Datum, EntityStructure, Kind, Memory, NameParts,
};
use analysis_contract::{
    entity_names::{Creation, Diagnostic, Report, Site},
    normalized,
};
use anyhow::{Result, ensure};
use rustc_hir::{def::DefKind, def_id::DefId};
use rustc_index::IndexVec;
use rustc_middle::{
    mir::{
        self, AggregateKind, BasicBlock, Body, Operand, Place, ProjectionElem, Rvalue,
        StatementKind, TerminatorKind,
    },
    ty::{self, GenericArgsRef, Instance, Ty, TyCtxt, TypeFoldable, TypingEnv},
};
use rustc_span::Span;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    hash::{Hash, Hasher},
    path::Path,
    rc::Rc,
};

pub struct Engine<'tcx> {
    pub tcx: TyCtxt<'tcx>,
    pub env: TypingEnv<'tcx>,
    pub report: Report,
    pub trace: Vec<String>,
    pub owners: Vec<DefId>,
    pub traits: HashMap<String, DefId>,
    pub required: HashMap<Ty<'tcx>, analysis_contract::entity_names::NameEvidence>,
    pub bundle_types: HashMap<Ty<'tcx>, Vec<Ty<'tcx>>>,
    pub proving: HashSet<Ty<'tcx>>,
    pub trait_cache: HashMap<(Ty<'tcx>, DefId), bool>,
    pub relevance: HashMap<Ty<'tcx>, bool>,
    pub forced: HashSet<Instance<'tcx>>,
    pub roots: HashSet<DefId>,
    pub collect_structure: bool,
    pub structural_creations: Vec<StructuralCreation<'tcx>>,
    pub required_types: HashMap<Ty<'tcx>, Vec<Ty<'tcx>>>,
    pub required_names: HashMap<Ty<'tcx>, NameParts>,
    pub instances: Vec<Instance<'tcx>>,
    creations: Vec<Creation>,
    diagnostics: Vec<Diagnostic>,
    live: HashMap<ty::InstanceKind<'tcx>, Rc<crate::entity::liveness::LivePlaces>>,
    active: HashSet<CallKey<'tcx>>,
    recursive: HashMap<CallKey<'tcx>, RecursiveCall<'tcx>>,
    cache: HashMap<CallKey<'tcx>, Summary<'tcx>>,
}

/// 结构报告在当前 TyCtxt 内保留真实类型，ECS 导出层负责序列化身份。
pub struct StructuralCreation<'tcx> {
    pub creator: Instance<'tcx>,
    pub span: Span,
    pub structure: EntityStructure<'tcx>,
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct CallKey<'tcx> {
    instance: Instance<'tcx>,
    arguments: Vec<Datum<'tcx>>,
    constraints: BTreeMap<usize, Constraint>,
    site: Span,
}
#[derive(Clone)]
struct Summary<'tcx> {
    value: Datum<'tcx>,
    inputs: BTreeSet<usize>,
    constraints: BTreeMap<usize, Constraint>,
    creations: Vec<Creation>,
    diagnostics: Vec<Diagnostic>,
}
#[derive(Default)]
struct RecursiveCall<'tcx> {
    observed: bool,
    returns: Vec<Summary<'tcx>>,
}
pub struct Outcome<'tcx> {
    pub value: Datum<'tcx>,
    pub memory: Memory<'tcx>,
}
struct Frame<'tcx> {
    instance: Instance<'tcx>,
    body: &'tcx Body<'tcx>,
    locals: IndexVec<mir::Local, usize>,
    live: Rc<crate::entity::liveness::LivePlaces>,
}

pub fn check(tcx: TyCtxt<'_>) -> Result<Report> {
    analyze(tcx, false).map(|(report, _)| report)
}

pub fn structures(tcx: TyCtxt<'_>) -> Result<Vec<StructuralCreation<'_>>> {
    analyze(tcx, true).map(|(_, structures)| structures)
}

/// 按需解析 Bundle 和场景协议的共享解释器，不预先扫描实体创建入口。
pub fn resolver(tcx: TyCtxt<'_>, collect_structure: bool) -> Engine<'_> {
    let traits = tcx
        .all_traits_including_private()
        .filter(|id| matches!(tcx.crate_name(id.krate).as_str(), "bevy_ecs" | "bevy_scene"))
        .map(|id| (tcx.item_name(id).to_string(), id))
        .collect();
    Engine {
        tcx,
        env: TypingEnv::fully_monomorphized(),
        report: Report::default(),
        trace: vec![],
        owners: vec![],
        traits,
        required: HashMap::new(),
        bundle_types: HashMap::new(),
        proving: HashSet::new(),
        trait_cache: HashMap::new(),
        relevance: HashMap::new(),
        forced: HashSet::new(),
        roots: HashSet::new(),
        collect_structure,
        structural_creations: vec![],
        required_types: HashMap::new(),
        required_names: HashMap::new(),
        instances: vec![],
        creations: vec![],
        diagnostics: vec![],
        live: HashMap::new(),
        active: HashSet::new(),
        recursive: HashMap::new(),
        cache: HashMap::new(),
    }
}

fn analyze(
    tcx: TyCtxt<'_>,
    collect_structure: bool,
) -> Result<(Report, Vec<StructuralCreation<'_>>)> {
    let mut engine = resolver(tcx, collect_structure);
    engine.roots = crate::entity::call_graph::creation_roots(tcx);
    let owners: Vec<_> = tcx.hir_body_owners().collect();
    for owner in owners {
        let id = owner.to_def_id();
        if !engine.roots.contains(&id)
            || !matches!(tcx.def_kind(id), DefKind::Fn | DefKind::AssocFn)
            || tcx.generics_of(id).requires_monomorphization(tcx)
        {
            continue;
        }
        let instance = Instance::mono(tcx, id);
        let body = tcx.instance_mir(instance.def);
        let mut memory = Memory::default();
        let arguments = body
            .args_iter()
            .map(|local| {
                engine.unknown(
                    engine.instantiate(instance, body.local_decls[local].ty),
                    "runtime function argument",
                    &mut memory,
                )
            })
            .collect();
        engine.call(instance, arguments, memory, tcx.def_span(id))?;
    }
    Ok((engine.report, engine.structural_creations))
}

impl<'tcx> Engine<'tcx> {
    pub fn record_entity(
        &mut self,
        value: &analysis_contract::entity_names::NameEvidence,
        site: &Site,
        trace: &[String],
        label: String,
    ) {
        let mut event = Report::default();
        event.entity(value, site, trace, label);
        self.creations.extend(event.entities.iter().cloned());
        self.diagnostics.extend(event.diagnostics.iter().cloned());
        self.report.entities.extend(event.entities);
        self.report.diagnostics.extend(event.diagnostics);
    }
    pub fn instantiate<T: TypeFoldable<TyCtxt<'tcx>>>(
        &self,
        instance: Instance<'tcx>,
        value: T,
    ) -> T {
        instance.instantiate_mir_and_normalize_erasing_regions(
            self.tcx,
            self.env,
            ty::EarlyBinder::bind(self.tcx, value),
        )
    }
    pub fn resolve(&self, id: DefId, args: GenericArgsRef<'tcx>) -> Result<Option<Instance<'tcx>>> {
        Instance::try_resolve(self.tcx, self.env, id, args)
            .map(|instance| {
                instance.filter(|instance| !matches!(instance.def, ty::InstanceKind::Virtual(..)))
            })
            .map_err(|_| anyhow::anyhow!("Cannot resolve {}", self.tcx.def_path_str(id)))
    }
    pub fn site(&self, span: Span) -> Site {
        let position = self
            .tcx
            .sess
            .source_map()
            .lookup_char_pos(span.source_callsite().lo());
        let path = position
            .file
            .name
            .prefer_local_unconditionally()
            .to_string();
        Site {
            path: normalized(Path::new(&path)).unwrap_or(path.replace('\\', "/")),
            line: position.line,
            column: position.col_display + 1,
        }
    }
    pub fn unknown(&self, ty: Ty<'tcx>, reason: &str, memory: &mut Memory<'tcx>) -> Datum<'tcx> {
        match ty.kind() {
            ty::Ref(_, inner, _) => {
                let value = self.unknown(*inner, reason, memory);
                let address = memory.allocate(value);
                Datum::new(ty, Kind::Ref(address))
            }
            ty::Tuple(fields) if fields.is_empty() => Datum::new(ty, Kind::Unit),
            _ if self.is_name(ty) => Datum::new(ty, Kind::Name(None)),
            ty::Bool | ty::Int(_) | ty::Uint(_) => memory.symbol(ty, reason),
            ty::Adt(definition, _) if definition.is_enum() => memory.symbol(ty, reason),
            _ => Datum::unknown(ty, reason),
        }
    }
    pub fn call(
        &mut self,
        instance: Instance<'tcx>,
        arguments: Vec<Datum<'tcx>>,
        memory: Memory<'tcx>,
        span: Span,
    ) -> Result<Vec<Outcome<'tcx>>> {
        let prefix = self.trace.len();
        self.trace.push(
            self.tcx
                .opt_item_name(instance.def_id())
                .map(|name| name.to_string())
                .unwrap_or_else(|| "closure".into()),
        );
        self.owners.push(instance.def_id());
        self.instances.push(instance);
        let memory_prefix = memory.cells.len();
        let mut result = self.evaluate_call(instance, arguments, memory, span, prefix);
        if let Ok(outcomes) = &mut result {
            for outcome in outcomes {
                outcome.memory.compact(memory_prefix, &mut outcome.value);
            }
        }
        self.trace.truncate(prefix);
        self.owners.pop();
        self.instances.pop();
        result
    }

    fn evaluate_call(
        &mut self,
        instance: Instance<'tcx>,
        arguments: Vec<Datum<'tcx>>,
        mut memory: Memory<'tcx>,
        span: Span,
        prefix: usize,
    ) -> Result<Vec<Outcome<'tcx>>> {
        // 框架操作直接转移抽象状态；普通函数才需要 MIR 调用摘要。
        if let Some(outcomes) = self.special_call(
            instance,
            &arguments,
            &mut memory,
            self.return_ty(instance),
            span,
        )? {
            return Ok(outcomes);
        }
        let snapshots: Vec<_> = arguments
            .iter()
            .map(|value| memory.snapshot(value))
            .collect();
        let mut inputs = BTreeSet::new();
        for value in &snapshots {
            value.symbols(&mut inputs);
        }
        let key = CallKey {
            instance,
            arguments: snapshots,
            constraints: memory
                .constraints
                .iter()
                .filter(|(id, _)| inputs.contains(id))
                .map(|(&id, value)| (id, value.clone()))
                .collect(),
            site: span,
        };
        if !self.collect_structure
            && let Some(summary) = self.cache.get(&key).cloned()
        {
            for mut item in summary.creations {
                item.trace
                    .splice(0..0, self.trace[..prefix].iter().cloned());
                self.creations.push(item.clone());
                self.report.entities.insert(item);
            }
            for mut item in summary.diagnostics {
                item.trace
                    .splice(0..0, self.trace[..prefix].iter().cloned());
                self.diagnostics.push(item.clone());
                self.report.diagnostics.insert(item);
            }
            let mut memory = memory;
            let value =
                memory.instantiate_summary(&summary.value, &summary.inputs, &summary.constraints);
            return Ok(vec![Outcome { value, memory }]);
        }
        if self.active.contains(&key)
            && let Some(recursive) = self.recursive.get_mut(&key)
        {
            recursive.observed = true;
            return Ok(recursive
                .returns
                .iter()
                .map(|summary| {
                    let mut memory = memory.clone();
                    let value = memory.instantiate_summary(
                        &summary.value,
                        &summary.inputs,
                        &summary.constraints,
                    );
                    Outcome { value, memory }
                })
                .collect());
        }
        if self.trace.len() > 64 || !self.active.insert(key.clone()) {
            let ty = self.return_ty(instance);
            let mut memory = memory;
            return Ok(vec![Outcome {
                value: self.unknown(
                    ty,
                    "recursive call summary did not converge within the analysis budget",
                    &mut memory,
                ),
                memory,
            }]);
        }
        let before = (self.creations.len(), self.diagnostics.len());
        let result = self.interpret_recursive(instance, arguments.clone(), memory, span, &key);
        if let Ok(outcomes) = &result
            && let [outcome] = outcomes.as_slice()
        {
            let unchanged = arguments
                .iter()
                .map(|value| outcome.memory.snapshot(value))
                .eq(key.arguments.iter().cloned());
            // 不缓存依赖尚未收敛的递归近似值，否则下一轮无法继续改进。
            if !self.collect_structure
                && unchanged
                && outcome.value.owned()
                && !self.recursive.values().any(|call| call.observed)
            {
                let creations = self.creations[before.0..]
                    .iter()
                    .cloned()
                    .map(|mut item| {
                        item.trace.drain(..prefix);
                        item
                    })
                    .collect();
                let diagnostics = self.diagnostics[before.1..]
                    .iter()
                    .cloned()
                    .map(|mut item| {
                        item.trace.drain(..prefix);
                        item
                    })
                    .collect();
                let mut summary = Self::return_summary(&key, outcome);
                summary.creations = creations;
                summary.diagnostics = diagnostics;
                self.cache.insert(key.clone(), summary);
            }
        }
        self.active.remove(&key);
        result
    }

    fn return_summary(key: &CallKey<'tcx>, outcome: &Outcome<'tcx>) -> Summary<'tcx> {
        let value = outcome.memory.snapshot(&outcome.value);
        let mut inputs = BTreeSet::new();
        for argument in &key.arguments {
            argument.symbols(&mut inputs);
        }
        let mut returned = BTreeSet::new();
        value.symbols(&mut returned);
        Summary {
            value,
            inputs,
            constraints: outcome
                .memory
                .constraints
                .iter()
                .filter(|(id, _)| returned.contains(id))
                .map(|(&id, value)| (id, value.clone()))
                .collect(),
            creations: vec![],
            diagnostics: vec![],
        }
    }

    fn interpret_recursive(
        &mut self,
        instance: Instance<'tcx>,
        arguments: Vec<Datum<'tcx>>,
        memory: Memory<'tcx>,
        span: Span,
        key: &CallKey<'tcx>,
    ) -> Result<Vec<Outcome<'tcx>>> {
        // 仅对没有可见引用副作用的调用求返回值不动点；引用状态仍由逐调用 MIR 解释传播。
        if !arguments.iter().all(Datum::owned) {
            return self.interpret(instance, arguments, memory, span);
        }
        self.recursive.insert(key.clone(), RecursiveCall::default());
        let result = (|| {
            let mut previous: HashSet<_> = HashSet::new();
            let mut outcomes = vec![];
            for _ in 0..16 {
                outcomes = self.interpret(instance, arguments.clone(), memory.clone(), span)?;
                if !self.recursive[key].observed {
                    return Ok(outcomes);
                }
                if !outcomes.iter().all(|outcome| outcome.value.owned()) {
                    self.recursive.remove(key);
                    return self.interpret(instance, arguments, memory, span);
                }
                let returns: Vec<_> = outcomes
                    .iter()
                    .map(|outcome| Self::return_summary(key, outcome))
                    .collect();
                let values: HashSet<_> = returns
                    .iter()
                    .map(|summary| (summary.value.clone(), summary.constraints.clone()))
                    .collect();
                if values == previous {
                    return Ok(outcomes);
                }
                if values.len() > 256 {
                    break;
                }
                previous = values;
                self.recursive.get_mut(key).unwrap().returns = returns;
            }
            let mut memory = memory;
            outcomes.push(Outcome {
                value: self.unknown(
                    self.return_ty(instance),
                    "recursive return values did not converge within the analysis budget",
                    &mut memory,
                ),
                memory,
            });
            Ok(outcomes)
        })();
        self.recursive.remove(key);
        result
    }
    fn invalidate_mutable_text(&self, arguments: &[Datum<'tcx>], memory: &mut Memory<'tcx>) {
        for argument in arguments {
            // Fn 系列调用把实参放入已知元组，仍只处理其中显式的可变文本引用。
            if matches!(argument.ty.kind(), ty::Tuple(_)) {
                self.invalidate_mutable_text(argument.fields(), memory);
                continue;
            }
            if !matches!(argument.ty.kind(), ty::Ref(_, inner, rustc_hir::Mutability::Mut) if self.text_type(*inner))
            {
                continue;
            }
            let Kind::Ref(address) = &argument.kind else {
                continue;
            };
            self.invalidate_text_slot(address, memory, 0);
        }
    }

    fn invalidate_text_slot(&self, address: &Address, memory: &mut Memory<'tcx>, depth: usize) {
        if depth >= 32 {
            return;
        }
        let Some(value) = memory.read(address) else {
            return;
        };
        if matches!(value.ty.kind(), ty::Ref(_, _, rustc_hir::Mutability::Mut))
            && let Kind::Ref(target) = &value.kind
        {
            // 可变引用既可能改写原目标，也可能被重绑；共享引用只允许重绑所在槽。
            self.invalidate_text_slot(target, memory, depth + 1);
        }
        let reason = "text modified by an uninterpreted call";
        let unknown = if value.ty.is_ref() {
            self.unknown(value.ty, reason, memory)
        } else {
            Datum::unknown(value.ty, reason)
        };
        memory.write(self.tcx, address, unknown);
    }

    fn interpret(
        &mut self,
        instance: Instance<'tcx>,
        arguments: Vec<Datum<'tcx>>,
        memory: Memory<'tcx>,
        span: Span,
    ) -> Result<Vec<Outcome<'tcx>>> {
        let mut memory = memory;
        let return_ty = self.return_ty(instance);
        if matches!(
            instance.def,
            ty::InstanceKind::Intrinsic(_) | ty::InstanceKind::LlvmIntrinsic(_)
        ) {
            self.invalidate_mutable_text(&arguments, &mut memory);
            return Ok(vec![Outcome {
                value: self.unknown(return_ty, "runtime compiler intrinsic", &mut memory),
                memory,
            }]);
        }
        if self.runtime_read(instance, &arguments) {
            return Ok(vec![Outcome {
                value: self.unknown(return_ty, "runtime ECS or resource read", &mut memory),
                memory,
            }]);
        }
        let mut relevant_mutation = false;
        for argument in &arguments {
            if let ty::Ref(_, inner, rustc_hir::Mutability::Mut) = argument.ty.kind() {
                relevant_mutation |= self.is_name(*inner)
                    || self.relevant(*inner)
                    || matches!(memory.dereference(argument).kind, Kind::Sink { .. });
            }
        }
        let needed = self.forced.contains(&instance)
            || self.roots.contains(&instance.def_id())
            || self.relevant(return_ty)
            || relevant_mutation
            || (instance.def_id().is_local()
                && (self.text_type(return_ty) || self.control_type(return_ty)));
        if !needed {
            self.callbacks(&arguments, &memory, span)?;
            self.invalidate_mutable_text(&arguments, &mut memory);
            return Ok(vec![Outcome {
                value: self.unknown(return_ty, "external runtime value", &mut memory),
                memory,
            }]);
        }
        if matches!(instance.def, ty::InstanceKind::Virtual(..)) {
            self.invalidate_mutable_text(&arguments, &mut memory);
            return Ok(vec![Outcome {
                value: self.unknown(return_ty, "dynamic dispatch target is unknown", &mut memory),
                memory,
            }]);
        }
        ensure!(
            self.tcx.is_mir_available(instance.def_id()),
            "Necessary MIR is unavailable for {}",
            self.tcx.def_path_str(instance.def_id())
        );
        let body = self.tcx.instance_mir(instance.def);
        let live = self
            .live
            .entry(instance.def)
            .or_insert_with(|| Rc::new(crate::entity::liveness::live_places(self.tcx, body)))
            .clone();
        let mut frame = Frame {
            instance,
            body,
            locals: IndexVec::new(),
            live,
        };
        for declaration in &body.local_decls {
            let value = Datum::unknown(
                self.instantiate(instance, declaration.ty),
                "uninitialized MIR local",
            );
            frame.locals.push(memory.allocate(value).cell);
        }
        for (local, value) in body.args_iter().zip(arguments) {
            memory.cells[frame.locals[local]] = value;
        }
        let mut queue = VecDeque::from([(mir::START_BLOCK, memory)]);
        let components =
            rustc_data_structures::graph::scc::Sccs::<BasicBlock, usize>::new(&body.basic_blocks);
        let mut component_sizes = vec![0usize; components.num_sccs()];
        for block in body.basic_blocks.indices() {
            component_sizes[components.scc(block)] += 1;
        }
        let mut seen: HashMap<BasicBlock, HashSet<u64>> = HashMap::new();
        let mut outcomes = Vec::new();
        while let Some((block, mut memory)) = queue.pop_front() {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            let mut symbols = BTreeSet::new();
            for local in frame.live[block].iter() {
                let value = memory.snapshot(&memory.cells[frame.locals[local]]);
                value.symbols(&mut symbols);
                value.hash(&mut hasher);
            }
            for symbol in symbols {
                memory.constraints.get(&symbol).hash(&mut hasher);
            }
            let visits = seen.entry(block).or_default();
            if !visits.insert(hasher.finish()) {
                continue;
            }
            let cyclic = component_sizes[components.scc(block)] > 1
                || body.basic_blocks[block]
                    .terminator()
                    .successors()
                    .any(|target| target == block);
            let state_limit = if cyclic { 32 } else { 256 };
            if visits.len() > state_limit {
                // widening 后仍通过正常后继传播，不能通过停止遍历隐藏后面的创建点。
                if visits.len() > state_limit + 1 {
                    continue;
                }
                for &cell in &frame.locals {
                    let value = &memory.cells[cell];
                    if !matches!(value.kind, Kind::Ref(_) | Kind::Name(_)) {
                        memory.cells[cell] = Datum::unknown(
                            value.ty,
                            if cyclic {
                                "loop state did not converge within the analysis budget"
                            } else {
                                "branch states exceed the analysis budget"
                            },
                        );
                    }
                }
            }
            let data = &body.basic_blocks[block];
            if data.is_cleanup {
                continue;
            }
            for statement in &data.statements {
                match &statement.kind {
                    StatementKind::Assign(assignment) => {
                        let (place, rvalue) = &**assignment;
                        let ty =
                            self.instantiate(instance, place.ty(&body.local_decls, self.tcx).ty);
                        let value = self.rvalue(
                            &frame,
                            rvalue,
                            ty,
                            &mut memory,
                            statement.source_info.span,
                        )?;
                        self.write(&frame, *place, value, &mut memory);
                    }
                    StatementKind::SetDiscriminant {
                        place,
                        variant_index,
                    } => {
                        let mut value = self.read(&frame, **place, &mut memory);
                        value.kind = Kind::Aggregate {
                            fields: value.fields().to_vec(),
                            variant: variant_index.index(),
                        };
                        self.write(&frame, **place, value, &mut memory);
                    }
                    _ => (),
                }
            }
            let terminator = data.terminator();
            match &terminator.kind {
                TerminatorKind::Goto { target, .. } | TerminatorKind::Drop { target, .. } => {
                    queue.push_back((*target, memory))
                }
                TerminatorKind::Assert {
                    cond,
                    expected,
                    target,
                    ..
                } => {
                    let value = self.operand(&frame, cond, &mut memory)?;
                    if memory
                        .scalar(&value)
                        .is_none_or(|value| (value != 0) == *expected)
                    {
                        queue.push_back((*target, memory));
                    }
                }
                TerminatorKind::SwitchInt { discr, targets } => {
                    let value = self.operand(&frame, discr, &mut memory)?;
                    if let Some(value) = memory.scalar(&value) {
                        queue.push_back((targets.target_for_value(value), memory));
                    } else if let Kind::Symbol(id, negate, _) = value.kind {
                        let explicit: std::collections::BTreeSet<_> = targets
                            .iter()
                            .map(|(value, _)| if negate { (value == 0) as u128 } else { value })
                            .collect();
                        for (value, target) in targets.iter() {
                            let mut branch = memory.clone();
                            if branch.constrain(
                                id,
                                Constraint::Equal(if negate {
                                    (value == 0) as u128
                                } else {
                                    value
                                }),
                            ) {
                                queue.push_back((target, branch));
                            }
                        }
                        let constraint = if value.ty.is_bool() && explicit.len() == 1 {
                            Constraint::Equal(1 - explicit.iter().next().copied().unwrap())
                        } else {
                            Constraint::Except(explicit)
                        };
                        if memory.constrain(id, constraint) {
                            queue.push_back((targets.otherwise(), memory));
                        }
                    } else if let Kind::Equals(id, expected, negate) = value.kind {
                        for truth in [false, true] {
                            let mut branch = memory.clone();
                            let constraint = if truth != negate {
                                Constraint::Equal(expected)
                            } else {
                                Constraint::Except(std::collections::BTreeSet::from([expected]))
                            };
                            if branch.constrain(id, constraint) {
                                queue.push_back((targets.target_for_value(truth as u128), branch));
                            }
                        }
                    } else {
                        for target in targets.all_targets() {
                            queue.push_back((*target, memory.clone()));
                        }
                    }
                }
                TerminatorKind::Call {
                    func,
                    args,
                    destination,
                    target,
                    fn_span,
                    ..
                } => {
                    let callee = self.operand(&frame, func, &mut memory)?;
                    let values = args
                        .iter()
                        .map(|argument| {
                            let mut value = self.operand(&frame, &argument.node, &mut memory)?;
                            value.argument_span = Some(argument.span);
                            Ok(value)
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let results = self.invoke(callee, values, memory, *fn_span)?;
                    if let Some(target) = target {
                        let result_ty = self.instantiate(
                            frame.instance,
                            destination.ty(&frame.body.local_decls, self.tcx).ty,
                        );
                        for mut result in results {
                            result.value.ty = result_ty;
                            if self.text_type(result.value.ty)
                                && result.value.name_expression.is_none()
                            {
                                result.value.name_expression =
                                    self.name_expression_span(terminator.source_info.span);
                            }
                            self.write(&frame, *destination, result.value, &mut result.memory);
                            queue.push_back((*target, result.memory));
                        }
                    }
                }
                TerminatorKind::Return => {
                    let value = memory.cells[frame.locals[mir::RETURN_PLACE]].clone();
                    outcomes.push(Outcome { value, memory });
                }
                TerminatorKind::Unreachable
                | TerminatorKind::UnwindResume
                | TerminatorKind::UnwindTerminate(_) => (),
                _ => {
                    for target in terminator.successors() {
                        if !body.basic_blocks[target].is_cleanup {
                            queue.push_back((target, memory.clone()));
                        }
                    }
                }
            }
        }
        Ok(outcomes)
    }
    pub fn invoke(
        &mut self,
        callee: Datum<'tcx>,
        values: Vec<Datum<'tcx>>,
        mut memory: Memory<'tcx>,
        span: Span,
    ) -> Result<Vec<Outcome<'tcx>>> {
        let receiver = callee.clone();
        let callee = memory.dereference(&callee);
        match callee.kind {
            Kind::Function(id, args) => {
                if self.tcx.crate_name(id.krate).as_str() == "core"
                    && self.tcx.opt_item_name(id).is_some_and(|name| {
                        matches!(name.as_str(), "call" | "call_mut" | "call_once")
                    })
                    && let Some(callable) = values.first()
                    && matches!(
                        memory.dereference(callable).kind,
                        Kind::Function(..) | Kind::Closure(..)
                    )
                {
                    let arguments = values
                        .get(1)
                        .map(|value| value.fields().to_vec())
                        .unwrap_or_default();
                    return self.invoke(callable.clone(), arguments, memory, span);
                }
                if let Some(instance) = self.resolve(id, args)? {
                    self.call(instance, values, memory, span)
                } else {
                    self.invalidate_mutable_text(&values, &mut memory);
                    let ty = self
                        .tcx
                        .fn_sig(id)
                        .instantiate(self.tcx, args)
                        .skip_binder()
                        .output();
                    Ok(vec![Outcome {
                        value: self.unknown(ty, "unresolved generic call target", &mut memory),
                        memory,
                    }])
                }
            }
            Kind::Closure(id, args, _) => {
                let instance = Instance::new_raw(id, args);
                let body = self.tcx.instance_mir(instance.def);
                let self_ty =
                    self.instantiate(instance, body.local_decls[mir::Local::from_usize(1)].ty);
                let self_value = if self_ty.is_ref() {
                    if matches!(receiver.kind, Kind::Ref(_)) {
                        receiver
                    } else {
                        let address = memory.allocate(callee);
                        Datum::new(self_ty, Kind::Ref(address))
                    }
                } else {
                    callee
                };
                let mut values = values;
                values.insert(0, self_value);
                self.call(instance, values, memory, span)
            }
            _ => {
                self.invalidate_mutable_text(&values, &mut memory);
                Ok(vec![Outcome {
                    value: Datum::unknown(
                        self.tcx.types.unit,
                        "dynamic function pointer target is unknown",
                    ),
                    memory,
                }])
            }
        }
    }
    pub fn return_ty(&self, instance: Instance<'tcx>) -> Ty<'tcx> {
        if self.tcx.def_kind(instance.def_id()) == DefKind::Closure {
            self.tcx
                .instantiate_bound_regions_with_erased(instance.args.as_closure().sig())
                .output()
        } else {
            let signature = self.tcx.instantiate_and_normalize_erasing_regions(
                instance.args,
                self.env,
                self.tcx.fn_sig(instance.def_id()),
            );
            self.tcx
                .instantiate_bound_regions_with_erased(signature)
                .output()
        }
    }
    fn callbacks(
        &mut self,
        values: &[Datum<'tcx>],
        memory: &Memory<'tcx>,
        span: Span,
    ) -> Result<()> {
        for value in values {
            let value = memory.dereference(value);
            let (id, args, closure) = match value.kind {
                Kind::Function(id, args) if id.is_local() => (id, args, false),
                Kind::Closure(id, args, _) if id.is_local() => (id, args, true),
                Kind::Aggregate { fields, .. } => {
                    self.callbacks(&fields, memory, span)?;
                    continue;
                }
                _ => continue,
            };
            if !self.roots.contains(&id) {
                continue;
            }
            let Some(instance) = self.resolve(id, args)? else {
                continue;
            };
            let body = self.tcx.instance_mir(instance.def);
            let mut memory = memory.clone();
            let mut arguments = Vec::new();
            for local in body.args_iter().skip(usize::from(closure)) {
                arguments.push(self.unknown(
                    self.instantiate(instance, body.local_decls[local].ty),
                    "runtime callback argument",
                    &mut memory,
                ));
            }
            if closure {
                arguments.insert(0, value);
            }
            self.call(instance, arguments, memory, span)?;
        }
        Ok(())
    }
    fn operand(
        &self,
        frame: &Frame<'tcx>,
        operand: &Operand<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Result<Datum<'tcx>> {
        match operand {
            Operand::Copy(place) | Operand::Move(place) => Ok(self.read(frame, *place, memory)),
            Operand::Constant(constant) => {
                let value = self.instantiate(frame.instance, constant.const_);
                let ty = value.ty();
                if let ty::FnDef(id, args) = ty.kind() {
                    return Ok(Datum::new(
                        ty,
                        Kind::Function(*id, self.tcx.instantiate_bound_regions_with_erased(*args)),
                    ));
                }
                if let Ok(value) = value.eval(self.tcx, self.env, constant.span)
                    && let Some(mut value) = crate::entity::constants::read(
                        self.tcx,
                        self.env,
                        value,
                        ty,
                        memory,
                        constant.span,
                    )
                {
                    value.site = Some(self.site(constant.span));
                    value.span = Some(constant.span);
                    return Ok(value);
                }
                Ok(self.unknown(ty, "unevaluated runtime constant", memory))
            }
            _ => Ok(Datum::unknown(
                self.tcx.types.unit,
                "unsupported MIR operand",
            )),
        }
    }
    fn address(
        &self,
        frame: &Frame<'tcx>,
        place: Place<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Option<Address> {
        let mut address = Address {
            cell: frame.locals[place.local],
            fields: vec![],
        };
        for projection in place.projection {
            match projection {
                ProjectionElem::Deref => match memory.read(&address)?.kind {
                    Kind::Ref(pointer) => address = pointer,
                    Kind::Boxed(_) => address.fields.push(0),
                    Kind::Text(_) => (),
                    _ => return None,
                },
                ProjectionElem::Field(field, _) => address.fields.push(field.index()),
                ProjectionElem::Index(local) => address
                    .fields
                    .push(memory.cells[frame.locals[local]].scalar()? as usize),
                ProjectionElem::ConstantIndex {
                    offset,
                    from_end: false,
                    ..
                } => address.fields.push(offset as usize),
                ProjectionElem::Downcast(..)
                | ProjectionElem::OpaqueCast(_)
                | ProjectionElem::UnwrapUnsafeBinder(_) => (),
                _ => return None,
            }
        }
        Some(address)
    }
    fn read(
        &self,
        frame: &Frame<'tcx>,
        place: Place<'tcx>,
        memory: &mut Memory<'tcx>,
    ) -> Datum<'tcx> {
        let ty = self.instantiate(
            frame.instance,
            place.ty(&frame.body.local_decls, self.tcx).ty,
        );
        let address = self.address(frame, place, memory);
        let stored = address.as_ref().and_then(|address| memory.read(address));
        let name_expression = stored.as_ref().and_then(|value| value.name_expression);
        let mut value = match stored {
            Some(value) if !matches!(value.kind, Kind::Unknown(_)) => value,
            value => {
                let reason = match value {
                    Some(Datum {
                        kind: Kind::Unknown(reason),
                        ..
                    }) => reason,
                    _ => "unresolved MIR place projection".into(),
                };
                let value = self.unknown(ty, &reason, memory);
                // 同一 Place 的未知字段仍是同一个值，后续读取必须保留分支关联和引用身份。
                if let Some(address) = address {
                    memory.write(self.tcx, &address, value.clone());
                }
                value
            }
        };
        value.ty = ty;
        value.name_expression = value.name_expression.or(name_expression);
        value
    }
    fn write(
        &self,
        frame: &Frame<'tcx>,
        place: Place<'tcx>,
        value: Datum<'tcx>,
        memory: &mut Memory<'tcx>,
    ) {
        if let Some(address) = self.address(frame, place, memory) {
            memory.write(self.tcx, &address, value);
        }
    }
    fn rvalue(
        &self,
        frame: &Frame<'tcx>,
        value: &Rvalue<'tcx>,
        ty: Ty<'tcx>,
        memory: &mut Memory<'tcx>,
        span: Span,
    ) -> Result<Datum<'tcx>> {
        let mut result = match value {
            Rvalue::Use(operand, _)
            | Rvalue::Cast(_, operand, _)
            | Rvalue::WrapUnsafeBinder(operand, _) => self.operand(frame, operand, memory)?,
            Rvalue::Ref(_, _, place) | Rvalue::RawPtr(_, place) => self
                .address(frame, *place, memory)
                .map(|address| Datum::new(ty, Kind::Ref(address)))
                .unwrap_or_else(|| self.unknown(ty, "unresolved borrow target", memory)),
            Rvalue::CopyForDeref(place) => self.read(frame, *place, memory),
            Rvalue::Aggregate(kind, operands) => {
                let fields = operands
                    .iter()
                    .map(|operand| self.operand(frame, operand, memory))
                    .collect::<Result<Vec<_>>>()?;
                let kind = match &**kind {
                    AggregateKind::Closure(id, args) => {
                        Kind::Closure(*id, self.instantiate(frame.instance, *args), fields)
                    }
                    AggregateKind::Adt(_, variant, ..) => Kind::Aggregate {
                        fields,
                        variant: variant.index(),
                    },
                    _ => Kind::Aggregate { fields, variant: 0 },
                };
                let mut value = Datum::new(ty, kind);
                value.site = Some(self.site(span));
                value.span = Some(span);
                value
            }
            Rvalue::Repeat(operand, count) => {
                let count = self
                    .instantiate(frame.instance, *count)
                    .try_to_target_usize(self.tcx)
                    .unwrap_or(1)
                    .min(256);
                Datum::new(
                    ty,
                    Kind::Aggregate {
                        fields: vec![self.operand(frame, operand, memory)?; count as usize],
                        variant: 0,
                    },
                )
            }
            Rvalue::Discriminant(place) => {
                let value = self.read(frame, *place, memory);
                if let Kind::Aggregate { variant, .. } = value.kind {
                    let scalar = match value.ty.kind() {
                        ty::Adt(definition, _) => {
                            definition
                                .discriminant_for_variant(
                                    self.tcx,
                                    rustc_abi::VariantIdx::from_usize(variant),
                                )
                                .val
                        }
                        _ => variant as u128,
                    };
                    Datum::new(ty, Kind::Scalar(scalar))
                } else if let Kind::Symbol(id, negate, reason) = value.kind {
                    Datum::new(ty, Kind::Symbol(id, negate, reason))
                } else {
                    self.unknown(ty, "runtime discriminant", memory)
                }
            }
            Rvalue::BinaryOp(operation, operands) => {
                let left = self.operand(frame, &operands.0, memory)?;
                let right = self.operand(frame, &operands.1, memory)?;
                let comparison = if matches!(operation, mir::BinOp::Eq | mir::BinOp::Ne) {
                    match (&left.kind, &right.kind) {
                        (Kind::Symbol(id, false, _), _) => memory
                            .scalar(&right)
                            .map(|value| Kind::Equals(*id, value, *operation == mir::BinOp::Ne)),
                        (_, Kind::Symbol(id, false, _)) => memory
                            .scalar(&left)
                            .map(|value| Kind::Equals(*id, value, *operation == mir::BinOp::Ne)),
                        _ => None,
                    }
                } else {
                    None
                };
                crate::entity::constants::binary(
                    self.tcx, self.env, *operation, &left, &right, memory, span,
                )
                .or_else(|| comparison.map(|kind| Datum::new(ty, kind)))
                .unwrap_or_else(|| self.unknown(ty, "runtime arithmetic", memory))
            }
            Rvalue::UnaryOp(operation, operand) => {
                let value = self.operand(frame, operand, memory)?;
                if let Some(result) = crate::entity::constants::unary(
                    self.tcx, self.env, *operation, &value, memory, span,
                ) {
                    result
                } else {
                    match (operation, value.kind) {
                        (mir::UnOp::Not, Kind::Symbol(id, negate, reason)) => {
                            Datum::new(ty, Kind::Symbol(id, !negate, reason))
                        }
                        (mir::UnOp::Not, Kind::Equals(id, expected, negate)) => {
                            Datum::new(ty, Kind::Equals(id, expected, !negate))
                        }
                        _ => self.unknown(ty, "runtime unary operation", memory),
                    }
                }
            }
            _ => self.unknown(ty, "runtime MIR rvalue", memory),
        };
        result.ty = ty;
        if self.is_name(ty) && result.name_expression.is_none() {
            result.name_expression = result
                .fields()
                .first()
                .and_then(|field| field.name_expression.or(field.argument_span).or(field.span));
        }
        Ok(result)
    }
}
