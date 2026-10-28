// 类型目录保留实体投影身份；访问分析只收集源码中可确认的语法，不把声明写访问冒充字段修改。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from './paths.mjs';
import { infrastructureFeature } from './architecture-infrastructure.mjs';
import { nodeKindOf } from './architecture-kinds.mjs';

const repository = repositoryRoot;
const unique = values => [...new Set(values.filter(Boolean))];
const distinct = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const functionKinds = new Set(['System', 'Observer']);
const operations = new Set(['read', 'write', 'insert', 'remove', 'filter', 'reflect_read', 'reflect_write']);
const labels = {
  contains: '可能挂载于', read: '查询访问', write: '可变访问', insert: '添加', remove: '移除',
  filter: '存在 / 变更过滤', reflect_read: '反射查看', reflect_write: '反射可选编辑',
};
// 这些清单显示名省略泛型参数；实参分别来自对应 BSN 场景、动作列表和状态清理声明。
const reviewedTypeNames = {
  ...Object.fromEntries(['controller', 'character', 'parcel', 'camera', 'island', 'menu_backdrop'].map(entity => [`${entity}.DespawnOnExit`, 'DespawnOnExit<crate::game_flow::AppState>'])),
  ...Object.fromEntries(['Actions', 'ContextPriority', 'ContextActivity'].flatMap(type => [
    [`controller.${type}`, `${type}<crate::first_person::actions::GameplayContext>`],
    [`menu_controller.${type}`, `${type}<crate::ui::navigation::MenuContext>`],
  ])),
};
function sourceIdentity(source) {
  return source ? [source.dependency?.name || 'project', source.dependency?.version || '', source.path, source.line].join('|') : null;
}

function nominal(value) {
  return String(value || '').replace(/\s+/g, '').split('<')[0].split('::').at(-1);
}

function typeIdentity(component, record) {
  const explicit = component.rust_type || record.rust_type;
  const type = explicit || reviewedTypeNames[component.id] || component.name;
  const verifiedDefinition = record.definition_source || component.definition_source;
  const definition = verifiedDefinition
    || (!infrastructureFeature(record.defined_in || record.feature) ? component.source : null);
  const declared = definition && sourceIdentity(definition);
  const explicitId = component.type_id || component.component_type_id;
  // 已解析声明优先于导入路径的拼写；具体泛型实参仍属于类型身份。
  const declaredType = type.replace(/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*::/, '').replace(/\s+/g, '');
  const identity = explicitId ? `explicit:${explicitId}`
    : declared && (!explicit || verifiedDefinition) ? `definition:${declared}|${declaredType}` : explicit ? `rust:${explicit}` : `projection:${component.id}`;
  const rustType = explicit || (definition && !definition.dependency
    ? `crate::${definition.path.replace(/^src\//, '').replace(/\/(?:mod|main)\.rs$/, '').replace(/\.rs$/, '').replaceAll('/', '::')}::${type}`
    : type);
  return { identity, type, rustType, definition, verified: Boolean(explicitId || explicit || declared) };
}

// 注释、字符串和字符字面量留等长空白，保留源码偏移与行号。
export function maskRustSource(text) {
  const output = text.split('');
  const blank = (start, end) => { for (let index = start; index < end; index++) if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' '; };
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index); blank(index, end < 0 ? text.length : end); index = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const start = index; let depth = 1; index += 2;
      while (index < text.length && depth) {
        if (text.startsWith('/*', index)) { depth++; index += 2; }
        else if (text.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
      blank(start, index);
    } else {
      const raw = /^(?:b)?r(#{0,255})"/.exec(text.slice(index));
      const character = text[index] === "'" && /^(?:'(?:[^'\\\r\n]|\\[^\r\n])')/.exec(text.slice(index));
      if (raw) {
        const start = index, close = '"' + raw[1]; index += raw[0].length;
        const end = text.indexOf(close, index); index = end < 0 ? text.length : end + close.length; blank(start, index);
      } else if (text[index] === '"') {
        const start = index++;
        while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index++] === '"') break; }
        blank(start, index);
      } else if (character) { blank(index, index + character[0].length); index += character[0].length; }
      else index++;
    }
  }
  return output.join('');
}

function closing(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}

