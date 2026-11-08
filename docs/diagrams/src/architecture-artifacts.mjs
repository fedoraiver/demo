import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathsForRepository, artifactRelativePath } from './paths.mjs';
import { viewerModel, compilerCallGraphFile } from './rustc-model.mjs';
import { hashFile } from './stream-files.mjs';
import { projectInfrastructureFeatures } from './architecture-infrastructure.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value);
const urlFor = reference => '../' + reference.path;
export const descriptorFields = ['id', 'aspect', 'engine', 'label', 'feature', 'objectId', 'centerNodeId', 'application', 'scheduleLabel', 'systemCount', 'width', 'height', 'filename', 'legendKinds', 'buildId', 'sourceCommit', 'target'];

export function validateViewArtifactReferences(metadata, entry) {
  const filenames = { svg: 'filename', mermaid: 'mermaidFilename', dot: 'dotFilename' };
  const kinds = Object.keys(filenames);
  if (kinds.some(kind => Object.hasOwn(metadata, kind) && metadata[kind] !== null)) throw new Error('Embedded graph text remains in view data: ' + metadata.id);
  const empty = (metadata.engine === undefined || metadata.engine === 'mermaid') && metadata.svg === null && !metadata.nodes?.length && !metadata.links?.length
    && kinds.every(kind => metadata[filenames[kind]] == null);
  const required = empty ? [] : metadata.engine === 'mermaid' ? ['svg', 'mermaid'] : metadata.engine === 'graphviz' ? ['svg', 'dot'] : null;
  if (!required) throw new Error('Unknown architecture view engine: ' + metadata.id);
  for (const kind of kinds) {
    if (required.includes(kind)) {
      if (typeof metadata[filenames[kind]] !== 'string' || !metadata[filenames[kind]] || !entry[kind]) throw new Error(`Missing architecture ${kind} artifact: ${metadata.id}`);
      if (entry[kind].path !== artifactRelativePath(metadata, kind)) throw new Error(`Architecture ${kind} artifact filename mismatch: ${metadata.id}`);
    } else if (metadata[filenames[kind]] != null || entry[kind] != null) throw new Error(`Unexpected architecture ${kind} artifact: ${metadata.id}`);
  }
}

export function stampArchitecturePage(html, provenance) {
  const meta = ['sourceCommit', 'target', 'buildId'].map(key => {
    const value = String(provenance[key]).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    return `<meta name="architecture-${key}" content="${value}">`;
  }).join('');
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, '$&' + meta) : meta + html;
}

export function obsoleteExternalReferences(previous, current) {
  const collect = (value, result = new Set()) => {
    if (!value || typeof value !== 'object') return result;
    if (typeof value.path === 'string' && !value.path.includes('\\') && /^(?:data\/views\/[^/]+\.json|data\/[^/]+\.calls\.ndjson|svg\/legend\/[^/]+\.svg)$/.test(value.path)
      && !value.path.split('/').some(part => part === '.' || part === '..')) result.add(value.path);
    for (const child of Object.values(value)) collect(child, result);
    return result;
  };
  const before = collect(previous), after = collect(current);
  return [...before].filter(filename => !after.has(filename));
}

