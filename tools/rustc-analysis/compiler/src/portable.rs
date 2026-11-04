//! 类型、MIR 与初始化分配使用独立编码；不读写 rustc 按地址共享的 StableHash 缓存。
use crate::identity::BehaviorHashContext;
use rustc_data_structures::{
    fx::FxHashMap,
    stable_hash::{DummyStableHashCtxt, StableHash, StableHashCtxt, StableHasher},
};
use rustc_middle::{
    mir::interpret::{AllocId, ConstAllocation, GlobalAlloc},
    ty::{self, Ty, TyCtxt, TypeFoldable, TypeFolder, TypeSuperFoldable, codec::TyEncoder},
};
use rustc_serialize::{Encodable, Encoder, opaque::mem_encoder::MemEncoder};
use rustc_span::{
    ByteSymbol, Span, SpanEncoder, Symbol,
    def_id::{CrateNum, DefId, DefIndex, DefPathHash},
    hygiene::{ExpnId, SyntaxContext},
};
use sha2::{Digest, Sha256};

/// 将完整编译器结构合入用途证据；定义引用继续使用原上下文的依赖闭包与循环保护。
pub(crate) fn hash<'a, 'b, 'tcx, T>(
    tcx: TyCtxt<'tcx>,
    value: &T,
    context: &'a BehaviorHashContext<'b, 'tcx>,
    hasher: &mut StableHasher,
) where
    T: Encodable<PortableEncoder<'a, 'b, 'tcx>> + TypeFoldable<TyCtxt<'tcx>>,
{
    let value = value
        .clone()
        .fold_with(&mut PortableTypes::new(tcx, context));
    // 此处只散列普通字节；绝不把 Ty、GenericArgs 或分配重新交给 StableHash。
    encode(tcx, &value, context).stable_hash(&mut DummyStableHashCtxt, hasher);
}

/// 分配自身没有可折叠类型；重定位指向的函数、vtable 和 TypeId 由编码器逐一规范化。
pub(crate) fn hash_allocation<'tcx>(
    tcx: TyCtxt<'tcx>,
    value: &ConstAllocation<'tcx>,
    context: &BehaviorHashContext<'_, 'tcx>,
    hasher: &mut StableHasher,
) {
    encode(tcx, value, context).stable_hash(&mut DummyStableHashCtxt, hasher);
}

fn encode<'a, 'b, 'tcx, T>(
    tcx: TyCtxt<'tcx>,
    value: &T,
    context: &'a BehaviorHashContext<'b, 'tcx>,
) -> Vec<u8>
where
    T: Encodable<PortableEncoder<'a, 'b, 'tcx>> + ?Sized,
{
    let mut encoder = PortableEncoder::new(tcx, context);
    value.encode(&mut encoder);
    encoder.bytes.finish()
}

/// 只在证据副本中替换含编译器内部排序或 seed 的类型，保留完整可移植结构摘要。
struct PortableTypes<'a, 'b, 'tcx> {
    tcx: TyCtxt<'tcx>,
    context: &'a BehaviorHashContext<'b, 'tcx>,
    replacements: FxHashMap<Ty<'tcx>, Ty<'tcx>>,
}

impl<'a, 'b, 'tcx> PortableTypes<'a, 'b, 'tcx> {
    fn new(tcx: TyCtxt<'tcx>, context: &'a BehaviorHashContext<'b, 'tcx>) -> Self {
        Self {
            tcx,
            context,
            replacements: FxHashMap::default(),
        }
    }

    fn existential_predicates(
        &mut self,
        predicates: &'tcx ty::List<ty::PolyExistentialPredicate<'tcx>>,
    ) -> Vec<Vec<u8>> {
        let mut predicates: Vec<_> = predicates
            .iter()
            .map(|predicate| {
                let predicate = predicate.fold_with(self);
                encode(self.tcx, &predicate, self.context)
            })
            .collect();
        // rustc 使用含 metadata 的 DefPathHash 排序；用途证据按完整谓词正文排序。
        predicates.sort();
        predicates
    }
}

impl<'tcx> TypeFolder<TyCtxt<'tcx>> for PortableTypes<'_, '_, 'tcx> {
    fn cx(&self) -> TyCtxt<'tcx> {
        self.tcx
    }

    fn fold_ty(&mut self, value: Ty<'tcx>) -> Ty<'tcx> {
        if let Some(&replacement) = self.replacements.get(&value) {
            return replacement;
        }
        let bytes = match value.kind() {
            ty::Adt(adt, args) => {
                let args = args.fold_with(self);
                let mut encoder = PortableEncoder::new(self.tcx, self.context);
                encoder.emit_str("portable-adt-v1");
                adt.did().encode(&mut encoder);
                adt.variants()
                    .iter()
                    .collect::<Vec<_>>()
                    .encode(&mut encoder);
                adt.flags().encode(&mut encoder);
                let rustc_abi::ReprOptions {
                    int,
                    align,
                    pack,
                    flags,
                    scalable,
                    field_shuffle_seed: _,
                } = adt.repr();
                // seed 来自原生 DefPathHash，并非声明语义；其它 repr 字段完整保留。
                (int, align, pack, flags, scalable).encode(&mut encoder);
                args.encode(&mut encoder);
                encoder.bytes.finish()
            }
            ty::Dynamic(predicates, region) => {
                let predicates = self.existential_predicates(predicates);
                encode(
                    self.tcx,
                    &("portable-dyn-v1", predicates, region),
                    self.context,
                )
            }
            _ => {
                let replacement = value.super_fold_with(self);
                self.replacements.insert(value, replacement);
                return replacement;
            }
        };
        // NUL 不能出现在真实 Rust 参数名中；只供编码的副本绝不提交给编译器查询。
        let name = Symbol::intern(&format!("\0portable-type-v1:{:x}", Sha256::digest(bytes)));
        let replacement = Ty::new_param(self.tcx, 0, name);
        self.replacements.insert(value, replacement);
        replacement
    }
}

