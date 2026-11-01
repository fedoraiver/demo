//! 复用 rustc 的活跃性和借用分析，状态比较只保留后续读取及调用方可见的局部量。
use rustc_index::{IndexVec, bit_set::DenseBitSet};
use rustc_middle::{
    mir::{BasicBlock, Body, Local, RETURN_PLACE},
    ty::TyCtxt,
};
use rustc_mir_dataflow::{
    Analysis,
    impls::{MaybeBorrowedLocals, MaybeLiveLocals},
};

pub type LivePlaces = IndexVec<BasicBlock, DenseBitSet<Local>>;

pub fn live_places<'tcx>(tcx: TyCtxt<'tcx>, body: &Body<'tcx>) -> LivePlaces {
    let mut live = MaybeLiveLocals
        .iterate_to_fixpoint(tcx, body, None)
        .into_results_cursor(body);
    let mut borrowed = MaybeBorrowedLocals
        .iterate_to_fixpoint(tcx, body, None)
        .into_results_cursor(body);
    IndexVec::from_fn_n(
        |block| {
            live.seek_to_block_start(block);
            borrowed.seek_to_block_start(block);
            let mut places = live.get().clone();
            places.union(borrowed.get());
            places.insert(RETURN_PLACE);
            for argument in body.args_iter() {
                places.insert(argument);
            }
            places
        },
        body.basic_blocks.len(),
    )
}
