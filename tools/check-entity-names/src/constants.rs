//! 使用 rustc 的常量解释器读取值和字段布局，不把聚合类型的标量 ABI 当作整数。
use crate::mir_value::{Datum, Kind, Memory};
use rustc_abi::FieldIdx;
use rustc_const_eval::{
    const_eval::{CompileTimeInterpCx, mk_eval_cx_for_const_val},
    interpret::{ImmTy, OpTy},
};
use rustc_middle::{
    mir::{self, interpret::Scalar},
    ty::{self, Ty, TyCtxt, TypingEnv},
};
use rustc_span::Span;

pub fn read<'tcx>(
    tcx: TyCtxt<'tcx>,
    env: TypingEnv<'tcx>,
    value: mir::ConstValue,
    ty: Ty<'tcx>,
    memory: &mut Memory<'tcx>,
    span: Span,
) -> Option<Datum<'tcx>> {
    let (context, operand) = mk_eval_cx_for_const_val(tcx.at(span), env, value, ty)?;
    from_operand(&context, &operand, memory, 0)
}

fn from_operand<'tcx>(
    context: &CompileTimeInterpCx<'tcx>,
    operand: &OpTy<'tcx>,
    memory: &mut Memory<'tcx>,
    depth: usize,
) -> Option<Datum<'tcx>> {
    let ty = operand.layout.ty;
    if depth > 32 {
        return Some(Datum::unknown(
            ty,
            "recursive constant exceeds the analysis budget",
        ));
    }
    let mut aggregate = operand.clone();
    let (count, variant, closure) = match ty.kind() {
        ty::Tuple(fields) => (fields.len(), 0, None),
        ty::Closure(id, args) => (args.as_closure().upvar_tys().len(), 0, Some((*id, *args))),
        ty::Adt(definition, _) if !definition.is_union() => {
            let variant = context.read_discriminant(operand).discard_err()?;
            aggregate = context.project_downcast(operand, variant).discard_err()?;
            (
                definition.variant(variant).fields.len(),
                variant.index(),
                None,
            )
        }
        ty::Array(_, length) => (
            length.try_to_target_usize(context.tcx.tcx)? as usize,
            0,
            None,
        ),
        ty::Ref(_, inner, _) if inner.is_str() => {
            let pointee = context.deref_pointer(operand).discard_err()?;
            return Some(Datum::new(
                ty,
                Kind::Text(context.read_str(&pointee).discard_err()?.to_owned()),
            ));
        }
        ty::Ref(..) => {
            let pointee = context.deref_pointer(operand).discard_err()?;
            let value = from_operand(context, &pointee.into(), memory, depth + 1)?;
            let address = memory.allocate(value);
            return Some(Datum::new(ty, Kind::Ref(address)));
        }
        _ => {
            let scalar = context
                .read_immediate(operand)
                .discard_err()?
                .to_scalar_int()
                .discard_err()?;
            return Some(Datum::new(ty, Kind::Scalar(scalar.to_bits_unchecked())));
        }
    };
    if count > 256 {
        return Some(Datum::unknown(
            ty,
            "constant aggregate exceeds the analysis budget",
        ));
    }
    let mut fields = Vec::with_capacity(count);
    for index in 0..count {
        let field = context
            .project_field(&aggregate, FieldIdx::from_usize(index))
            .discard_err()?;
        fields.push(from_operand(context, &field, memory, depth + 1)?);
    }
    let kind = if let Some((id, args)) = closure {
        Kind::Closure(id, args, fields)
    } else if ty.is_unit() {
        Kind::Unit
    } else {
        Kind::Aggregate { fields, variant }
    };
    Some(Datum::new(ty, kind))
}

pub fn binary<'tcx>(
    tcx: TyCtxt<'tcx>,
    env: TypingEnv<'tcx>,
    operation: mir::BinOp,
    left: &Datum<'tcx>,
    right: &Datum<'tcx>,
    memory: &mut Memory<'tcx>,
    span: Span,
) -> Option<Datum<'tcx>> {
    let left_bits = memory.scalar(left)?;
    let right_bits = memory.scalar(right)?;
    let left_layout = tcx.layout_of(env.as_query_input(left.ty)).ok()?;
    let right_layout = tcx.layout_of(env.as_query_input(right.ty)).ok()?;
    let left_scalar = Scalar::from_uint(left_bits, left_layout.size);
    let (context, operand) = mk_eval_cx_for_const_val(
        tcx.at(span),
        env,
        mir::ConstValue::Scalar(left_scalar),
        left.ty,
    )?;
    let left = context.read_immediate(&operand).discard_err()?;
    let right = ImmTy::from_scalar(
        Scalar::from_uint(right_bits, right_layout.size),
        right_layout,
    );
    let result = context.binary_op(operation, &left, &right).discard_err()?;
    from_operand(&context, &result.into(), memory, 0)
}

pub fn unary<'tcx>(
    tcx: TyCtxt<'tcx>,
    env: TypingEnv<'tcx>,
    operation: mir::UnOp,
    value: &Datum<'tcx>,
    memory: &mut Memory<'tcx>,
    span: Span,
) -> Option<Datum<'tcx>> {
    let bits = memory.scalar(value)?;
    let layout = tcx.layout_of(env.as_query_input(value.ty)).ok()?;
    let (context, operand) = mk_eval_cx_for_const_val(
        tcx.at(span),
        env,
        mir::ConstValue::Scalar(Scalar::from_uint(bits, layout.size)),
        value.ty,
    )?;
    let value = context.read_immediate(&operand).discard_err()?;
    let result = context.unary_op(operation, &value).discard_err()?;
    from_operand(&context, &result.into(), memory, 0)
}
