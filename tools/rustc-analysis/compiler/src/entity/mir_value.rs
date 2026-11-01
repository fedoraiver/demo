//! MIR 的抽象内存：引用指向位置，赋值更新同一单元，保留跨调用的别名关系。
use analysis_contract::entity_names::{NameEvidence, Site};
use rustc_hir::def_id::DefId;
use rustc_middle::ty::{self, GenericArgsRef, Ty, TyCtxt};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Datum<'tcx> {
    pub ty: Ty<'tcx>,
    pub kind: Kind<'tcx>,
    pub site: Option<Site>,
}

/// 装配解释得到的可能组件与独立子实体；保留类型而不提前转成名称。
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct EntityStructure<'tcx> {
    pub components: Vec<Ty<'tcx>>,
    pub required: Vec<Ty<'tcx>>,
    pub children: Vec<EntityStructure<'tcx>>,
    pub site: Option<Site>,
    pub gaps: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Kind<'tcx> {
    Unknown(String),
    Symbol(usize, bool, String),
    Equals(usize, u128, bool),
    Unit,
    Scalar(u128),
    Text(String),
    Name(Option<String>),
    Aggregate {
        fields: Vec<Datum<'tcx>>,
        variant: usize,
    },
    Boxed(Box<Datum<'tcx>>),
    Ref(Address),
    Function(DefId, GenericArgsRef<'tcx>),
    Closure(DefId, GenericArgsRef<'tcx>, Vec<Datum<'tcx>>),
    Sink {
        templates: Vec<(Ty<'tcx>, usize)>,
        parts: Vec<NameEvidence>,
        structure: EntityStructure<'tcx>,
    },
    Snapshot(Vec<Datum<'tcx>>, Vec<NameEvidence>, EntityStructure<'tcx>),
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Address {
    pub cell: usize,
    pub fields: Vec<usize>,
}
#[derive(Clone, Debug, Default)]
pub struct Memory<'tcx> {
    pub cells: Vec<Datum<'tcx>>,
    pub constraints: BTreeMap<usize, Constraint>,
    symbols: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Constraint {
    Equal(u128),
    Except(BTreeSet<u128>),
}

impl<'tcx> Datum<'tcx> {
    pub fn new(ty: Ty<'tcx>, kind: Kind<'tcx>) -> Self {
        Self {
            ty,
            kind,
            site: None,
        }
    }
    pub fn unknown(ty: Ty<'tcx>, reason: impl Into<String>) -> Self {
        Self::new(ty, Kind::Unknown(reason.into()))
    }
    pub fn fields(&self) -> &[Self] {
        match &self.kind {
            Kind::Aggregate { fields, .. } | Kind::Closure(_, _, fields) => fields,
            _ => &[],
        }
    }
    pub fn scalar(&self) -> Option<u128> {
        match self.kind {
            Kind::Scalar(value) => Some(value),
            _ => None,
        }
    }
    pub fn text(&self) -> Option<String> {
        match &self.kind {
            Kind::Text(value) => Some(value.clone()),
            Kind::Name(value) => value.clone(),
            _ => None,
        }
    }
    pub fn owned(&self) -> bool {
        match &self.kind {
            Kind::Ref(_) | Kind::Sink { .. } | Kind::Snapshot(..) => false,
            Kind::Boxed(value) => value.owned(),
            _ => self.fields().iter().all(Self::owned),
        }
    }
    pub fn symbols(&self, symbols: &mut BTreeSet<usize>) {
        match &self.kind {
            Kind::Symbol(id, ..) | Kind::Equals(id, ..) => {
                symbols.insert(*id);
            }
            Kind::Boxed(inner) => inner.symbols(symbols),
            Kind::Snapshot(values, _, _) => {
                for value in values {
                    value.symbols(symbols);
                }
            }
            _ => {
                for field in self.fields() {
                    field.symbols(symbols);
                }
            }
        }
    }
}
impl<'tcx> Memory<'tcx> {
    /// 缓存返回值中的新符号属于本次调用，重用时重新分配；输入符号保持调用方关联。
    pub fn instantiate_summary(
        &mut self,
        value: &Datum<'tcx>,
        inputs: &BTreeSet<usize>,
        constraints: &BTreeMap<usize, Constraint>,
    ) -> Datum<'tcx> {
        fn instantiate<'tcx>(
            memory: &mut Memory<'tcx>,
            value: &Datum<'tcx>,
            inputs: &BTreeSet<usize>,
            mapping: &mut BTreeMap<usize, usize>,
        ) -> Datum<'tcx> {
            let mut result = value.clone();
            let symbol = match &mut result.kind {
                Kind::Symbol(id, ..) | Kind::Equals(id, ..) => Some(id),
                _ => None,
            };
            if let Some(id) = symbol
                && !inputs.contains(id)
            {
                *id = *mapping.entry(*id).or_insert_with(|| {
                    let id = memory.symbols;
                    memory.symbols += 1;
                    id
                });
            }
            match &mut result.kind {
                Kind::Aggregate { fields, .. } | Kind::Closure(_, _, fields) => {
                    for field in fields {
                        *field = instantiate(memory, field, inputs, mapping);
                    }
                }
                Kind::Boxed(inner) => **inner = instantiate(memory, inner, inputs, mapping),
                _ => (),
            }
            result
        }
        let mut mapping = BTreeMap::new();
        let value = instantiate(self, value, inputs, &mut mapping);
        for (&origin, constraint) in constraints {
            let id = mapping.get(&origin).copied().unwrap_or(origin);
            self.constrain(id, constraint.clone());
        }
        value
    }
    /// 调用返回后丢弃不可达的临时局部量；调用方已有单元的索引保持不变。
    pub fn compact(&mut self, prefix: usize, result: &mut Datum<'tcx>) {
        fn references(value: &Datum<'_>, visit: &mut impl FnMut(usize)) {
            match &value.kind {
                Kind::Ref(address) => visit(address.cell),
                Kind::Sink { templates, .. } => {
                    for (_, cell) in templates {
                        visit(*cell);
                    }
                }
                Kind::Boxed(inner) => references(inner, visit),
                _ => {
                    for field in value.fields() {
                        references(field, visit);
                    }
                }
            }
        }
        let mut reachable = BTreeSet::new();
        for value in self
            .cells
            .iter()
            .take(prefix)
            .chain(std::iter::once(&*result))
        {
            references(value, &mut |cell| {
                if cell >= prefix {
                    reachable.insert(cell);
                }
            });
        }
        let mut queue: Vec<_> = reachable.iter().copied().collect();
        while let Some(cell) = queue.pop() {
            if let Some(value) = self.cells.get(cell) {
                references(value, &mut |cell| {
                    if cell >= prefix && reachable.insert(cell) {
                        queue.push(cell);
                    }
                });
            }
        }
        let mapping: BTreeMap<_, _> = reachable
            .iter()
            .enumerate()
            .map(|(index, &cell)| (cell, prefix + index))
            .collect();
        fn remap(value: &mut Datum<'_>, mapping: &BTreeMap<usize, usize>) {
            match &mut value.kind {
                Kind::Ref(address) => {
                    if let Some(&cell) = mapping.get(&address.cell) {
                        address.cell = cell;
                    }
                }
                Kind::Sink { templates, .. } => {
                    for (_, cell) in templates {
                        if let Some(&replacement) = mapping.get(cell) {
                            *cell = replacement;
                        }
                    }
                }
                Kind::Boxed(inner) => remap(inner, mapping),
                Kind::Aggregate { fields, .. } | Kind::Closure(_, _, fields) => {
                    for field in fields {
                        remap(field, mapping);
                    }
                }
                _ => (),
            }
        }
        let cells = std::mem::take(&mut self.cells);
        self.cells = cells
            .into_iter()
            .enumerate()
            .filter_map(|(index, mut value)| {
                if index < prefix || reachable.contains(&index) {
                    remap(&mut value, &mapping);
                    Some(value)
                } else {
                    None
                }
            })
            .collect();
        remap(result, &mapping);
    }
    pub fn symbol(&mut self, ty: Ty<'tcx>, reason: &str) -> Datum<'tcx> {
        let id = self.symbols;
        self.symbols += 1;
        Datum::new(ty, Kind::Symbol(id, false, reason.into()))
    }
    pub fn scalar(&self, value: &Datum<'tcx>) -> Option<u128> {
        match &value.kind {
            Kind::Symbol(id, negate, _) => match self.constraints.get(id) {
                Some(Constraint::Equal(value)) => Some(if *negate {
                    (*value == 0) as u128
                } else {
                    *value
                }),
                _ => None,
            },
            Kind::Equals(id, expected, negate) => match self.constraints.get(id) {
                Some(Constraint::Equal(value)) => Some(((value == expected) != *negate) as u128),
                Some(Constraint::Except(excluded)) if excluded.contains(expected) => {
                    Some(*negate as u128)
                }
                _ => None,
            },
            _ => value.scalar(),
        }
    }
    pub fn constrain(&mut self, id: usize, constraint: Constraint) -> bool {
        let valid = match (self.constraints.get(&id), &constraint) {
            (Some(Constraint::Equal(left)), Constraint::Equal(right)) => left == right,
            (Some(Constraint::Except(excluded)), Constraint::Equal(value)) => {
                !excluded.contains(value)
            }
            (Some(Constraint::Equal(value)), Constraint::Except(excluded)) => {
                !excluded.contains(value)
            }
            _ => true,
        };
        if valid {
            let constraint = match (self.constraints.get(&id), constraint) {
                (Some(Constraint::Equal(value)), _) => Constraint::Equal(*value),
                (Some(Constraint::Except(left)), Constraint::Except(right)) => {
                    Constraint::Except(left.union(&right).copied().collect())
                }
                (_, constraint) => constraint,
            };
            self.constraints.insert(id, constraint);
        }
        valid
    }
    pub fn allocate(&mut self, value: Datum<'tcx>) -> Address {
        let cell = self.cells.len();
        self.cells.push(value);
        Address {
            cell,
            fields: vec![],
        }
    }
    pub fn read(&self, address: &Address) -> Option<Datum<'tcx>> {
        let mut value = self.cells.get(address.cell)?.clone();
        for &field in &address.fields {
            value = match &value.kind {
                Kind::Aggregate { fields, .. } | Kind::Closure(_, _, fields) => {
                    fields.get(field)?.clone()
                }
                Kind::Boxed(inner) if field == 0 => *inner.clone(),
                Kind::Name(name) if field == 0 => Datum::new(
                    value.ty,
                    name.as_ref()
                        .map(|text| Kind::Text(text.clone()))
                        .unwrap_or(Kind::Unknown("dynamic Name content".into())),
                ),
                _ => return None,
            };
        }
        Some(value)
    }
    pub fn dereference(&self, value: &Datum<'tcx>) -> Datum<'tcx> {
        let mut result = value.clone();
        for _ in 0..32 {
            match &result.kind {
                Kind::Ref(address) => match self.read(address) {
                    Some(value) => result = value,
                    None => return Datum::unknown(result.ty, "unresolved reference projection"),
                },
                _ => return result,
            }
        }
        Datum::unknown(result.ty, "cyclic reference")
    }
    pub fn write(&mut self, tcx: TyCtxt<'tcx>, address: &Address, value: Datum<'tcx>) {
        fn update<'tcx>(
            tcx: TyCtxt<'tcx>,
            current: &mut Datum<'tcx>,
            fields: &[usize],
            value: Datum<'tcx>,
        ) {
            let Some((&index, rest)) = fields.split_first() else {
                *current = value;
                return;
            };
            match &mut current.kind {
                Kind::Name(name) if index == 0 && rest.is_empty() => {
                    *name = value.text();
                    return;
                }
                Kind::Boxed(inner) if index == 0 => {
                    update(tcx, inner, rest, value);
                    return;
                }
                Kind::Aggregate { .. } | Kind::Closure(_, _, _) => (),
                _ => {
                    current.kind = Kind::Aggregate {
                        fields: field_types(tcx, current.ty)
                            .into_iter()
                            .map(|ty| Datum::unknown(ty, "uninitialized field"))
                            .collect(),
                        variant: 0,
                    }
                }
            }
            match &mut current.kind {
                Kind::Aggregate { fields, .. } | Kind::Closure(_, _, fields) => {
                    if let Some(field) = fields.get_mut(index) {
                        update(tcx, field, rest, value);
                    }
                }
                _ => (),
            }
        }
        if let Some(current) = self.cells.get_mut(address.cell) {
            update(tcx, current, &address.fields, value);
        }
    }
    pub fn snapshot(&self, value: &Datum<'tcx>) -> Datum<'tcx> {
        self.snapshot_references(value, &mut std::collections::HashSet::new())
    }
    fn snapshot_references(
        &self,
        value: &Datum<'tcx>,
        active: &mut std::collections::HashSet<Address>,
    ) -> Datum<'tcx> {
        let mut value = value.clone();
        value.kind = match &value.kind {
            Kind::Sink {
                templates,
                parts,
                structure,
            } => Kind::Snapshot(
                templates
                    .iter()
                    .map(|(_, cell)| self.snapshot_references(&self.cells[*cell], active))
                    .collect(),
                parts.clone(),
                structure.clone(),
            ),
            Kind::Symbol(id, negate, reason) => match self.scalar(&value) {
                Some(value) => Kind::Scalar(value),
                None => Kind::Symbol(*id, *negate, reason.clone()),
            },
            Kind::Equals(..) => match self.scalar(&value) {
                Some(value) => Kind::Scalar(value),
                None => value.kind.clone(),
            },
            Kind::Ref(address) => {
                if !active.insert(address.clone()) {
                    return Datum::unknown(
                        value.ty,
                        format!("cyclic abstract reference {address:?}"),
                    );
                }
                let referent = self
                    .read(address)
                    .map(|value| self.snapshot_references(&value, active))
                    .unwrap_or_else(|| Datum::unknown(value.ty, "unresolved alias"));
                active.remove(address);
                Kind::Boxed(Box::new(referent))
            }
            Kind::Aggregate { fields, variant } => Kind::Aggregate {
                fields: fields
                    .iter()
                    .map(|value| self.snapshot_references(value, active))
                    .collect(),
                variant: *variant,
            },
            Kind::Closure(id, args, fields) => Kind::Closure(
                *id,
                args,
                fields
                    .iter()
                    .map(|value| self.snapshot_references(value, active))
                    .collect(),
            ),
            Kind::Boxed(inner) => Kind::Boxed(Box::new(self.snapshot_references(inner, active))),
            kind => kind.clone(),
        };
        value
    }
}
pub fn field_types<'tcx>(tcx: TyCtxt<'tcx>, ty: Ty<'tcx>) -> Vec<Ty<'tcx>> {
    match ty.kind() {
        ty::Tuple(fields) => fields.to_vec(),
        ty::Adt(definition, args) if !definition.is_enum() => definition
            .non_enum_variant()
            .fields
            .iter()
            .map(|field| {
                tcx.normalize_erasing_regions(
                    ty::TypingEnv::fully_monomorphized(),
                    field.ty(tcx, args),
                )
            })
            .collect(),
        ty::Closure(_, args) => args.as_closure().upvar_tys().to_vec(),
        _ => vec![],
    }
}
