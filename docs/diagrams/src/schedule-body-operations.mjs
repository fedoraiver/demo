import fs from 'node:fs';
import path from 'node:path';
import { maskRustSource } from './architecture-components.mjs';
import { RENDER_SCHEDULE_BODY_OPERATIONS, RENDER_SCHEDULE_BODY_GAPS } from '../catalog/schedule-operation-reviewed-render.mjs';
import { EFFECTS_SCHEDULE_BODY_OPERATIONS, EFFECTS_SCHEDULE_BODY_GAPS } from '../catalog/schedule-operation-reviewed-effects.mjs';
import { PHYSICS_SCHEDULE_BODY_OPERATIONS, PHYSICS_SCHEDULE_BODY_GAPS } from '../catalog/schedule-operation-reviewed-physics.mjs';
import { CORE_SCHEDULE_BODY_OPERATIONS, CORE_SCHEDULE_BODY_GAPS } from '../catalog/schedule-operation-reviewed-core.mjs';
import { EGUI_SCHEDULE_BODY_OPERATIONS, EGUI_SCHEDULE_BODY_GAPS } from '../catalog/schedule-operation-reviewed-egui.mjs';

export const SCHEDULE_BODY_OPERATION_VERSION = 1;
const unique = values => [...new Set(values)];
const condition = (value, message) => { if (!value) throw new Error(message); };

export function mergeScheduleBodyReviews(...maps) {
  const result = new Map();
  for (const map of maps) for (const [key, entries] of Object.entries(map)) {
    condition(key.includes('::') && Array.isArray(entries), 'Invalid Schedule body review: ' + key);
    condition(!result.has(key), 'Duplicate Schedule body review: ' + key);
    result.set(key, entries);
  }
  return result;
}

const DEFAULT_OPERATIONS = mergeScheduleBodyReviews(RENDER_SCHEDULE_BODY_OPERATIONS, EFFECTS_SCHEDULE_BODY_OPERATIONS, PHYSICS_SCHEDULE_BODY_OPERATIONS, CORE_SCHEDULE_BODY_OPERATIONS,EGUI_SCHEDULE_BODY_OPERATIONS);
const DEFAULT_GAPS = mergeScheduleBodyReviews(RENDER_SCHEDULE_BODY_GAPS, EFFECTS_SCHEDULE_BODY_GAPS, PHYSICS_SCHEDULE_BODY_GAPS, CORE_SCHEDULE_BODY_GAPS,EGUI_SCHEDULE_BODY_GAPS);

function compact(text) {
  const characters = [], offsets = [];
  for (let index = 0; index < text.length; index++) if (!/\s/.test(text[index])) { characters.push(text[index]); offsets.push(index); }
  return { text: characters.join(''), offsets };
}

export function sourceFragmentMatches(text, fragment) {
  condition(typeof fragment === 'string' && fragment.trim(), 'Missing body evidence fragment');
  const source = compact(text), search = compact(fragment).text, result = [];
  let index = source.text.indexOf(search);
  while (index >= 0) {
    result.push({ start: source.offsets[index], end: source.offsets[index + search.length - 1] + 1 });
    index = source.text.indexOf(search, index + search.length);
  }
  return result;
}

function requiredMatches(text, fragment, all, label) {
  const result = sourceFragmentMatches(text, fragment);
  condition(result.length && (all || result.length === 1), 'Missing or ambiguous ' + label + ': ' + fragment + ' count=' + result.length);
  return result;
}