/** 产物清单使用生成目录相对路径；浏览器 URL 相对 pages 中的入口。 */
export function writeExternalArchitecture({ paths, data, writeArtifact, copyArtifact, compilerModelDirectory, objectRelationRuntime,
  sourceCommit = 'unknown', target = 'unknown', sourcePage, licenses = [] }) {
  assert.deepEqual(data.infrastructureFeatures, projectInfrastructureFeatures(data.registry), 'Architecture infrastructure menu projection mismatch');
  const put = (filename, text) => {
    writeArtifact(filename, text);
    return { path: filename, sha256: sha256(text), bytes: Buffer.byteLength(text) };
  };
  const model = put('data/model.json', encoded(data.model));
  const relationRuntime = objectRelationRuntime === undefined ? null : put('runtime/object-relations.mjs', objectRelationRuntime);
  let callGraph;
  if (data.model.callGraph?.schemaVersion === 2) {
    if (!copyArtifact) throw new Error('Missing compiler call graph artifact copier');
    const source = compilerCallGraphFile(data.model, compilerModelDirectory), filename = 'data/' + data.model.callGraph.file;
    copyArtifact(filename, source, data.model.callGraph.sha256);
    const integrity = hashFile(path.join(paths.generatedDirectory, filename));
    if (integrity.sha256 !== data.model.callGraph.sha256) throw new Error('Distributed compiler call graph hash mismatch');
    callGraph = { path: filename, ...integrity };
  }
  const guide = (samples, prefix = '') => Object.fromEntries(Object.entries(samples).map(([key, value]) => [key,
    typeof value === 'string' ? put('svg/legend/' + (prefix + key).replaceAll('/', '-') + '.svg', value) : guide(value, prefix + key + '/') ]));
  const guides = guide(data.guideSamples, 'guide/');
  const guideUrls = samples => Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, value.path ? urlFor(value) : guideUrls(value)]));
  const preparedViews = data.views.map(view => {
    const { svg, mermaid, dot, ...metadata } = view;
    for (const kind of ['svg', 'mermaid', 'dot']) if (view[kind] === null) metadata[kind] = null;
    const entry = { id: view.id, metadata: sha256(encoded(metadata)) };
    if (view.renderFingerprint) entry.renderFingerprint = view.renderFingerprint;
    for (const [kind, value] of [['svg', svg], ['mermaid', mermaid], ['dot', dot]]) if (typeof value === 'string') {
      const filename = artifactRelativePath(view, kind);
      // SVG、DOT、Mermaid 已由生成器写入；这里仅声明原始字节，不复制进 JSON。
      entry[kind] = { path: filename, sha256: sha256(value), bytes: Buffer.byteLength(value) };
    }
    validateViewArtifactReferences(metadata, entry);
    return { view, metadata, entry };
  });
  const licenseEntries = licenses.map(license => put(license.path, license.content));
  // 构建身份来自未标记的输入；先确定身份，再给页面及元数据加标记，避免哈希循环。
  const buildId = sha256(encoded({ model, ...(callGraph ? { callGraph } : {}), ...(relationRuntime ? { objectRelationRuntime: relationRuntime } : {}),
    views: preparedViews.map(item => item.entry), guides, registry: sha256(encoded(data.registry)), sourceCommit, target,
    sourcePage: sourcePage === undefined ? null : sha256(sourcePage), licenses: licenseEntries }));
  const provenance = { buildId, sourceCommit, target };
  const entries = [], descriptors = [];
  for (const { view, metadata, entry: seed } of preparedViews) {
    const entry = { ...seed };
    delete entry.metadata;
    entry.data = put(`data/views/${view.id}.json`, encoded({ ...metadata, ...provenance }));
    entries.push(entry);
    const record = { ...view, ...provenance };
    const descriptor = Object.fromEntries(descriptorFields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
    if (view.aspect === 'object') descriptor.relationCount = view.links.length;
    if (view.schedulePluginGroups) descriptor.schedulePluginGroups = view.schedulePluginGroups.map(({ id, systemCount }) => ({ id, systemCount }));
    descriptor.resources = Object.fromEntries(['data', 'svg', 'mermaid'].filter(kind => entry[kind]).map(kind => [kind, { url: urlFor(entry[kind]), sha256: entry[kind].sha256, bytes: entry[kind].bytes }]));
    descriptors.push(descriptor);
  }
  const runtime = put('data/runtime.json', encoded({ ...data, schemaVersion: 6, ...provenance,
    ...(relationRuntime ? { objectRelationRuntime: { url: urlFor(relationRuntime), sha256: relationRuntime.sha256, bytes: relationRuntime.bytes } } : {}),
    model: { features: data.model.features, entities: data.model.objects ? viewerModel(data.model).entities : data.model.entities }, views: descriptors, guideSamples: guideUrls(guides) }));
  const pages = sourcePage === undefined ? {} : { source: put('pages/ecs-source.html', stampArchitecturePage(sourcePage, provenance)) };
  const manifest = put('data/manifest.json', encoded({ schemaVersion: 2, ...provenance,
    ...(relationRuntime ? { objectRelationRuntime: relationRuntime } : {}), runtime, views: entries, guides, pages, licenses: licenseEntries }));
  put('data/audit-manifest.json', encoded({ schemaVersion: 1, ...provenance, manifest, model, ...(callGraph ? { callGraph } : {}) }));
  return { schemaVersion: 6, ...provenance, runtimeUrl: urlFor(runtime), runtimeSha256: runtime.sha256,
    manifestUrl: urlFor(manifest), manifestSha256: manifest.sha256 };
}

