import { REVIEWED_SCHEDULE_TYPE_PURPOSES } from '../catalog/schedule-type-reviewed.mjs';
import { EXTRA_SCHEDULE_TYPE_PURPOSES } from '../catalog/schedule-type-reviewed-extra.mjs';
import { PHYSICS_UI_SCHEDULE_TYPE_PURPOSES } from '../catalog/schedule-type-reviewed-physics-ui.mjs';
import { CORE_SCHEDULE_TYPE_PURPOSES } from '../catalog/schedule-type-reviewed-core.mjs';
import { LOCAL_SCHEDULE_TYPE_PURPOSES } from '../catalog/schedule-type-reviewed-local.mjs';

export const SCHEDULE_TYPE_PURPOSE_VERSION = 1;

export function mergeScheduleTypePurposes(...maps) {
  const result = new Map();
  for (const map of maps) for (const [key, value] of Object.entries(map)) {
    if (result.has(key)) throw new Error('Duplicate reviewed Schedule type purpose: ' + key);
    if (!value?.summary || !value.description) throw new Error('Incomplete reviewed Schedule type purpose: ' + key);
    result.set(key, value);
  }
  return result;
}

function baseType(type) {
  let result = '', depth = 0;
  for (const char of type) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
    else if (!depth) result += char;
  }
  return result.replaceAll('::::', '::');
}

function typeArguments(type) {
  const open = type.indexOf('<');
  if (open < 0) return [];
  let depth = 0, end = -1;
  for (let index = open; index < type.length; index++) {
    if (type[index] === '<') depth++;
    else if (type[index] === '>' && --depth === 0) { end = index; break; }
  }
  if (end < 0) return [];
  const text = type.slice(open + 1, end), result = []; let start = 0;
  depth = 0;
  for (let index = 0; index < text.length; index++) {
    if ('<([{'.includes(text[index])) depth++;
    else if ('>)]}'.includes(text[index])) depth--;
    else if (text[index] === ',' && !depth) { result.push(text.slice(start, index).trim()); start = index + 1; }
  }
  return [...result, text.slice(start).trim()].filter(value => value && !value.startsWith("'"));
}

function shortType(type) {
  const base = baseType(type), short = base.split('::').at(-1), args = typeArguments(type);
  return short + (args.length ? '<' + args.map(shortType).join(', ') + '>' : '');
}

function declarationFields(declaration) {
  if (!declaration?.file) return [];
  const docs = declaration.docs || [...(declaration.attributes || '').matchAll(/^\s*\/\/\/\s?(.*)$/gm)].map(match => match[1]).join('\n');
  const fields = [];
  if (docs) fields.push('源码文档：' + docs);
  if (declaration.bodyStart !== undefined && declaration.end !== undefined) {
    const body = declaration.file.text.slice(declaration.bodyStart + 1, declaration.end);
    if (body.trim()) fields.push('声明字段／枚举项：\n' + body.trim());
  } else if (declaration.kind === 'type') {
    const end = declaration.file.text.indexOf(';', declaration.offset);
    if (end >= 0) fields.push('类型别名声明：' + declaration.file.text.slice(declaration.offset, end + 1).trim());
  }
  return fields;
}

const DEFAULT_MAPS = [REVIEWED_SCHEDULE_TYPE_PURPOSES, EXTRA_SCHEDULE_TYPE_PURPOSES, PHYSICS_UI_SCHEDULE_TYPE_PURPOSES, CORE_SCHEDULE_TYPE_PURPOSES];

export function createScheduleTypePurposeResolver({ reviewedMaps = DEFAULT_MAPS, localPurposes = LOCAL_SCHEDULE_TYPE_PURPOSES, strict = true } = {}) {
  const reviewed = mergeScheduleTypePurposes(...reviewedMaps);
  const unresolved = new Set();
  const fail = (key, type, context) => {
    unresolved.add(key);
    if (strict) throw new Error('Schedule access purpose has not been reviewed: ' + key + ' / ' + context);
    return { summary: '用途待核实：' + shortType(type), description: '仅核实参数中出现 ' + type + '；该声明或参数的具体职责尚未审阅。', gap: true };
  };
  const lookup = type => reviewed.get(baseType(type)) || reviewed.get('unresolved:' + type);
  function interfacePurpose(type) {
    const read = /^(bevy::ecs::system::lifetimeless::)(Read|Write)</.exec(type);
    if (read) {
      const target = typeArguments(type)[0], targetPurpose = lookup(target), writing = read[2] === 'Write';
      if (!targetPurpose) return null;
      return { summary: (writing ? '静态可变查询接口：' : '静态只读查询接口：') + shortType(target),
        description: '这是 Bevy 无生命周期查询别名 ' + read[2] + '<' + target + '>，表示查询中的' + (writing ? '可变' : '只读') + '引用声明。所指类型的职责：' + targetPurpose.description + '该卡片保留查询接口身份，不能把参数声明当作实际数据修改。' };
    }
    const staticParam = reviewed.get('bevy_ecs::system::system_param::StaticSystemParam');
    if (/^bevy::ecs::system::StaticSystemParam</.test(type) && staticParam) return {
      ...staticParam, description: staticParam.description + '本入口使用 Bevy 再导出路径，内部参数为 ' + typeArguments(type).join('、') + '；未把尚未展开的接口推断为具体数据读写。',
    };
    if (type === 'bevy::ecs::system::SystemChangeTick') return reviewed.get('bevy_ecs::system::system_param::SystemChangeTick');
    return null;
  }
  function describe(access, { declaration, parameterDeclaration, declarationParameterKey, systemDeclaration, systemFullName } = {}) {
    const type = access.fullName, key = declaration?.fullName || 'unresolved:' + type;
    const fields = declarationFields(declaration), sourceGaps = [], generic = typeArguments(type);
    let purpose, purposeKey = key;
    if (access.kind === 'Local') {
      const slot = access.parameterKey || 'parameter', candidates = [
        parameterDeclaration?.fullName + '|' + (declarationParameterKey || slot),
        parameterDeclaration?.fullName + '|' + slot,
        systemDeclaration?.fullName + '|' + slot,
        systemFullName + '|' + slot,
      ];
      purposeKey = candidates.find(candidate => localPurposes[candidate]) || candidates[0];
      purpose = localPurposes[purposeKey] || fail(purposeKey, type, systemFullName);
      fields.push('独立 Local 参数槽：' + slot, '本地状态类型：' + type);
      if (parameterDeclaration?.complete) fields.push('参数所属声明：' + parameterDeclaration.complete);
    } else {
      purpose = reviewed.get(key) || interfacePurpose(type) || fail(key, type, systemFullName);
      if (generic.length) fields.push('本实例类型参数：' + generic.join('、'));
    }
    if (purpose.gap) sourceGaps.push('用途缺口：' + purpose.description);
    let description = purpose.description, summary = purpose.summary;
    if (generic.length && access.kind !== 'Local') description += ' 本实例类型参数为 ' + generic.join('、') + '。';
    if (baseType(type) === 'bevy_ecs::message::messages::Messages' && generic[0]) {
      const payload = shortType(generic[0]);
      summary = '保存 ' + payload + ' 消息。';
      description += ' 消息载荷为 ' + generic[0] + '。';
      if (baseType(generic[0]) === 'bevy_asset::event::AssetEvent') description += '该资产消息区分新增、修改、移除、未使用和依赖加载完成等事件，具体资产类型由载荷的类型参数决定。';
    }
    return { description, display_summary: summary, fields, sourceGaps, typePurposeKey: purposeKey };
  }
  return { describe, reviewed, unresolved };
}