pub(crate) struct PortableEncoder<'a, 'b, 'tcx> {
    tcx: TyCtxt<'tcx>,
    context: &'a BehaviorHashContext<'b, 'tcx>,
    bytes: MemEncoder,
    types: FxHashMap<Ty<'tcx>, usize>,
    predicates: FxHashMap<ty::PredicateKind<'tcx>, usize>,
    allocations: FxHashMap<AllocId, usize>,
}

impl<'a, 'b, 'tcx> PortableEncoder<'a, 'b, 'tcx> {
    fn new(tcx: TyCtxt<'tcx>, context: &'a BehaviorHashContext<'b, 'tcx>) -> Self {
        let mut encoder = Self {
            tcx,
            context,
            bytes: MemEncoder::new(),
            types: FxHashMap::default(),
            predicates: FxHashMap::default(),
            allocations: FxHashMap::default(),
        };
        encoder.emit_str("portable-typed-v2");
        encoder
    }
}

macro_rules! forward_primitives {
    ($($method:ident($value:ty);)*) => {
        $(
            fn $method(&mut self, value: $value) {
                self.bytes.$method(value);
            }
        )*
    };
}

impl Encoder for PortableEncoder<'_, '_, '_> {
    // 包含 DefId 的集合也必须按可移植定义证据排序，而不是原生 crate 编号。
    const DETERMINISTIC_HASH_MAP_ENCODE: bool = true;

    forward_primitives! {
        emit_usize(usize);
        emit_u128(u128);
        emit_u64(u64);
        emit_u32(u32);
        emit_u16(u16);
        emit_u8(u8);
        emit_isize(isize);
        emit_i128(i128);
        emit_i64(i64);
        emit_i32(i32);
        emit_i16(i16);
    }

    fn emit_raw_bytes(&mut self, value: &[u8]) {
        self.bytes.emit_raw_bytes(value);
    }
}

impl SpanEncoder for PortableEncoder<'_, '_, '_> {
    fn def_path_hasher(&self) -> impl Fn(DefId) -> DefPathHash {
        |id| DefPathHash(self.context.def_path_hash(id.to_raw_def_id()))
    }

    fn encode_span(&mut self, _: Span) {
        // 源码定位单独保存；用途证据排除物理文件、行列及 Span 内的卫生信息。
    }

    fn encode_symbol(&mut self, symbol: Symbol) {
        self.emit_str(symbol.as_str());
    }

    fn encode_byte_symbol(&mut self, symbol: ByteSymbol) {
        self.emit_byte_str(symbol.as_byte_str());
    }

    fn encode_expn_id(&mut self, _: ExpnId) {
        // 当前类型、CTFE MIR 与全局分配不应持有独立展开键；不能写入原生缓存哈希。
        panic!("Portable behavior encoding does not support a standalone expansion identifier");
    }

    fn encode_syntax_context(&mut self, _: SyntaxContext) {
        panic!("Portable behavior encoding does not support a standalone syntax context");
    }

    fn encode_crate_num(&mut self, krate: CrateNum) {
        self.encode_def_id(krate.as_def_id());
    }

    fn encode_def_index(&mut self, _: DefIndex) {
        // 无所属 crate 的索引无法绑定持久身份，拒绝产出不完整证据。
        panic!("Portable behavior encoding cannot identify an unscoped definition index");
    }

    fn encode_def_id(&mut self, id: DefId) {
        self.context.def_path_hash(id.to_raw_def_id()).encode(self);
    }
}

impl<'tcx> TyEncoder<'tcx> for PortableEncoder<'_, '_, 'tcx> {
    // 保留 MIR 的全部本地字段，不沿用跨 crate metadata 对诊断数据的裁剪。
    const CLEAR_CROSS_CRATE: bool = false;

    fn position(&self) -> usize {
        self.bytes.position()
    }

    fn type_shorthands(&mut self) -> &mut FxHashMap<Ty<'tcx>, usize> {
        &mut self.types
    }

    fn predicate_shorthands(&mut self) -> &mut FxHashMap<ty::PredicateKind<'tcx>, usize> {
        &mut self.predicates
    }

    fn encode_alloc_id(&mut self, id: &AllocId) {
        if let Some(&index) = self.allocations.get(id) {
            self.emit_u8(0);
            self.emit_usize(index);
            return;
        }
        // 编码首次遍历序号及真实内容，保留指针共享和循环，排除会话内 AllocId 数值。
        let index = self.allocations.len();
        self.allocations.insert(*id, index);
        self.emit_u8(1);
        self.emit_usize(index);
        let allocation = self
            .tcx
            .try_get_global_alloc(*id)
            .expect("Portable behavior encoding requires the referenced global allocation");
        let mut types = PortableTypes::new(self.tcx, self.context);
        match allocation {
            GlobalAlloc::Function { instance } => {
                self.emit_str("function");
                instance.fold_with(&mut types).encode(self);
            }
            GlobalAlloc::VTable(ty, predicates) => {
                self.emit_str("vtable");
                ty.fold_with(&mut types).encode(self);
                types.existential_predicates(predicates).encode(self);
            }
            GlobalAlloc::Static(id) => {
                self.emit_str("static");
                id.encode(self);
            }
            GlobalAlloc::Memory(allocation) => {
                self.emit_str("memory");
                allocation.encode(self);
            }
            GlobalAlloc::TypeId { ty } => {
                self.emit_str("type-id");
                ty.fold_with(&mut types).encode(self);
            }
        }
    }
}