export function embeddedArchitectureBootstrap(html) {
  const match = html.match(/<script\b[^>]*\bid=["']architecture-data["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Missing embedded JSON: architecture-data');
  return JSON.parse(match[1]);
}

/** Node 校验器复原完整检查模型，浏览器无需下载构建模型或全部图形。 */
export function readArchitectureData(repository) {
  const paths = pathsForRepository(repository);
  const modern = fs.existsSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'));
  const page = modern ? path.join(paths.pagesDirectory, 'ecs-architecture.html') : path.join(paths.packageRoot, 'ecs-architecture.html');
  const bootstrap = embeddedArchitectureBootstrap(fs.readFileSync(page, 'utf8'));
  if (bootstrap.schemaVersion !== 6) return bootstrap;
  function resourceFile(reference) {
    if (!reference || typeof reference.path !== 'string' || reference.path.includes('\\') || reference.path.split('/').some(part => !part || part === '.' || part === '..')
      || path.isAbsolute(reference.path) || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Unsafe architecture resource reference');
    const filename = path.resolve(paths.generatedDirectory, reference.path);
    if (!filename.startsWith(paths.generatedDirectory + path.sep) || fs.lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe architecture resource path');
    return filename;
  }
  function read(reference) {
    const text = fs.readFileSync(resourceFile(reference), 'utf8');
    if (sha256(text) !== reference.sha256 || reference.bytes !== undefined && Buffer.byteLength(text) !== reference.bytes) throw new Error('Architecture resource hash mismatch: ' + reference.path);
    return text;
  }
  const referenceFromUrl = (url, hash) => {
    if (typeof url !== 'string' || !url.startsWith('../')) throw new Error('Unsafe architecture bootstrap URL');
    return { path: url.slice(3), sha256: hash };
  };
  const manifest = JSON.parse(read(referenceFromUrl(bootstrap.manifestUrl, bootstrap.manifestSha256)));
  if (manifest.schemaVersion !== 2 || manifest.buildId !== bootstrap.buildId) throw new Error('Architecture manifest version mismatch');
  const audit = JSON.parse(fs.readFileSync(path.join(paths.dataDirectory, 'audit-manifest.json'), 'utf8'));
  if (audit.schemaVersion !== 1) throw new Error('Architecture audit manifest version mismatch');
  for (const key of ['buildId', 'sourceCommit', 'target']) {
    if (typeof bootstrap[key] !== 'string' || !bootstrap[key] || manifest[key] !== bootstrap[key] || audit[key] !== bootstrap[key]) throw new Error('Architecture provenance mismatch: ' + key);
  }
  assert.deepEqual(audit.manifest, { path: 'data/manifest.json', sha256: bootstrap.manifestSha256,
    bytes: fs.statSync(path.join(paths.dataDirectory, 'manifest.json')).size }, 'Architecture audit manifest binding mismatch');
  if (Object.hasOwn(manifest, 'model') || Object.hasOwn(manifest, 'callGraph')) throw new Error('Audit resources remain in browser manifest');
  assert.deepEqual(referenceFromUrl(bootstrap.runtimeUrl, bootstrap.runtimeSha256), { path: manifest.runtime.path, sha256: manifest.runtime.sha256 });
  const runtime = JSON.parse(read(manifest.runtime)), model = JSON.parse(read(audit.model));
  for (const key of ['buildId', 'sourceCommit', 'target']) if (runtime[key] !== bootstrap[key]) throw new Error('Architecture runtime provenance mismatch: ' + key);
  if (manifest.objectRelationRuntime) {
    const reference = manifest.objectRelationRuntime;
    assert.deepEqual(runtime.objectRelationRuntime, { url: urlFor(reference), sha256: reference.sha256, bytes: reference.bytes }, 'Architecture object relation runtime mismatch');
    read(reference);
  } else if (runtime.objectRelationRuntime) throw new Error('Unexpected object relation runtime resource');
  assert.deepEqual(runtime.infrastructureFeatures, projectInfrastructureFeatures(runtime.registry), 'Architecture infrastructure menu projection mismatch');
  if (model.callGraph?.schemaVersion === 2) {
    const filename = compilerCallGraphFile(model, path.dirname(path.resolve(paths.generatedDirectory, audit.model.path)));
    assert.deepEqual({ path: audit.callGraph?.path, sha256: audit.callGraph?.sha256 },
      { path: 'data/' + model.callGraph.file, sha256: model.callGraph.sha256 }, 'Architecture call graph manifest mismatch');
    if (fs.realpathSync(resourceFile(audit.callGraph)) !== fs.realpathSync(filename)) throw new Error('Architecture call graph resource mismatch');
    const integrity = hashFile(filename);
    if (integrity.sha256 !== audit.callGraph.sha256 || integrity.bytes !== audit.callGraph.bytes) throw new Error('Architecture call graph hash mismatch');
  } else if (audit.callGraph) throw new Error('Unexpected architecture call graph resource');
  if (runtime.schemaVersion !== 6 || runtime.buildId !== manifest.buildId) throw new Error('Architecture runtime version mismatch');
  assert.deepEqual(runtime.model, { features: model.features, entities: model.objects ? viewerModel(model).entities : model.entities }, 'Architecture runtime model projection mismatch');
  const descriptors = new Map(runtime.views.map(view => [view.id, view]));
  if (descriptors.size !== runtime.views.length || descriptors.size !== manifest.views.length) throw new Error('Architecture view index mismatch');
  const views = manifest.views.map(entry => {
    const metadata = JSON.parse(read(entry.data)), descriptor = descriptors.get(entry.id);
    for (const key of ['buildId', 'sourceCommit', 'target']) if (metadata[key] !== bootstrap[key]) throw new Error('Architecture view provenance mismatch: ' + entry.id + '/' + key);
    if (entry.renderFingerprint !== undefined) assert.equal(metadata.renderFingerprint, entry.renderFingerprint, 'Architecture render input mismatch: ' + entry.id);
    if (metadata.id !== entry.id || !descriptor) throw new Error('Architecture view identity mismatch');
    validateViewArtifactReferences(metadata, entry);
    const expected = Object.fromEntries(descriptorFields.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
    if (metadata.aspect === 'object') expected.relationCount = metadata.links.length;
    if (metadata.schedulePluginGroups) expected.schedulePluginGroups = metadata.schedulePluginGroups.map(({ id, systemCount }) => ({ id, systemCount }));
    expected.resources = Object.fromEntries(['data', 'svg', 'mermaid'].filter(kind => entry[kind]).map(kind => [kind, { url: urlFor(entry[kind]), sha256: entry[kind].sha256, bytes: entry[kind].bytes }]));
    assert.deepEqual(descriptor, expected, 'Architecture descriptor mismatch: ' + entry.id);
    const { buildId, sourceCommit, target, ...view } = metadata;
    return { ...view, svg: entry.svg ? read(entry.svg) : null,
      ...(entry.mermaid ? { mermaid: read(entry.mermaid) } : {}), ...(entry.dot ? { dot: read(entry.dot) } : {}) };
  });
  function guides(references, urls) {
    assert.deepEqual(Object.keys(references).sort(), Object.keys(urls).sort(), 'Architecture guide index mismatch');
    return Object.fromEntries(Object.entries(references).map(([key, value]) => {
      if (!value.path) return [key, guides(value, urls[key])];
      if (urls[key] !== urlFor(value)) throw new Error('Architecture guide URL mismatch');
      return [key, read(value)];
    }));
  }
  const result = { ...runtime, schemaVersion: 5, model, views, guideSamples: guides(manifest.guides, runtime.guideSamples) };
  for (const reference of [...Object.values(manifest.pages), ...manifest.licenses]) read(reference);
  delete result.buildId;
  delete result.sourceCommit;
  delete result.target;
  delete result.objectRelationRuntime;
  return result;
}
