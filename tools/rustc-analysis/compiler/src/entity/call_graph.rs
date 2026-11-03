//! 通过 MIR Visitor 建立反向调用索引，只把可能到达项目实体创建的函数作为入口。
use rustc_hir::{def::DefKind, def_id::DefId};
use rustc_middle::{
    mir::{self, visit::Visitor},
    ty::{self, TyCtxt},
};
use std::collections::{HashMap, HashSet, VecDeque};

pub fn creation_name(name: &str) -> bool {
    matches!(
        name,
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
}

pub fn creation_roots(tcx: TyCtxt<'_>) -> HashSet<DefId> {
    struct Index<'a, 'tcx> {
        tcx: TyCtxt<'tcx>,
        owner: DefId,
        callers: &'a mut HashMap<DefId, HashSet<DefId>>,
        creators: &'a mut HashSet<DefId>,
        visited: &'a mut HashSet<DefId>,
    }
    impl<'tcx> Visitor<'tcx> for Index<'_, 'tcx> {
        fn visit_operand(&mut self, operand: &mir::Operand<'tcx>, location: mir::Location) {
            if let mir::Operand::Constant(constant) = operand {
                if let ty::FnDef(callee, _) = constant.const_.ty().kind() {
                    self.callers.entry(*callee).or_default().insert(self.owner);
                    if matches!(
                        self.tcx.crate_name(callee.krate).as_str(),
                        "bevy_ecs" | "bevy_scene"
                    ) && self
                        .tcx
                        .opt_item_name(*callee)
                        .is_some_and(|name| creation_name(name.as_str()))
                    {
                        self.creators.insert(self.owner);
                    }
                }
                if let ty::Closure(callee, _) = constant.const_.ty().kind() {
                    self.closure(*callee);
                }
            }
            self.super_operand(operand, location);
        }
        fn visit_rvalue(&mut self, rvalue: &mir::Rvalue<'tcx>, location: mir::Location) {
            if let mir::Rvalue::Aggregate(kind, _) = rvalue
                && let mir::AggregateKind::Closure(callee, _) = &**kind
            {
                self.closure(*callee);
            }
            self.super_rvalue(rvalue, location);
        }
    }
    impl<'tcx> Index<'_, 'tcx> {
        fn closure(&mut self, callee: DefId) {
            self.callers.entry(callee).or_default().insert(self.owner);
            if callee.is_local() && self.visited.insert(callee) {
                Index {
                    tcx: self.tcx,
                    owner: callee,
                    callers: self.callers,
                    creators: self.creators,
                    visited: self.visited,
                }
                .visit_body(self.tcx.optimized_mir(callee));
            }
        }
    }
    let mut callers: HashMap<DefId, HashSet<DefId>> = HashMap::new();
    let mut creators = HashSet::new();
    let mut visited = HashSet::new();
    for owner in tcx.hir_body_owners() {
        let id = owner.to_def_id();
        if !matches!(
            tcx.def_kind(id),
            DefKind::Fn | DefKind::AssocFn | DefKind::Closure
        ) {
            continue;
        }
        if tcx.def_kind(id) == DefKind::AssocFn
            && let Some(trait_item) = tcx.associated_item(id).trait_item_def_id()
        {
            callers.entry(id).or_default().insert(trait_item);
        }
        if visited.insert(id) {
            Index {
                tcx,
                owner: id,
                callers: &mut callers,
                creators: &mut creators,
                visited: &mut visited,
            }
            .visit_body(tcx.optimized_mir(id));
        }
    }
    let mut queue: VecDeque<_> = creators.iter().copied().collect();
    while let Some(callee) = queue.pop_front() {
        if let Some(functions) = callers.get(&callee) {
            for &caller in functions {
                if creators.insert(caller) {
                    queue.push_back(caller);
                }
            }
        }
    }
    creators
}
