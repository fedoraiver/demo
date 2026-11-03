import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathsForRepository } from '../../../../docs/diagrams/src/paths.mjs';

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fields = ['path', 'sha256', 'viewId', 'objectId', 'engine', 'kind'];
const key = item => JSON.stringify(fields.map(field => item[field]));
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const git = (workspace, ...args) => execFileSync('git', ['-c', `safe.directory=${workspace.replaceAll('\\', '/')}`, ...args], { cwd: workspace, maxBuffer: 128 * 1024 * 1024 });
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
export function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export async function locked(filename, action) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const lock = filename + '.lock', deadline = Date.now() + 30000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw new Error('Visual writer is busy: ' + filename); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  try { return await action(); } finally { fs.rmdirSync(lock); }
}
export function contained(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw new Error('Unsafe artifact path: ' + relative);
  const target = path.resolve(root, relative), realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(target);
  if (!real.startsWith(realRoot + path.sep)) throw new Error('Artifact path escapes root: ' + relative);
  return target;
}
function readReference(root, ref) {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('Invalid artifact reference');
  const bytes = fs.readFileSync(contained(root, ref.path));
  if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw new Error('Artifact hash/size mismatch: ' + ref.path);
  return bytes;
}
export function currentArtifacts(workspace, { gitObjectFormat } = {}) {
  workspace = path.resolve(workspace);
  const generatedRoot = pathsForRepository(workspace).generatedDirectory;
  const manifestPath = contained(generatedRoot, 'data/manifest.json'), manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.views) || !manifest.guides) throw new Error('Unsupported artifact manifest');
  if (gitObjectFormat && !['sha1', 'sha256'].includes(gitObjectFormat)) throw new Error('Unsupported Git object format');
  const gitBlobs = {};
  const blob = bytes => crypto.createHash(gitObjectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (gitObjectFormat) gitBlobs['data/manifest.json'] = blob(manifestBytes);
  const references = new Map();
  function verify(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string') {
      const bytes = readReference(generatedRoot, value);
      if (gitObjectFormat) gitBlobs[value.path] = blob(bytes);
      const previous = references.get(value.path);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('Conflicting artifact reference');
      references.set(value.path, value); return;
    }
    for (const child of Object.values(value)) verify(child);
  }
  verify(manifest);
  const runtime = JSON.parse(readReference(generatedRoot, manifest.runtime)), entries = [];
  const ids = new Set();
  for (const view of manifest.views) {
    const data = JSON.parse(readReference(generatedRoot, view.data));
    if (!nonblank(view.id) || ids.has(view.id) || data.id !== view.id || !['graphviz', 'mermaid'].includes(data.engine)) throw new Error('Invalid view identity: ' + view.id);
    ids.add(view.id);
    const kind = data.engine === 'graphviz' ? 'Schedule' : runtime.registry?.[data.centerNodeId ?? data.objectId]?.kind;
    if (!nonblank(kind)) throw new Error('Missing semantic kind: ' + view.id);
    entries.push({ ...view.svg, viewId: view.id, objectId: data.objectId ?? null, engine: data.engine, kind, label: data.label ?? view.id, application: data.application ?? null, scheduleLabel: data.scheduleLabel ?? null, stratum: data.engine + '/' + kind });
  }
  function guides(value, trail = []) {
    if (!value || typeof value !== 'object') throw new Error('Invalid guide reference');
    if (value.path) {
      if (!value.path.endsWith('.svg')) throw new Error('Non-SVG guide');
      entries.push({ ...value, viewId: ['legend', ...trail].join('/'), objectId: null, engine: 'legend', kind: 'Legend', label: trail.join('/'), stratum: 'legend' });
    } else for (const [name, child] of Object.entries(value)) guides(child, [...trail, name]);
  }
  guides(manifest.guides);
  if (entries.some(item => !item.path?.endsWith('.svg')) || new Set(entries.map(item => item.path)).size !== entries.length) throw new Error('Missing or duplicate SVG path');
  if (hash(fs.readFileSync(manifestPath)) !== hash(manifestBytes)) throw new Error('Manifest changed during verification');
  return { workspace, generatedRoot, manifestSha256: hash(manifestBytes), buildId: manifest.buildId, inputs: [...references.values()].sort((a, b) => a.path.localeCompare(b.path)), entries: entries.sort((a, b) => a.path.localeCompare(b.path)), ...(gitObjectFormat ? { gitBlobs } : {}) };
}
export function resolveIndex(workspace, indexPath) {
  if (indexPath) {
    const target = path.resolve(workspace, indexPath);
    if (path.basename(target) === 'index.json') throw new Error('Legacy index.json is not supported; use a new schemaVersion 2 index');
    return target;
  }
  const common = git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim();
  const worktrees = git(workspace, 'worktree', 'list', '--porcelain').toString();
  const main = /^worktree (.+)$/m.exec(worktrees)?.[1];
  if (!main || !fs.existsSync(common)) throw new Error('Cannot resolve main checkout');
  return path.join(main, 'tmp/ecs-architecture/visual-checks/index-v2.json');
}
function readIndex(filename) {
  if (!fs.existsSync(filename)) return { schemaVersion: 2, observations: [], bindings: [] };
  const value = json(filename);
  if (value.schemaVersion !== 2 || !Array.isArray(value.observations) || !Array.isArray(value.bindings)) throw new Error('Unsupported visual index; schemaVersion 2 required');
  return value;
}
export function imageValid(image) {
  try {
    const bytes = fs.readFileSync(image.path);
    return path.isAbsolute(image.path) && /^[a-f0-9]{64}$/.test(image.sha256) && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && hash(bytes) === image.sha256;
  } catch { return false; }
}
function actualObservation(item) {
  return ['passed', 'failed'].includes(item.status) && item.actualInspection === true && item.reviewer?.role === 'child' && nonblank(item.reviewer.id) && nonblank(item.reviewer.model) && nonblank(item.reviewer.reasoningEffort)
    && nonblank(item.notes) && nonblank(item.observedWith) && typeof item.checkedAt === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(item.checkedAt) && Number.isFinite(Date.parse(item.checkedAt))
    && Array.isArray(item.images) && item.images.length > 0 && item.images.every(imageValid);
}
function validObservation(item) {
  try {
    if (!actualObservation(item)) return false;
    const { id, ...fact } = item;
    if (id !== hash(canonical(fact)) || hash(fs.readFileSync(item.planPath)) !== item.planSha256) return false;
    const render = json(path.join(path.dirname(item.planPath), 'render-records.json'));
    const row = render.records.find(row => key(row) === key(item));
    return render.schemaVersion === 2 && render.planSha256 === item.planSha256 && !!row && hash(canonical(row)) === item.renderProofSha256 && canonical(item.images) === canonical(row.images);
  } catch { return false; }
}
function latestObservations(index) {
  const latest = new Map();
  for (const item of index.observations) latest.set(key(item), item);
  for (const [identity, item] of latest) if (!validObservation(item)) latest.delete(identity);
  return latest;
}
function choose(candidates, { sample, seed, forcedObjectIds = [], forcedViewIds = [] }) {
  const rank = item => hash(seed + '\0' + item.stratum + '\0' + item.path);
  const mandatory = candidates.filter(item => forcedObjectIds.includes(item.objectId) || forcedViewIds.includes(item.viewId));
  const groups = new Map();
  for (const entry of [...candidates].sort((a, b) => rank(a).localeCompare(rank(b)))) {
    if (!groups.has(entry.stratum)) groups.set(entry.stratum, []);
    groups.get(entry.stratum).push(entry);
  }
  const selected = new Map(mandatory.map(item => [item.path, item]));
  const strata = [...groups.keys()].sort();
  for (const stratum of strata) if (![...selected.values()].some(item => item.stratum === stratum)) {
    const item = groups.get(stratum)[0]; selected.set(item.path, item);
  }
  const target = Math.min(sample ?? candidates.length, candidates.length);
  if (selected.size > target) throw new Error('Sample limit cannot cover all strata plus mandatory views');
  while (selected.size < target) {
    const count = stratum => [...selected.values()].filter(item => item.stratum === stratum).length;
    const available = strata.filter(stratum => groups.get(stratum).some(item => !selected.has(item.path)));
    available.sort((a, b) => (count(a) + 1) / Math.sqrt(groups.get(a).length) - (count(b) + 1) / Math.sqrt(groups.get(b).length) || a.localeCompare(b));
    const item = groups.get(available[0]).find(item => !selected.has(item.path)); selected.set(item.path, item);
  }
  const forced = new Set(mandatory.map(item => item.path));
  return [...selected.values()].sort((a, b) => Number(forced.has(b.path)) - Number(forced.has(a.path)) || a.stratum.localeCompare(b.stratum) || rank(a).localeCompare(rank(b))).map((item, i) => ({ ...item, sampleIndex: i + 1, mandatory: forced.has(item.path), status: 'pending' }));
}
export async function planVisual(options) {
  const { workspace, sample, seed, scope, batch, forcedObjectIds = [], forcedViewIds = [] } = options;
  if (sample !== undefined && (!Number.isSafeInteger(sample) || sample < 1 || !nonblank(seed) || !nonblank(scope))) throw new Error('Explicit sampling requires positive sample, seed and scope');
  if (sample === undefined && scope !== undefined) throw new Error('Scope requires explicit sampling');
  const current = currentArtifacts(workspace), indexPath = resolveIndex(current.workspace, options.indexPath);
  for (const [requested, field] of [[forcedObjectIds, 'objectId'], [forcedViewIds, 'viewId']]) {
    if (!Array.isArray(requested) || requested.some(id => !nonblank(id) || !current.entries.some(item => item[field] === id))) throw new Error('Unknown forced ' + field);
  }
  const index = await locked(indexPath, () => readIndex(indexPath)), latest = latestObservations(index);
  const reusable = current.entries.filter(item => latest.get(key(item))?.status === 'passed').map(item => ({ ...item, observationId: latest.get(key(item)).id }));
  const reusePaths = new Set(reusable.map(item => item.path)), candidates = current.entries.filter(item => !reusePaths.has(item.path));
  const items = choose(candidates, { sample, seed: seed ?? 'all', forcedObjectIds, forcedViewIds });
  const batchId = batch ?? crypto.randomUUID();
  if (!/^[\w-]+$/.test(batchId)) throw new Error('Unsafe visual batch name');
  const outdir = path.resolve(current.workspace, options.outdir ?? path.join(path.dirname(indexPath), 'batches', batchId));
  const planPath = path.join(outdir, 'plan.json');
  const plan = { schemaVersion: 2, ...current, indexPath, batch: batchId, mode: sample === undefined ? 'all' : 'sample', seed: seed ?? null, scope: scope ?? 'all current manifest SVGs', requestedCount: sample ?? null, selectionPolicy: { forcedObjectIds, forcedViewIds }, algorithm: 'mandatory + one per stratum + sqrt-population weighted deterministic hash rank', totalSvgCount: current.entries.length, candidateCount: candidates.length, reusableCount: reusable.length, sampleCount: items.length, requiresRendering: items.length > 0, reusable, items, frozenAt: new Date().toISOString() };
  await locked(planPath, () => {
    if (fs.existsSync(planPath)) throw new Error('Visual batch already exists; use a new output directory');
    atomicJson(planPath, plan);
    atomicJson(path.join(outdir, 'pending.json'), { schemaVersion: 2, planPath, records: items.map(item => ({ ...item, images: [] })) });
  });
  return { ...plan, planPath };
}
export function loadPlan(planPath) {
  planPath = path.resolve(planPath);
  const plan = json(planPath);
  if (plan.schemaVersion !== 2 || !Array.isArray(plan.items) || !Array.isArray(plan.entries)) throw new Error('Unsupported visual plan');
  const current = currentArtifacts(plan.workspace);
  if (current.manifestSha256 !== plan.manifestSha256 || JSON.stringify(current.inputs) !== JSON.stringify(plan.inputs) || JSON.stringify(current.entries) !== JSON.stringify(plan.entries)) throw new Error('Frozen manifest or inputs changed');
  const expected = choose(plan.entries.filter(item => !plan.reusable.some(reuse => key(reuse) === key(item))), { sample: plan.requestedCount ?? undefined, seed: plan.seed ?? 'all', ...plan.selectionPolicy });
  if (JSON.stringify(expected) !== JSON.stringify(plan.items)) throw new Error('Frozen plan selection changed');
  return { planPath, plan, planSha256: hash(fs.readFileSync(planPath)) };
}
export async function recordVisual({ planPath, observation, observationFile, indexPath }) {
  const loaded = loadPlan(planPath), { plan, planSha256 } = loaded;
  if (!!observation === !!observationFile) throw new Error('Supply exactly one observation or observationFile');
  const input = observationFile ? json(path.resolve(observationFile)) : observation;
  const observations = input.observations ?? [input];
  if (!Array.isArray(observations) || !observations.length) throw new Error('Empty observations');
  const rendered = json(path.join(path.dirname(loaded.planPath), 'render-records.json'));
  if (rendered.schemaVersion !== 2 || rendered.planSha256 !== planSha256) throw new Error('Render proof does not match plan');
  const records = observations.map(item => {
    const expected = plan.items.find(row => row.path === item.path), render = rendered.records.find(row => row.path === item.path);
    if (!expected || !render || key(expected) !== key(render) || !actualObservation(item)) throw new Error('Invalid actual child observation: ' + item.path);
    for (const field of fields) if (item[field] !== undefined && item[field] !== expected[field]) throw new Error('Observation identity mismatch: ' + field);
    if (JSON.stringify([...item.images].sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify([...render.images].sort((a, b) => a.path.localeCompare(b.path))) || !render.images.every(imageValid)) throw new Error('Observation image evidence differs from rendered SVG');
    const record = { ...expected, ...item, workspace: plan.workspace, manifestSha256: plan.manifestSha256, buildId: plan.buildId, planPath: loaded.planPath, planSha256, renderProofSha256: hash(canonical(render)) };
    delete record.sampleIndex; delete record.mandatory;
    delete record.id;
    record.id = hash(canonical(record));
    return record;
  });
  const target = resolveIndex(plan.workspace, indexPath ?? plan.indexPath);
  return locked(target, () => {
    loadPlan(loaded.planPath);
    const index = readIndex(target), added = [];
    for (const record of records) if (!index.observations.some(existing => existing.id === record.id)) { index.observations.push(record); added.push(record.id); }
    if (added.length) atomicJson(target, index);
    return { indexPath: target, added: added.length, recordIds: records.map(item => item.id) };
  });
}
export async function bindVisual({ workspace, indexPath, commit }) {
  workspace = path.resolve(workspace);
  if (!nonblank(commit) || commit.startsWith('-') || /[\s:]/.test(commit)) throw new Error('Invalid commit');
  const target = resolveIndex(workspace, indexPath);
  const resolved = git(workspace, 'rev-parse', '--verify', commit + '^{commit}').toString().trim();
  const gitObjectFormat = git(workspace, 'rev-parse', '--show-object-format').toString().trim();
  const current = currentArtifacts(workspace, { gitObjectFormat });
  // 一次读取 Git 树核对全部引用，避免逐文件创建进程；Git blob 身份绑定实际文件字节。
  const prefix = 'docs/diagrams/generated/';
  const committed = new Map(git(workspace, 'ls-tree', '-r', '-z', resolved, '--', prefix).toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, type, oid] = line.slice(0, tab).split(' ');
    return [line.slice(tab + 1), ['100644', '100755'].includes(mode) && type === 'blob' ? oid : null];
  }));
  for (const [relative, oid] of Object.entries(current.gitBlobs)) if (committed.get(prefix + relative) !== oid) throw new Error('Committed artifacts differ from current manifest or reference: ' + relative);
  return locked(target, () => {
    const index = readIndex(target), latest = latestObservations(index);
    const matching = current.entries.map(entry => latest.get(key(entry))).filter(Boolean);
    if (!matching.length) throw new Error('No valid observations match current committed SVG identities');
    const records = matching.filter(item => !index.bindings.some(binding => binding.commit === resolved && binding.recordIds.includes(item.id)));
    if (records.length) { index.bindings.push({ id: crypto.randomUUID(), commit: resolved, boundAt: new Date().toISOString(), manifestSha256: current.manifestSha256, recordIds: records.map(item => item.id) }); atomicJson(target, index); }
    return { indexPath: target, commit: resolved, boundRecords: records.length };
  });
}
export async function visualReport({ workspace, indexPath, planPath }) {
  const plan = planPath ? loadPlan(planPath).plan : null;
  const current = currentArtifacts(workspace ?? plan.workspace), target = resolveIndex(current.workspace, indexPath ?? plan?.indexPath);
  const latest = latestObservations(readIndex(target));
  const reusedIds = new Set(plan?.reusable.map(item => item.observationId) ?? []), selected = new Set(plan?.items.map(key) ?? []);
  const rows = current.entries.map(item => {
    const record = latest.get(key(item));
    return { ...item, status: record?.status ?? (plan && !selected.has(key(item)) ? 'uncovered' : 'pending'), provenance: record?.status === 'passed' ? (!plan || reusedIds.has(record.id) ? 'reused' : 'new') : null, observationId: record?.id ?? null };
  });
  const count = status => rows.filter(item => item.status === status).length;
  return { schemaVersion: 2, workspace: current.workspace, indexPath: target, mode: plan?.mode ?? 'all', scope: plan?.scope ?? 'all current manifest SVGs', totalSvgCount: rows.length, reusedPassed: rows.filter(item => item.status === 'passed' && item.provenance === 'reused').length, newPassed: rows.filter(item => item.status === 'passed' && item.provenance === 'new').length, failed: count('failed'), pending: count('pending'), uncovered: count('uncovered'), complete: rows.every(item => item.status === 'passed'), records: rows };
}

export { renderVisual } from './maintenance-visual-render.mjs';