export function createScheduleBodyOperationCatalog({
  repository, metadata, resolveDeclaration, resolveType, sourceAt,
  operations = DEFAULT_OPERATIONS, gaps = DEFAULT_GAPS,
} = {}) {
  const reviewed = operations instanceof Map ? operations : mergeScheduleBodyReviews(operations);
  const reviewedGaps = gaps instanceof Map ? gaps : mergeScheduleBodyReviews(gaps);
  const proofFiles = new Map();

  function externalProof(proof) {
    condition(typeof proof?.path === 'string' && Number.isInteger(proof.line) && proof.line > 0, 'Invalid external body operation proof');
    let root = repository, dependency;
    if (proof.dependency) {
      const packages = metadata.packages.filter(pkg => pkg.name === proof.dependency.name && pkg.version === proof.dependency.version);
      condition(packages.length === 1, 'External body proof package is not locked: ' + proof.dependency.name);
      root = path.dirname(packages[0].manifest_path);
      dependency = { name: packages[0].name, version: packages[0].version, root: root.replaceAll('\\', '/') };
    }
    const filename = path.resolve(root, proof.path), relative = path.relative(root, filename);
    condition(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'External body proof escapes its source package');
    if (!proofFiles.has(filename)) { const text = fs.readFileSync(filename, 'utf8'); proofFiles.set(filename, { text, code: maskRustSource(text), path: proof.path, ...(dependency ? { dependency } : {}) }); }
    const file = proofFiles.get(filename), [match] = requiredMatches(file.text, proof.match, false, 'external body proof');
    condition(file.code.slice(match.start, match.end).trim(), 'External proof matches only a comment or literal');
    return sourceAt(file, match.start, 'operation', '关联类型或 Bundle 展开证据');
  }

  function resolve(declaration, fullName, context = {}) {
    const result = [], sourceGaps = [...(reviewedGaps.get(declaration.fullName) || [])];
    for (const raw of reviewed.get(declaration.fullName) || []) {
      const spec = { ...raw, operation: raw.operation === 'write' ? 'mutable_access' : raw.operation };
      condition(['Resource', 'Component', 'EntityEvent', 'QueryData', 'Messages<T>'].includes(spec.kind) && ['insert', 'remove', 'initialize', 'read', 'mutable_access', 'trigger', 'reference', 'publish'].includes(spec.operation), 'Invalid reviewed body operation: ' + declaration.fullName);
      condition(['commands', 'world', 'message_writer'].includes(spec.via) && /^[A-Za-z_]\w*$/.test(spec.method || '') && typeof spec.type === 'string', 'Invalid reviewed body operation method/type');
      condition(spec.scope === undefined || ['current', 'main'].includes(spec.scope), 'Invalid reviewed body World scope');
      condition(spec.kind !== 'EntityEvent' || spec.operation === 'trigger', 'EntityEvent body operation must be a trigger');
      condition(spec.kind !== 'QueryData' || spec.operation === 'reference', 'QueryData body operation must remain a reference');
      condition(spec.kind !== 'Messages<T>' || ['publish','read','mutable_access','initialize','insert','remove'].includes(spec.operation), 'Invalid message-buffer body operation');
      let target = declaration, callSources = [], typeFullName = fullName;
      const parentBody = declaration.file.text.slice(declaration.bodyStart + 1, declaration.end);
      if (spec.helper) {
        condition(typeof spec.helper === 'string' && spec.helper.includes('::') && spec.callMatch, 'Missing explicit helper identity/call proof');
        target = resolveDeclaration(spec.helper);
        condition(target?.kind === 'fn' && target.fullName === spec.helper, 'Missing exact body operation helper: ' + spec.helper);
        callSources = requiredMatches(parentBody, spec.callMatch, spec.allMatches === true, 'helper caller').map(match => {
          const offset = declaration.bodyStart + 1 + match.start;
          condition(declaration.file.code.slice(offset, declaration.bodyStart + 1 + match.end).includes(target.symbol), 'Helper call evidence does not identify the helper');
          return sourceAt(declaration.file, offset, 'operation', '函数体调用已核实的操作 helper：' + target.fullName);
        });
        typeFullName = target.fullName;
      }
      const body = target.file.text.slice(target.bodyStart + 1, target.end);
      if (spec.evidenceMatch) requiredMatches(target.file.text.slice(target.offset, target.end + 1), spec.evidenceMatch, false, 'body type evidence');
      const proofs = (spec.proofs || []).map(externalProof);
      const queued = spec.queueMatch ? requiredMatches(body,spec.queueMatch,false,'queued World operation').map(match=>sourceAt(target.file,target.bodyStart+1+match.start,'operation','延迟 World 闭包由 Commands 排队')) : [];
      if(spec.queueMatch)condition(/\bcommands\s*\.\s*queue\s*\(/.test(spec.queueMatch),'Queued operation requires explicit Commands.queue evidence');
      const operationSources = requiredMatches(body, spec.match, spec.allMatches === true, 'body operation').map(match => {
        const offset = target.bodyStart + 1 + match.start, end = target.bodyStart + 1 + match.end;
        const calls = [...target.file.code.slice(offset, end).matchAll(new RegExp('\\.\\s*' + spec.method + '\\s*(?=\\(|::)', 'g'))];
        condition(calls.length === 1, 'Reviewed fragment must identify one actual .' + spec.method + ' call: ' + target.fullName);
        return sourceAt(target.file, offset + calls[0].index, 'operation', '函数体' + ({commands:'延迟命令',world:'World',message_writer:'消息写入器'}[spec.via]) + '操作：' + spec.method);
      });
      const sources = [...callSources, ...operationSources, ...proofs,...queued];
      const resolved = resolveType(spec.type, typeFullName, { declaration: target, kind: spec.kind, scope: spec.scope || 'current', sourceEntries: sources });
      sourceGaps.push(...(resolved?.sourceGaps||[]));
      if (!resolved?.fullName&&!resolved?.types?.length) {
        sourceGaps.push(...(resolved?.sourceGaps || []), '已核实 ' + target.fullName + ' 的 .' + spec.method + '，但结果类型未能唯一定位：' + spec.type);
        continue;
      }
      for(const type of resolved.types||[resolved])result.push({ ...type, operation: spec.operation, via: spec.via, method: spec.method,
        deferred: spec.via === 'commands'||Boolean(spec.queueMatch), scope: spec.scope || 'current', ...(spec.condition ? { condition: spec.condition } : {}),
        sourceEntries: [...sources,...(type.operationProofEntries||[])], typeSourceEntries: type.sourceEntries, systemFullName: fullName,
        ...(spec.helper ? { helper: spec.helper } : {}) });
    }
    return { bodyOperations: result, sourceGaps: unique(sourceGaps) };
  }
  return { resolve, reviewed, reviewedGaps };
}
