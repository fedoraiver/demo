import { readArchitectureData } from './architecture-artifacts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './maintenance-inputs.mjs';

const pick = (record, fields) => Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
const sorted = entries => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

// 摘要不按名称合并身份，也不为删除、拆分或泛型变化自动建立别名。
export function summarizeModel({ model, registry, objects, links, views = [] }) {
  const list = Array.isArray(objects) ? objects : objects?.objects;
  const ids = list ? new Set(list.map(item => item.id)) : null;
  const records = Object.entries(registry || {}).filter(([id, record]) => ids ? ids.has(id) : !record.alias_of);
  const relationships = new Map();
  for (const link of [...(model?.system_links || []), ...(links || objects?.links || []), ...views.flatMap(view => view.links || [])]) {
    if (link.id) relationships.set(link.id, pick(link, ['from', 'to', 'kind', 'operation', 'source', 'sourceEntries', 'projection', 'projectionIds', 'originalLinkIds']));
  }
  return { objects: sorted(records.map(([id, record]) => [id, pick(record, ['kind', 'name', 'componentRustType', 'componentTypeId',
    'rust_type', 'type_arguments', 'canonicalEntityId', 'entityId', 'projectionIds', 'ownerEntityIds', 'source', 'sourceEntries', 'registrations', 'scheduleEvidence'])])),
    relationships: sorted([...relationships]) };
}

export function readModelSummary(workspace) {
  try {
    const data = readArchitectureData(workspace);
    const summary = summarizeModel(data);
    const sourcePage = path.join(workspace, 'docs/diagrams/generated/pages/ecs-source.html');
    if (fs.existsSync(sourcePage)) {
      const text = fs.readFileSync(sourcePage, 'utf8');
      const match = text.match(/<script\b[^>]*\bid=["']sources["'][^>]*>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('Missing source snapshot JSON');
      const files = JSON.parse(match[1]);
      if (!Array.isArray(files) || files.some(file => typeof file.path !== 'string' || typeof file.text !== 'string')) throw new Error('Invalid source snapshot JSON');
      summary.sourceFiles = sorted(files.map(file => [file.path, digest(file.text)]));
    }
    return { available: true, sha256: digest(summary), summary };
  } catch (error) { return { available: false, reason: error.message }; }
}

export function compareModelSummaries(before, after) {
  if (!before || !after) return { available: false, reason: 'A verified baseline or final model is unavailable' };
  const compare = (old, next) => {
    const previous = Object.keys(old).sort(), current = Object.keys(next).sort();
    const preserved = current.filter(id => Object.hasOwn(old, id));
    return { added: current.filter(id => !Object.hasOwn(old, id)), retired: previous.filter(id => !Object.hasOwn(next, id)), preserved,
      changed: preserved.filter(id => digest(old[id]) !== digest(next[id])).map(id => ({ id, before: old[id], after: next[id] })) };
  };
  const objects = compare(before.objects, after.objects), relationships = compare(before.relationships, after.relationships);
  const sourceFiles = before.sourceFiles && after.sourceFiles ? { available: true, ...compare(before.sourceFiles, after.sourceFiles) }
    : { available: false, added: [], retired: [], preserved: [], changed: [] };
  const changedFiles = new Set([...sourceFiles.added, ...sourceFiles.retired, ...sourceFiles.changed.map(change => change.id)]);
  const fileKey = source => source.dependency ? `cargo/${source.dependency.name}-${source.dependency.version}/${source.path}` : source.path;
  const changedSourceObjects = Object.keys(after.objects).filter(id => [...(before.objects[id]?.sourceEntries || []), ...(after.objects[id].sourceEntries || [])].some(source => changedFiles.has(fileKey(source))));
  const changesFor = fields => objects.changed.filter(change => fields.some(field => digest(change.before[field] ?? null) !== digest(change.after[field] ?? null))).map(change => change.id);
  return { available: true, objects, relationships,
    registrations: changesFor(['registrations', 'scheduleEvidence']), generics: changesFor(['componentRustType', 'componentTypeId', 'rust_type', 'type_arguments']),
    projections: changesFor(['canonicalEntityId', 'entityId', 'projectionIds', 'ownerEntityIds']),
    sources: [...new Set([...changesFor(['source', 'sourceEntries']), ...changedSourceObjects])].sort(), sourceFiles, aliasesCreated: [] };
}