function commaParts(text) {
  const parts = []; let start = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    if ('(<[{'.includes(text[index])) depth++;
    if (')>]}'.includes(text[index])) depth--;
    if (text[index] === ',' && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function outerTypes(text) {
  const value = text.trim();
  if (value.startsWith('(')) return commaParts(value.slice(1, -1)).flatMap(outerTypes);
  const match = /^([A-Za-z_]\w*(?:::\w+)*)(?:\s*<([\s\S]*)>)?$/.exec(value);
  return match ? [value] : [];
}

function queryInputs(signature) {
  const inputs = [];
  for (const parameter of commaParts(signature.slice(1, -1))) {
    const head = /\b([a-z_]\w*)\s*:\s*(Query|ParamSet)\s*</.exec(parameter);
    if (!head) continue;
    const open = head.index + head[0].lastIndexOf('<'), end = closing(parameter, open, '<', '>');
    if (end < 0) continue;
    const inside = parameter.slice(open + 1, end).trim();
    const queries = head[2] === 'Query' ? [inside] : inside.startsWith('(') ? commaParts(inside.slice(1, -1)) : [];
    for (const [index, value] of queries.entries()) {
      const contents = head[2] === 'Query' ? value : /^Query\s*<([\s\S]*)>$/.exec(value)?.[1];
      if (contents) inputs.push({ receiver: head[1] + (head[2] === 'ParamSet' ? `.p${index}()` : ''), data: commaParts(contents)[0] });
    }
  }
  return inputs;
}

function sourceDatabase(model, registry, readSource) {
  const files = new Map(), functions = [];
  const paths = unique(Object.values(registry).map(node => node.source).filter(source => source?.path?.startsWith('src/') && !source.dependency).map(source => source.path));
  for (const filename of paths) {
    const text = readSource(filename);
    if (typeof text !== 'string') continue;
    const masked = maskRustSource(text), lineAt = offset => text.slice(0, offset).split('\n').length;
    const file = { path: filename, text, masked, lineAt }; files.set(filename, file);
    for (const match of masked.matchAll(/\bfn\s+([A-Za-z_]\w*)(?:\s*<[^;{}]*?>)?\s*\(/g)) {
      const parameterStart = masked.indexOf('(', match.index), parameterEnd = closing(masked, parameterStart, '(', ')');
      if (parameterEnd < 0) continue;
      const bodyStart = masked.indexOf('{', parameterEnd), terminator = masked.indexOf(';', parameterEnd);
      if (bodyStart < 0 || (terminator >= 0 && terminator < bodyStart)) continue;
      const bodyEnd = closing(masked, bodyStart, '{', '}');
      if (bodyEnd < 0) continue;
      functions.push({ ...file, name: match[1], start: match.index, parameterStart, parameterEnd, bodyStart, bodyEnd,
        signature: masked.slice(parameterStart, parameterEnd + 1), body: masked.slice(bodyStart + 1, bodyEnd), line: lineAt(match.index) });
    }
  }
  function forSystem(system) {
    return functions.find(fn => fn.path === system.source?.path && fn.line === system.source?.line);
  }
  function helper(caller, name) {
    const candidates = functions.filter(fn => fn.name === name);
    const local = candidates.filter(fn => fn.path === caller.path);
    return local.length === 1 ? local[0] : candidates.length === 1 ? candidates[0] : null;
  }
  return { files, functions, forSystem, helper };
}

function mergedSystems(model, registry, merge = true) {
  const groups = new Map(), functionIdBySystemId = {}, systemByFunctionId = {};
  for (const original of model.systems || []) {
    const record = registry[original.id];
    if (!record || nodeKindOf(record) === 'Synchronization') continue;
    const callable = functionKinds.has(nodeKindOf(record));
    const key = merge && callable && record.source ? `function:${sourceIdentity(record.source)}` : `node:${record.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const [key, records] of groups) {
    const first = records[0], id = records.length > 1 ? `component-function-${hash(key)}` : first.id;
    const descriptions = unique(records.map(record => record.description));
    const description = records.length > 1 && first.source?.path === 'src/character/motion.rs' && first.name === 'update_grounded'
      ? '探测角色脚下支撑面并更新接地状态。' : descriptions[0] || '';
    const notes = unique(first.notes || []).filter(note => records.every(record => (record.notes || []).includes(note)));
    const registrations = records.flatMap(record => (record.registrations || []).map(registration => ({
      ...registration, registrationId: record.id,
      notes: unique([...(registration.notes || []), ...(registration.scope === 'runtime' ? [
        ...(record.notes || []).filter(note => !notes.includes(note)),
        ...(record.description && record.description !== description ? [record.description] : []),
      ] : [])]),
    })));
    const merged = { ...first, id, targetNodeId: first.id, registrationIds: records.map(record => record.id), registrations, notes,
      description,
      reads: unique(records.flatMap(record => record.reads || [])), writes: unique(records.flatMap(record => record.writes || [])),
      filters: unique(records.flatMap(record => record.filters || [])), events: unique(records.flatMap(record => record.events || [])),
      registrationDescriptions: records.map(record => ({ registrationId: record.id, description: record.description })),
    };
    if (records.length > 1) registry[id] = merged;
    systemByFunctionId[id] = merged;
    for (const record of records) functionIdBySystemId[record.id] = id;
  }
  return { functionIdBySystemId, systemByFunctionId };
}

function reviewedHeldTargetAccesses(registry) {
  if (!registry['parcel.HeldTarget']) return [];
  const source = (label, path, line, role = 'operation') => ({ role, label, path, line, column: 1 });
  const fact = (system, operation, sourceEntries, notes = []) => ({ system, component: 'parcel.HeldTarget', operation, sourceEntries, notes, evidence: 'reviewed' });
  const result = [
    fact('interaction', 'insert', [source('拾取时插入 HeldTarget', 'src/item_interaction/interaction.rs', 109)]),
    ...['held_fixed', 'held_update'].map(system => fact(system, 'write', [source('Query<&mut HeldTarget>', 'src/item_interaction/pose.rs', 93, 'parameter'), source('更新 translation 与 rotation', 'src/item_interaction/pose.rs', 103)])),
    fact('orphan_cleanup', 'filter', [source('With<HeldTarget> 存在过滤', 'src/item_interaction/lifecycle.rs', 132, 'parameter')], ['此过滤只要求组件存在，不读取目标字段。']),
  ];
  for (const [system, path, line, condition] of [
    ['interaction', 'src/item_interaction/interaction.rs', 63, '主动释放当前物品。'],
    ['orphan_cleanup', 'src/item_interaction/lifecycle.rs', 141, '持有关系缺失或持有者已不存在。'],
    ['facing_fixed', 'src/first_person/facing.rs', 63, '固定步转向路径被阻挡。'],
    ['facing_update', 'src/first_person/facing.rs', 63, '逐帧转向路径被阻挡。'],
    ['carry_align', 'src/item_interaction/attachment.rs', 177, '对齐路径持续受阻达到 0.35 秒。'],
    ['water_recover', 'src/bounds_recovery/recovery.rs', 112, '角色或物品 Position.y < -1.5，恢复出生姿态。'],
  ]) {
    const entries = [source('release_item 调用处', path, line, 'call'), source('将 World 闭包排入 Commands.queue', 'src/item_interaction/lifecycle.rs', 24), source('Commands.queue 中的存在检查', 'src/item_interaction/lifecycle.rs', 36), source('实际移除 HeldTarget', 'src/item_interaction/lifecycle.rs', 49)];
    if (system === 'water_recover') entries.push(source('物品落水调用 release_item', 'src/bounds_recovery/recovery.rs', 127), source('物品落水直接移除', 'src/bounds_recovery/recovery.rs', 137));
    result.push(fact(system, 'remove', entries, [condition, 'release_item 是普通辅助函数；存在检查与移除在 Commands.queue 闭包应用时执行。', '仅在缺少 HeldAttachment 时检查 HeldTarget 是否存在，没有读取 translation 或 rotation。']));
  }
  const dependency = registry.inspector_pass?.definition_source?.dependency;
  if (registry.inspector_pass) for (const [operation, line, label] of [['reflect_read', 674, '取得现存组件的反射访问'], ['reflect_write', 707, '可选反射字段编辑']]) {
    const entries = dependency ? [{ role: 'operation', label, path: 'src/bevy_inspector/mod.rs', line, column: 1, dependency }] : [];
    if (operation === 'reflect_read') {
      entries.unshift(source('注册 HeldTarget 的 ReflectComponent', 'src/item_interaction/mod.rs', 49, 'configure'));
      if (dependency) entries.push({ role: 'related', label: '独占 World 的检查器入口', path: 'src/quick.rs', line: 92, column: 1, dependency },
        { role: 'call', label: '调用通用 World 检查器', path: 'src/quick.rs', line: 106, column: 1, dependency });
    } else {
      entries.unshift(source('项目检查器启用与运行条件', 'src/inspector/mod.rs', 16, 'configure'));
      if (dependency) entries.push({ role: 'operation', label: '反射改动后标记 changed', path: 'src/bevy_inspector/mod.rs', line: 716, column: 1, dependency });
    }
    result.push(fact('inspector_pass', operation, entries,
      ['HeldTarget 已注册 ReflectComponent；world_inspector_ui 使用独占 World 动态访问。', operation === 'reflect_write' ? '仅用户编辑现存字段时写入并标记 changed，不添加或移除组件。' : '显示 translation 与 rotation；项目业务系统没有读取这些字段的路径。']));
  }
  const reviewedLabels = { insert: '拾取后添加', write: '&mut HeldTarget', filter: 'With<HeldTarget>', reflect_read: '反射查看', reflect_write: '反射可选编辑' };
  const removalLabels = { interaction: '主动释放时移除', orphan_cleanup: '持有关系失效时移除', facing_fixed: '转向受阻时移除', facing_update: '转向受阻时移除', carry_align: '持续对齐受阻时移除', water_recover: '落水恢复时移除' };
  return result.filter(access => registry[access.system]).map(access => ({ ...access, label: access.operation === 'remove' ? removalLabels[access.system] : reviewedLabels[access.operation] }));
}

function rustModule(filename) {
  const module = filename.replace(/^src\//, '').replace(/(?:^|\/)mod\.rs$/, '').replace(/\.rs$/, '').replaceAll('/', '::');
  return module ? `crate::${module}` : 'crate';
}

function importedTypes(file) {
  const imports = new Map(), module = rustModule(file.path);
  function qualify(value) {
    if (value.startsWith('crate::')) return value;
    if (value.startsWith('bevy::')) return value;
    const segments = module.split('::'), relative = value.split('::');
    if (relative[0] === 'self') relative.shift();
    while (relative[0] === 'super') { segments.pop(); relative.shift(); }
    return [...segments, ...relative].join('::');
  }
  function expand(value, prefix = '') {
    value = value.trim();
    const group = value.indexOf('{');
    if (group >= 0) {
      const stem = prefix + value.slice(0, group);
      for (const item of commaParts(value.slice(group + 1, value.lastIndexOf('}')))) expand(item, stem);
      return;
    }
    const [target, alias] = value.split(/\s+as\s+/);
    if (!target || target.endsWith('*')) return;
    const full = qualify(prefix + target);
    imports.set(alias?.trim() || target.split('::').at(-1), full);
  }
  for (const declaration of file.masked.matchAll(/\buse\s+([^;]+);/g)) expand(declaration[1]);
  return imports;
}

function reflectedProjectAccesses(registry, catalog, database) {
  const inspector = registry.inspector_pass, dependency = inspector?.definition_source?.dependency;
  if (!inspector || !dependency) return [];
  const registrations = new Map();
  for (const file of database.files.values()) {
    const imports = importedTypes(file);
    for (const match of file.masked.matchAll(/\.register_type\s*::\s*</g)) {
      const open = match.index + match[0].lastIndexOf('<'), end = closing(file.masked, open, '<', '>');
      if (end < 0) continue;
      const name = file.masked.slice(open + 1, end).trim(), imported = imports.get(nominal(name));
      const candidates = catalog.types.filter(type => !type.definition_source?.dependency
        && (name.startsWith('crate::') ? type.rustType === name : type.rustType === imported
          || nominal(type.name) === nominal(name) && type.definition_source?.path === file.path));
      if (candidates.length !== 1) continue;
      const type = candidates[0], declaration = database.files.get(type.definition_source?.path);
      if (!declaration) continue;
      const offset = declaration.text.split('\n').slice(0, type.definition_source.line - 1).join('\n').length;
      const prefix = declaration.masked.slice(0, offset), start = Math.max(prefix.lastIndexOf(';'), prefix.lastIndexOf('}')) + 1;
      const attributes = prefix.slice(start);
      if (!/\bderive\s*\([^)]*\bReflect\b/.test(attributes) || !/\breflect\s*\([^)]*\bComponent\b/.test(attributes)) continue;
      if (!registrations.has(type.id)) registrations.set(type.id, { sources: [], unitMarker: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+[A-Za-z_]\w*\s*;/.test(declaration.masked.slice(offset)) });
      registrations.get(type.id).sources.push({ role: 'configure', label: `注册 ${name} 的 ReflectComponent`, path: file.path, line: file.lineAt(match.index), column: 1 });
    }
  }
  const result = [];
  for (const [id, { sources, unitMarker }] of registrations) {
    const type = catalog.typeById[id];
    if (type.projectionIds.includes('parcel.HeldTarget')) continue;
    for (const operation of unitMarker ? ['reflect_read'] : ['reflect_read', 'reflect_write']) {
      const line = operation === 'reflect_read' ? 674 : 707;
      result.push({ system: inspector.id, component: type.componentNodeId, projectionIds: [...type.projectionIds], operation, evidence: 'reviewed', readOnlyMarker: unitMarker,
        label: labels[operation], notes: [
          '项目显式 register_type 与该真实类型定义的 #[reflect(Component)] 共同确认反射访问入口。',
          operation === 'reflect_read' ? '检查器通过独占 World 动态显示现存组件；仅在对应界面绘制时访问。' : '仅用户编辑现存字段时写入并标记 changed，不表示每轮自动修改，也不添加或移除组件。',
          ...(unitMarker ? ['此类型为无字段标记组件，没有可供反射编辑的字段。'] : []),
        ], sourceEntries: distinct([...sources,
          { role: 'configure', label: '项目检查器启用与运行条件', path: 'src/inspector/mod.rs', line: 16, column: 1 },
          { role: 'related', label: '独占 World 的检查器入口', path: 'src/quick.rs', line: 92, column: 1, dependency },
          { role: 'call', label: '调用通用 World 检查器', path: 'src/quick.rs', line: 106, column: 1, dependency },
          { role: 'operation', label: operation === 'reflect_read' ? '取得组件反射访问' : '用户可选反射编辑', path: 'src/bevy_inspector/mod.rs', line, column: 1, dependency },
          ...(operation === 'reflect_write' ? [{ role: 'operation', label: '反射改动后标记 changed', path: 'src/bevy_inspector/mod.rs', line: 716, column: 1, dependency }] : []),
        ]),
      });
    }
  }
  return result;
}

function scanAccesses(model, registry, catalog, database) {
  const facts = [], byNominal = Map.groupBy(catalog.types, type => nominal(type.name));
  const importsByPath = new Map([...database.files.values()].map(file => [file.path, importedTypes(file)]));
  const projectionSet = new Set(Object.keys(catalog.typeByProjectionId));
  for (const original of model.systems || []) {
    const system = registry[original.id], rootFunction = database.forSystem(system);
    if (!system || !functionKinds.has(nodeKindOf(system)) || !rootFunction) continue;
    const references = unique([...(system.reads || []), ...(system.writes || [])]).filter(id => projectionSet.has(id));
    function resolve(typeName, operation, fn) {
      let candidates = byNominal.get(nominal(typeName)) || [];
      if (nominal(typeName) === 'Pickable' && importsByPath.get(fn.path)?.get('Pickable') === 'bevy::picking::Pickable') {
        candidates = candidates.filter(type => type.definition_source?.dependency?.name === 'bevy_picking');
      }
      if (typeName.includes('<')) {
        const short = value => value.replace(/\b(?:[A-Za-z_]\w*::)+/g, '').replace(/\s+/g, '');
        const instantiated = candidates.filter(type => short(type.name) === short(typeName));
        if (instantiated.length) candidates = instantiated;
      }
      const declared = operation === 'insert' || operation === 'remove' ? system.writes || [] : references;
      const touched = candidates.filter(type => type.projectionIds.some(id => declared.includes(id)));
      const types = touched.length ? touched : candidates;
      return types.length === 1 ? types[0] : null;
    }
    function add(typeName, operation, fn, offset, calls, accessMode, snippet) {
      const type = resolve(typeName, operation, fn);
      if (!type) return;
      const declarations = ['insert', 'remove', 'write'].includes(operation) ? system.writes || [] : references;
      const targeted = type.projectionIds.filter(id => declarations.includes(id));
      facts.push({ system: system.id, component: targeted[0] || type.componentNodeId, projectionIds: targeted,
        targetScope: targeted.length ? 'declared-candidates' : 'type-only',
        operation, evidence: 'source', accessMode,
        sourceEntries: distinct([
          ...calls.map(call => ({ role: 'call', label: `调用 ${call.name}`, path: call.path, line: call.line, column: 1 })),
          { role: operation === 'filter' || accessMode === 'query' ? 'parameter' : 'operation', label: snippet, path: fn.path, line: fn.lineAt(offset), column: 1 },
        ]),
        notes: calls.length ? ['普通项目辅助函数中的操作归属于调用它的 System；Commands 中的结构变更在命令应用时生效。'] : [],
      });
    }
    function visit(fn, calls = [], visited = new Set(), insertionContext = false) {
      const key = `${fn.path}:${fn.line}`;
      if (visited.has(key) || calls.length > 4) return;
      const nextVisited = new Set([...visited, key]);
      const signature = fn.signature;
      for (const match of signature.matchAll(/(?:&\s*(mut\s+)?|\b(Read|Write|With|Without|Has|Added|Changed)\s*<\s*)([A-Za-z_]\w*(?:::\w+)*)/g)) {
        const marker = match[2], operation = /^(With|Without|Has|Added|Changed)$/.test(marker) ? 'filter' : match[1] || marker === 'Write' ? 'write' : 'read';
        add(match[3], operation, fn, fn.parameterStart + match.index, calls, 'query', match[0]);
      }
      // QueryData 的 Read<T>/Write<T> 不是独立系统，访问归属于注入它的 Query。
      const queryData = [], inputs = queryInputs(signature);
      for (const input of inputs) {
        if (!/^[A-Za-z_]\w*$/.test(input.data)) continue;
        const type = input.data, declaration = new RegExp(`\\bstruct\\s+${type}\\s*\\{`).exec(fn.masked);
        if (!declaration) continue;
        const start = fn.masked.indexOf('{', declaration.index), end = closing(fn.masked, start, '{', '}');
        for (const field of fn.masked.slice(start, end).matchAll(/\b(Read|Write|Has)\s*<\s*([A-Za-z_]\w*)/g)) add(field[2], field[1] === 'Write' ? 'write' : field[1] === 'Has' ? 'filter' : 'read', fn, start + field.index, calls, 'query', `QueryData ${type}: ${field[0]}`);
        queryData.push({ receiver: input.receiver, fields: [...fn.masked.slice(start, end).matchAll(/\b([a-z_]\w*)\s*:\s*(?:Option\s*<\s*)?Write\s*<\s*([A-Za-z_]\w*)/g)].map(field => [field[1], field[2]]) });
      }
      const body = fn.body, origin = fn.bodyStart + 1, insertionCalls = new Set(), mutableBindings = new Map(), valueTypes = new Map();
      for (const parameter of commaParts(signature.slice(1, -1))) {
        const binding = /\b([a-z_]\w*)\s*:\s*([A-Z][A-Za-z_0-9]*)/.exec(parameter);
        if (binding) valueTypes.set(binding[1], binding[2]);
      }
      for (const binding of body.matchAll(/\blet\s+(?:mut\s+)?([a-z_]\w*)\s*=\s*([A-Z][A-Za-z_0-9]*)\s*(?=::|\{|\()/g)) valueTypes.set(binding[1], binding[2]);
      function expression(start, end) {
        while (/\s/.test(fn.masked[start] || '') && start < end) start++;
        while (/\s/.test(fn.masked[end - 1] || '') && end > start) end--;
        if (start >= end) return;
        const text = fn.masked.slice(start, end);
        if (text[0] === '(' && closing(fn.masked, start, '(', ')') === end - 1) {
          let offset = start + 1;
          for (const part of commaParts(text.slice(1, -1))) {
            const index = fn.masked.indexOf(part, offset); expression(index, index + part.length); offset = index + part.length;
          }
          return;
        }
        const head = /^([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/.exec(text);
        if (!head) return;
        const path = head[1], name = path.split('::').find(part => /^[A-Z]/.test(part)) || path, rest = text.slice(path.length).trimStart();
        if (/^[A-Z]/.test(name)) add(name, 'insert', fn, start, calls, 'constructor', name);
        else if (/^[a-z_]\w*(?:\.[a-z_]\w*)*\.map_or\s*\(/.test(text)) {
          const open = start + text.indexOf('(', text.indexOf('.map_or')), close = closing(fn.masked, open, '(', ')');
          const first = commaParts(fn.masked.slice(open + 1, close))[0];
          if (first) { const offset = fn.masked.indexOf(first, open + 1); expression(offset, offset + first.length); }
        }
        else if (rest.startsWith('(')) {
          const open = start + text.indexOf('('), close = closing(fn.masked, open, '(', ')');
          if (name === 'template_value') expression(open + 1, close);
          else insertionCalls.add(start);
        } else if (!rest && valueTypes.has(name)) add(valueTypes.get(name), 'insert', fn, start, calls, 'value', `插入 ${name}: ${valueTypes.get(name)}`);
        else if (name === 'bsn' && rest.startsWith('!')) {
          const open = fn.masked.indexOf('{', start); if (open < end) scene(open + 1, closing(fn.masked, open, '{', '}'));
        } else if (name === 'actions' && rest.startsWith('!')) {
          const open = fn.masked.indexOf('[', start), close = closing(fn.masked, open, '[', ']');
          if (open >= start && close < end) {
            let offset = open + 1;
            for (const part of commaParts(fn.masked.slice(open + 1, close))) {
              const index = fn.masked.indexOf(part, offset); expression(index, index + part.length); offset = index + part.length;
            }
          }
        } else if (name === 'bindings' && rest.startsWith('!')) {
          const open = fn.masked.indexOf('[', start), close = closing(fn.masked, open, '[', ']');
          if (open >= start && close < end) expression(open + 1, close);
        }
      }
      // BSN 只在实体层识别组件；组件字段及构造参数里的同名值不是另一次挂载。
      function scene(start, end) {
        let index = start;
        while (index < end) {
          if (/\s|,/.test(fn.masked[index])) { index++; continue; }
          if (fn.masked[index] === '(') {
            const close = closing(fn.masked, index, '(', ')'); scene(index + 1, close); index = close + 1; continue;
          }
          const head = /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/.exec(fn.masked.slice(index, end));
          if (!head) { index++; continue; }
          const name = head[0].split('::').find(part => /^[A-Z]/.test(part)) || head[0], from = index; index += head[0].length;
          while (index < end && /\s/.test(fn.masked[index])) index++;
          if (name === 'Children' && fn.masked[index] === '[') {
            add(name, 'insert', fn, from, calls, 'bsn', 'BSN Children');
            const close = closing(fn.masked, index, '[', ']'); scene(index + 1, close); index = close + 1; continue;
          }
          if (name === 'template_value' && fn.masked[index] === '(') {
            const close = closing(fn.masked, index, '(', ')'); expression(index + 1, close); index = close + 1; continue;
          }
          if (/^[A-Z]/.test(name)) add(name, 'insert', fn, from, calls, 'bsn', `BSN ${name}`);
          else if (fn.masked[index] === '(') insertionCalls.add(from);
          else if (valueTypes.has(name)) add(valueTypes.get(name), 'insert', fn, from, calls, 'value', `BSN ${name}: ${valueTypes.get(name)}`);
          // Associated constructors/constants belong to the root type. Skip their argument values.
          while (fn.masked.startsWith('::', index) || fn.masked[index] === '.') {
            index += fn.masked[index] === '.' ? 1 : 2;
            const part = /^[A-Za-z_]\w*/.exec(fn.masked.slice(index)); if (part) index += part[0].length;
          }
          if ('({['.includes(fn.masked[index] || '\0')) {
            const open = fn.masked[index], close = closing(fn.masked, index, open, { '(': ')', '{': '}', '[': ']' }[open]);
            index = close + 1;
          }
        }
      }
      for (const query of inputs) {
        const data = query.data, receiver = query.receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fields = data?.startsWith('(') ? commaParts(data.slice(1, -1)) : [data];
        const loops = new RegExp(`\\bfor\\s+(\\([^;{}]*?\\)|(?:mut\\s+)?[a-z_]\\w*)\\s+in\\s+&(?:mut\\s+)?${receiver}(?![\\w.])`, 'g');
        const bindingsFor = binding => {
          const bindings = binding.startsWith('(') ? commaParts(binding.slice(1, -1)) : [binding];
          for (const [index, binding] of bindings.entries()) {
            const component = /&\s*mut\s+([A-Za-z_]\w*(?:::\w+)*)/.exec(fields[index] || '')?.[1];
            const variable = /(?:mut\s+)?([a-z_]\w*)$/.exec(binding)?.[1];
            if (component && variable) mutableBindings.set(variable, component);
          }
        };
        for (const loop of body.matchAll(loops)) bindingsFor(loop[1]);
        const destructures = new RegExp(`\\blet\\s+(?:Ok|Some)\\s*\\(\\s*(\\([^;{}]*?\\)|(?:mut\\s+)?[a-z_]\\w*)\\s*\\)\\s*=\\s*${receiver}\\.(?:get_mut|single_mut)\\s*\\(`, 'g');
        for (const binding of body.matchAll(destructures)) bindingsFor(binding[1]);
      }
      for (const query of queryData) {
        const receiver = query.receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const loop of body.matchAll(new RegExp(`\\bfor\\s+mut\\s+([a-z_]\\w*)\\s+in\\s+&mut\\s+${receiver}(?![\\w.])`, 'g'))) {
          for (const [field, type] of query.fields) mutableBindings.set(`${loop[1]}.${field}`, type);
        }
      }
      for (const binding of body.matchAll(/\blet\s+Some\s*\(\s*mut\s+([a-z_]\w*)\s*\)\s*=\s*([a-z_]\w*\.[a-z_]\w*)/g)) {
        const component = mutableBindings.get(binding[2]);
        if (component) mutableBindings.set(binding[1], component);
      }
      for (const assignment of body.matchAll(/(?:\*\s*)?\b([a-z_]\w*)((?:\.[A-Za-z_0-9]+)*)\s*(?:[+*/-]?=)(?!=|>)/g)) {
        if (!assignment[2] && !assignment[0].trimStart().startsWith('*')) continue;
        const field = assignment[2].split('.')[1];
        const component = mutableBindings.get(`${assignment[1]}.${field}`) || mutableBindings.get(assignment[1]);
        if (component) add(component, 'write', fn, origin + assignment.index, calls, 'field-write', assignment[0].trim());
      }
      for (const match of body.matchAll(/\.(remove|try_remove|get|get_mut)\s*::\s*</g)) {
        const open = origin + match.index + match[0].lastIndexOf('<'), end = closing(fn.masked, open, '<', '>');
        if (end < 0) continue;
        const tail = fn.masked.slice(end + 1, end + 70);
        const existence = match[1] === 'get' && /^\s*\([^)]*\)\s*\.\s*is_(?:some|none)/.test(tail);
        const operation = /^(?:try_)?remove$/.test(match[1]) ? 'remove' : match[1] === 'get_mut' ? 'write' : existence ? 'filter' : 'read';
        for (const name of outerTypes(fn.masked.slice(open + 1, end))) add(name, operation, fn, origin + match.index, calls, existence ? 'existence-check' : 'world', match[0] + name + '>');
      }
      for (const match of body.matchAll(/\.(insert|spawn|spawn_scene)\s*\(/g)) {
        const start = origin + match.index + match[0].lastIndexOf('('), end = closing(fn.masked, start, '(', ')');
        if (end < 0) continue;
        expression(start + 1, end);
      }
      // BSN 中的裸标记组件同样明确表达挂载；非组件标识符不会进入类型目录。
      for (const match of body.matchAll(/\bbsn\s*!\s*\{/g)) {
        const start = origin + match.index + match[0].lastIndexOf('{'), end = closing(fn.masked, start, '{', '}');
        scene(start + 1, end);
      }
      if (insertionContext) {
        let depth = 0, start = origin;
        for (let index = origin; index < fn.bodyEnd; index++) {
          if ('([{'.includes(fn.masked[index])) depth++;
          if (')]}'.includes(fn.masked[index])) depth--;
          if (fn.masked[index] === ';' && depth === 0) start = index + 1;
        }
        expression(start, fn.bodyEnd);
      }
      for (const match of body.matchAll(/(?<![\w.])([a-z_][A-Za-z_0-9]*)\s*\(/g)) {
        const helper = database.helper(fn, match[1]);
        if (!helper || helper.start === fn.start && helper.path === fn.path) continue;
        const offset = origin + match.index;
        visit(helper, [...calls, { name: helper.name, path: fn.path, line: fn.lineAt(offset) }], nextVisited,
          insertionCalls.has(offset));
      }
    }
    visit(rootFunction);
  }
  return facts;
}

// 原生 UI 函数来自锁定依赖；参数过滤和结构操作分别取真实函数内的证据。
function reviewedUiNativeAccesses(registry, readDependencySource) {
  const result = [];
  const facts = {
    native_update_hovered: ['bevy_picking', [
      ['Hovered', 'read', '&Hovered'], ['Hovered', 'insert', '.insert(Hovered(is_hovering))'],
    ]],
    native_button_down: ['bevy_ui_widgets', [
      ['Button', 'filter', 'With<Button>'], ['Pressed', 'filter', 'Has<Pressed>'], ['Pressed', 'insert', '.insert(Pressed)'],
    ]],
    native_button_up: ['bevy_ui_widgets', [
      ['Button', 'filter', 'With<Button>'], ['Pressed', 'filter', 'Has<Pressed>'], ['Pressed', 'remove', '.remove::<Pressed>()'],
    ]],
    native_button_drag_end: ['bevy_ui_widgets', [
      ['Button', 'filter', 'With<Button>'], ['Pressed', 'filter', 'Has<Pressed>'], ['Pressed', 'remove', '.remove::<Pressed>()'],
    ]],
    native_button_cancel: ['bevy_ui_widgets', [
      ['Button', 'filter', 'With<Button>'], ['Pressed', 'filter', 'Has<Pressed>'], ['Pressed', 'remove', '.remove::<Pressed>()'],
    ]],
    native_button_click: ['bevy_ui_widgets', [
      ['Button', 'filter', 'With<Button>'], ['Pressed', 'filter', 'Has<Pressed>'],
    ]],
    native_button_key: ['bevy_ui_widgets', [['Button', 'filter', 'With<Button>']]],
  };
  for (const [system, [packageName, accesses]] of Object.entries(facts)) {
    const record = registry[system], definition = record?.definition_source || record?.source;
    if (!definition?.dependency) continue;
    if (definition.dependency.name !== packageName) throw new Error(`原生 UI 来源不匹配：${system}`);
    const text = readDependencySource(definition);
    if (typeof text !== 'string') continue;
    const masked = maskRustSource(text), start = text.split('\n').slice(0, definition.line - 1).join('\n').length;
    const bodyStart = masked.indexOf('{', start), end = closing(masked, bodyStart, '{', '}');
    if (bodyStart < 0 || end < 0) throw new Error(`原生 UI 函数范围无效：${system}`);
    for (const [type, operation, snippet] of accesses) {
      const offset = masked.indexOf(snippet, start);
      if (offset < start || offset > end) throw new Error(`原生 UI 操作证据失效：${system} ${snippet}`);
      const projections = type === 'Hovered' ? ['menu_button.Hovered', 'settings_scrollbar_thumb.Hovered'] : [`menu_button.${type}`];
      for (const component of projections.filter(id => registry[id]?.kind === 'Component')) result.push({
        system, component, operation, evidence: 'reviewed', accessMode: ['read', 'filter'].includes(operation) ? 'query' : 'native-structure',
        label: operation === 'filter' ? snippet : labels[operation], notes: ['原生依赖的真实参数或结构操作；With / Has 不代表读取组件字段。'],
        sourceEntries: [{ ...definition, line: text.slice(0, offset).split('\n').length, column: 1,
          role: ['read', 'filter'].includes(operation) ? 'parameter' : 'operation', label: snippet }],
      });
    }
  }
  return result;
}

// 项目排队唤醒命令；实际结构操作发生于 Avian 整岛命令及其生命周期 Observer。
function reviewedPhysicsWakeAccesses(registry, readSource, readDependencySource) {
  const system = registry.wake_changed_bodies;
  const dependency = registry['character.Sleeping']?.definition_source?.dependency;
  if (!system?.source || dependency?.name !== 'avian3d') return [];
  const commandPath = 'src/dynamics/solver/islands/sleeping.rs';
  const solverPath = 'src/dynamics/solver/solver_body/plugin.rs';
  const project = readSource(system.source.path);
  const command = readDependencySource({ path: commandPath, dependency });
  const solver = readDependencySource({ path: solverPath, dependency });
  if (![project, command, solver].every(text => typeof text === 'string')) return [];
  function evidence(text, path, snippet, role, label, external = false, scope) {
    const masked = maskRustSource(text), anchor = scope ? masked.indexOf(scope) : 0;
    const end = scope && anchor >= 0 ? closing(masked, masked.indexOf('{', anchor), '{', '}') : masked.length;
    const offset = anchor < 0 ? -1 : masked.indexOf(snippet, anchor), next = masked.indexOf(snippet, offset + 1);
    if (offset < 0 || offset > end || next >= 0 && next < end) throw new Error(`物理唤醒操作证据失效：${path} ${snippet}`);
    return { path, line: text.slice(0, offset).split('\n').length, column: 1, role, label, ...(external ? { dependency } : {}) };
  }
  const queued = evidence(project, system.source.path, 'commands.queue(WakeBody(entity))', 'operation', '项目排队：WakeBody(entity)');
  const island = evidence(command, commandPath, 'WakeIslands(vec![body_island.island_id]).apply(world)', 'implementation', '命令执行：唤醒身体所属物理岛', true);
  const effects = [
    ['Sleeping', 'remove', [evidence(command, commandPath, 'world.entity_mut(entity).remove::<Sleeping>()', 'operation', '整岛身体：移除 Sleeping', true, 'impl Command for WakeIslands')]],
    ['SleepTimer', 'write', [evidence(command, commandPath, 'sleep_timer.0 = 0.0', 'operation', '整岛身体：重置休眠计时', true, 'impl Command for WakeIslands')]],
    ['SolverBodyIndex', 'insert', [
      evidence(solver, solverPath, 'trigger: On<Remove<Sleeping>>', 'registration', '引擎注册：移除 Sleeping 后恢复求解身体', true),
      evidence(solver, solverPath, 'commands.entity(entity).try_insert(index)', 'operation', '生命周期 helper：插入 SolverBodyIndex', true),
    ]],
  ];
  return effects.flatMap(([type, operation, sourceEntries]) => ['character', 'parcel'].flatMap(owner => {
    const component = `${owner}.${type}`;
    return registry[component]?.kind === 'Component' ? [{ system: system.id, component, operation, evidence: 'reviewed', accessMode: 'queued-island-command',
      label: `唤醒命令：${labels[operation]}`, sourceEntries: [queued, island, ...sourceEntries],
      notes: ['项目函数只检查 Ref<T> 的变更元数据；命令应用时作用于整个休眠物理岛。', 'SolverBodyIndex 的恢复由引擎 Remove<Sleeping> Observer 调用 helper 完成；helper 不是另一个项目 System。'],
    }] : [];
  }));
}

function reviewedBodySizeAccesses(registry, readDependencySource) {
  const definition = registry['character.BodySizeMetrics']?.definition_source;
  if (!registry.physics_step || definition?.dependency?.name !== 'avian3d') return [];
  const path = 'src/dynamics/rigid_body/body_size_metrics.rs', text = readDependencySource({ ...definition, path });
  if (typeof text !== 'string') return [];
  const masked = maskRustSource(text), start = masked.indexOf('fn update_body_size_metrics<');
  const end = closing(masked, masked.indexOf('{', start), '{', '}');
  const updates = [...masked.matchAll(/\*size_metrics = compute\(rb_colliders, com\)/g)].map(match => match.index);
  const registration = masked.indexOf('.before(PhysicsStepSystems::Solver)');
  if (start < 0 || registration < 0 || updates.length !== 2 || updates.some(offset => offset < start || offset > end)) throw new Error('BodySizeMetrics 更新证据失效');
  const sourceEntries = [registration, ...updates].map((offset, index) => ({ ...definition, path, line: text.slice(0, offset).split('\n').length, column: 1,
    role: index === 0 ? 'registration' : 'operation', label: index === 0 ? '引擎注册：在 Solver 前更新刚体尺寸' : '碰撞体或质心变化后重算 BodySizeMetrics' }));
  return ['character.BodySizeMetrics', 'parcel.BodySizeMetrics'].filter(component => registry[component]?.kind === 'Component').map(component => ({
    system: 'physics_step', component, operation: 'write', evidence: 'reviewed', accessMode: 'field-write', label: '重算刚体尺寸', sourceEntries,
    notes: ['PhysicsSchedule 内部在 Solver 前执行 update_body_size_metrics；汇总身体的全部 Collider，仅在质心或碰撞体变化时更新。'],
  }));
}

/** Build after dependency definitions are attached. Original projection/registration IDs remain valid. */
export function buildComponentCatalog(model, registry, {
  mergeSystems = true,
  readSource = filename => fs.readFileSync(path.join(repository, filename), 'utf8'),
  readDependencySource = source => fs.readFileSync(path.join(source.dependency.root, source.path), 'utf8'),
} = {}) {
  const typeById = {}, typeByProjectionId = {}, types = [], byIdentity = new Map();
  for (const entity of model.entities || []) for (const component of entity.components || []) {
    const record = registry[component.id];
    if (!record || record.kind !== 'Component') throw new Error(`缺少真实组件投影：${component.id}`);
    const identity = typeIdentity(component, record);
    let type = byIdentity.get(identity.identity);
    if (!type) {
      type = { id: `component-type-${hash(identity.identity)}`, viewId: `component-${hash(identity.identity)}`, name: identity.type.replace(/crate::[A-Za-z_][\w:]*::/g, ''), rustType: identity.rustType,
        feature: record.feature, defined_in: record.defined_in, definition_source: identity.definition,
        componentNodeId: component.id, projectionIds: [], ownerEntityIds: [], identityVerified: identity.verified,
        sourceGaps: identity.verified ? [] : ['类型声明尚未核实，暂时保留独立投影，不按同名合并。'] };
      byIdentity.set(identity.identity, type); types.push(type); typeById[type.id] = type;
    }
    type.projectionIds.push(component.id);
    type.ownerEntityIds = unique([...type.ownerEntityIds, entity.canonical_entity || `entity-${entity.id}`]);
    typeByProjectionId[component.id] = type.id;
  }
  const catalog = { types, typeById, typeByProjectionId, ...mergedSystems(model, registry, mergeSystems) };
  for (const type of types) {
    const records = type.projectionIds.map(id => registry[id]);
    const descriptions = unique(records.map(record => record.description));
    type.details = {
      name: type.name,
      rust_type: type.rustType,
      qualified_type: type.rustType,
      description: descriptions.map(description => {
        if (descriptions.length === 1) return description;
        const owners = unique(records.filter(record => record.description === description).map(record => record.owner));
        return owners.length ? `${owners.join('、')}：${description}` : description;
      }).join('\n'),
      fields: distinct(records.flatMap(record => record.fields || [])),
      notes: unique(records.flatMap(record => record.notes || [])),
      sourceGaps: [...type.sourceGaps],
      ...((records.find(record => record.display_summary)?.display_summary || records[0].description)
        ? { display_summary: records.find(record => record.display_summary)?.display_summary || records[0].description } : {}),
    };
  }
  for (const type of types) for (const id of type.projectionIds) Object.assign(registry[id], {
    componentTypeId: type.id, componentNodeId: type.componentNodeId, projectionIds: [...type.projectionIds], ownerEntityIds: [...type.ownerEntityIds], componentRustType: type.rustType,
  });
  catalog.declarations = (model.systems || []).flatMap(system => ['reads', 'writes'].flatMap(key => (system[key] || []).filter(component => typeByProjectionId[component]).map(component => ({ system: system.id, component, operation: key === 'reads' ? 'read' : 'write' }))));
  catalog.deferredAccesses = catalog.declarations.filter(access => registry[access.system] && nodeKindOf(registry[access.system]) === 'Synchronization');
  const declared = [];
  for (const system of model.systems || []) if (catalog.functionIdBySystemId[system.id]) for (const [key, operation] of [['reads', 'read'], ['writes', 'write']]) for (const component of system[key] || []) if (typeByProjectionId[component]) declared.push({
    system: system.id, component, operation, evidence: 'declaration', notes: [], sourceEntries: system.source ? [{ ...system.source, role: 'related', label: '系统访问声明对应函数' }] : [],
  });
  const database = sourceDatabase(model, registry, readSource);
  const reviewed = [...reviewedHeldTargetAccesses(registry), ...reflectedProjectAccesses(registry, catalog, database), ...reviewedUiNativeAccesses(registry, readDependencySource), ...reviewedPhysicsWakeAccesses(registry, readSource, readDependencySource), ...reviewedBodySizeAccesses(registry, readDependencySource)];
  const inspectorReadOnly = new Set(reviewed.filter(access => access.system === 'inspector_pass' && access.readOnlyMarker)
    .flatMap(access => typeById[typeByProjectionId[access.component]]?.projectionIds || []));
  catalog.disprovedDeclarations = catalog.declarations.filter(access => access.system === 'inspector_pass' && access.operation === 'write' && inspectorReadOnly.has(access.component))
    .map(access => ({ ...access, reason: '已核实为无字段标记组件，反射界面没有可编辑字段；原声明保留供核对，不派生写入关系。' }));
  if (registry.inspector_pass) {
    const reflectedIds = operation => reviewed.filter(access => access.system === 'inspector_pass' && access.operation === operation)
      .flatMap(access => typeById[typeByProjectionId[access.component]]?.projectionIds || []);
    registry.inspector_pass.reads = unique([...(registry.inspector_pass.reads || []), ...reflectedIds('reflect_read')]);
    registry.inspector_pass.writes = unique([...(registry.inspector_pass.writes || []), ...reflectedIds('reflect_write')]).filter(id => !inspectorReadOnly.has(id));
    registry.inspector_pass.notes = unique([...(registry.inspector_pass.notes || []), '已核实的项目反射组件同时列入访问清单；检查器按当前 World 与类型注册表动态访问，清单并不穷尽所有引擎或第三方组件。']);
    Object.assign(catalog.systemByFunctionId.inspector_pass, { reads: registry.inspector_pass.reads, writes: registry.inspector_pass.writes, notes: registry.inspector_pass.notes });
  }
  const explicit = (model.component_accesses || []).map(access => ({ ...access, evidence: 'reviewed' }));
  const scanned = scanAccesses(model, registry, catalog, database);
  const relationFacts = (model.system_links || []).flatMap(link => {
    if (!['read', 'write'].includes(link.kind)) return [];
    const component = link.kind === 'read' ? link.from : link.to, system = link.kind === 'read' ? link.to : link.from;
    if (!typeByProjectionId[component] || !catalog.functionIdBySystemId[system]) return [];
    return [{ system, component, operation: link.kind, evidence: 'declaration', originalLinkIds: [link.id],
      notes: link.label ? [link.label] : [], sourceEntries: link.source ? [{ ...link.source, role: 'related', label: '原有关系源码' }] : [] }];
  });
  const all = [...reviewed, ...explicit, ...scanned, ...declared, ...relationFacts].filter(access => {
    if (!operations.has(access.operation) || !typeByProjectionId[access.component] || !catalog.functionIdBySystemId[access.system]) throw new Error(`无效组件访问事实：${JSON.stringify(access)}`);
    if (access.system === 'inspector_pass' && access.operation === 'write' && access.evidence === 'declaration' && inspectorReadOnly.has(access.component)) return false;
    return access.component !== 'parcel.HeldTarget' || access.evidence === 'reviewed';
  });
  catalog.accesses = all;
  catalog.graphFor = typeId => {
    const type = typeById[typeId] || typeById[typeByProjectionId[typeId]];
    if (!type) throw new Error(`未知组件类型：${typeId}`);
    const relevant = all.filter(access => typeByProjectionId[access.component] === type.id);
    const byActor = Map.groupBy(relevant, access => catalog.functionIdBySystemId[access.system]);
    const links = type.ownerEntityIds.map(owner => ({ id: `component-owner-${hash(type.id + owner)}`, from: type.componentNodeId, to: owner, kind: 'reference', operation: 'contains', label: type.name === 'HeldTarget' ? '持握期间挂载于' : labels.contains,
      projectionIds: type.projectionIds.filter(id => (model.entities || []).some(entity => (entity.canonical_entity || `entity-${entity.id}`) === owner && entity.components.some(component => component.id === id))), notes: ['表示该实体类别可能包含此组件，不表示每个实体始终拥有该组件。'], sourceEntries: [] }));
    for (const [actor, accesses] of byActor) {
      const precise = accesses.filter(access => access.evidence !== 'declaration');
      const selected = accesses.filter(access => access.evidence !== 'declaration'
        || !(precise.some(other => other.system === access.system && (access.operation === 'write' ? ['write', 'insert', 'remove', 'reflect_write'].includes(other.operation) : ['read', 'filter', 'reflect_read'].includes(other.operation)))));
      const grouped = Map.groupBy(selected, access => access.operation === 'filter' && access.accessMode === 'existence-check' && selected.some(other => other.operation === 'remove' && other.system === access.system) ? 'remove' : access.operation);
      for (const [operation, facts] of grouped) {
        const reverse = ['read', 'filter', 'reflect_read'].includes(operation), unclassified = facts.every(fact => fact.evidence === 'declaration');
        const sourceGaps = unique(facts.flatMap(fact => fact.sourceGaps || []));
        if (operation === 'write' && unclassified) sourceGaps.push('当前仅确认写访问声明，尚未细分字段修改、添加或移除；需结合函数与相关辅助调用核实。');
        else if (operation === 'write' && facts.every(fact => fact.evidence !== 'reviewed' && fact.accessMode !== 'field-write')) sourceGaps.push('已确认可变访问参数，尚未定位到组件字段赋值语句；可变借用本身不保证发生修改。');
        const originalLinkIds = unique(relevant.filter(access => catalog.functionIdBySystemId[access.system] === actor && (reverse ? ['read', 'filter', 'reflect_read'].includes(access.operation) : ['write', 'insert', 'remove', 'reflect_write'].includes(access.operation))).flatMap(access => access.originalLinkIds || []));
        const factLabels = unique(facts.map(fact => fact.label));
        links.push({ id: `component-access-${hash(type.id + actor + operation)}`, from: reverse ? type.componentNodeId : actor, to: reverse ? actor : type.componentNodeId,
          kind: operation === 'filter' ? 'reference' : reverse ? 'read' : 'write', operation,
          label: factLabels.length ? factLabels.join('；') : operation === 'write' && unclassified ? '写入 / 结构变更（待核实）'
            : operation === 'write' && facts.some(fact => fact.accessMode === 'field-write') ? '字段赋值' : labels[operation],
          projectionIds: unique(facts.flatMap(fact => fact.projectionIds || [fact.component])), registrationIds: unique(facts.map(fact => fact.system)),
          evidence: unique(facts.map(fact => fact.evidence)), notes: unique(facts.flatMap(fact => fact.notes || [])), sourceGaps,
          originalLinkIds, sourceLinkIds: originalLinkIds,
          sourceEntries: distinct(facts.flatMap(fact => fact.sourceEntries || [])),
          accesses: facts.map(fact => ({ ...fact })),
        });
      }
    }
    return { feature: type.feature, aspect: 'component', componentTypeId: type.id, componentNodeId: type.componentNodeId,
      projectionIds: [...type.projectionIds], ownerEntityIds: [...type.ownerEntityIds],
      nodes: [
        ...type.ownerEntityIds.map(id => ({ id, role: registry[id]?.feature === type.feature ? 'internal' : 'external', group: '包含此组件的 Entity' })),
        { id: type.componentNodeId, role: 'internal', group: 'Component' },
        ...[...byActor.keys()].map(id => ({ id, role: registry[id]?.feature === type.feature ? 'internal' : 'external', group: registry[id] && nodeKindOf(registry[id]) === 'Observer' ? '相关 Observer' : '相关 System / 引擎契约' })),
      ], links, sections: [], empty: false };
  };
  return catalog;
}
