import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathsForRepository, artifactRelativePath } from './paths.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value);
const urlFor = reference => '../' + reference.path;
const descriptorFields = ['id', 'aspect', 'engine', 'label', 'feature', 'objectId', 'centerNodeId', 'application', 'scheduleLabel', 'systemCount', 'width', 'height', 'filename', 'legendKinds'];

export function obsoleteExternalReferences(previous, current) {
  const collect = (value, result = new Set()) => {
    if (!value || typeof value !== 'object') return result;
    if (typeof value.path === 'string' && !value.path.includes('\\') && /^(?:data\/views\/[^/]+\.json|svg\/legend\/[^/]+\.svg)$/.test(value.path)
      && !value.path.split('/').some(part => part === '.' || part === '..')) result.add(value.path);
    for (const child of Object.values(value)) collect(child, result);
    return result;
  };
  const before = collect(previous), after = collect(current);
  return [...before].filter(filename => !after.has(filename));
}

/** 产物清单使用生成目录相对路径；浏览器 URL 相对 pages 中的入口。 */
export function writeExternalArchitecture({ paths, data, writeArtifact }) {
  const put = (filename, text) => {
    writeArtifact(filename, text);
    return { path: filename, sha256: sha256(text), bytes: Buffer.byteLength(text) };
  };
  const model = put('data/model.json', encoded(data.model));
  const guide = (samples, prefix = '') => Object.fromEntries(Object.entries(samples).map(([key, value]) => [key,
    typeof value === 'string' ? put('svg/legend/' + (prefix + key).replaceAll('/', '-') + '.svg', value) : guide(value, prefix + key + '/') ]));
  const guides = guide(data.guideSamples, 'guide/');
  const guideUrls = samples => Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, value.path ? urlFor(value) : guideUrls(value)]));
  const entries = [], descriptors = [];
  for (const view of data.views) {
    const { svg, mermaid, dot, ...metadata } = view;
    for (const kind of ['svg', 'mermaid', 'dot']) if (view[kind] === null) metadata[kind] = null;
    const entry = { id: view.id, data: put(`data/views/${view.id}.json`, encoded(metadata)) };
    for (const [kind, value] of [['svg', svg], ['mermaid', mermaid], ['dot', dot]]) if (typeof value === 'string') {
      const filename = artifactRelativePath(view, kind);
      // SVG、DOT、Mermaid 已由生成器写入；这里仅声明原始字节，不复制进 JSON。
      entry[kind] = { path: filename, sha256: sha256(value), bytes: Buffer.byteLength(value) };
    }
    entries.push(entry);
    const descriptor = Object.fromEntries(descriptorFields.filter(key => view[key] !== undefined).map(key => [key, view[key]]));
    if (view.schedulePluginGroups) descriptor.schedulePluginGroups = view.schedulePluginGroups.map(({ id, systemCount }) => ({ id, systemCount }));
    descriptor.resources = Object.fromEntries(['data', 'svg'].filter(kind => entry[kind]).map(kind => [kind, { url: urlFor(entry[kind]), sha256: entry[kind].sha256, bytes: entry[kind].bytes }]));
    descriptors.push(descriptor);
  }
  const buildId = sha256(encoded({ model, entries, guides, registry: sha256(encoded(data.registry)) }));
  const runtime = put('data/runtime.json', encoded({ ...data, schemaVersion: 6, buildId,
    model: { features: data.model.features, entities: data.model.entities }, views: descriptors, guideSamples: guideUrls(guides) }));
  const manifest = put('data/manifest.json', encoded({ schemaVersion: 1, buildId, model, runtime, views: entries, guides }));
  return { schemaVersion: 6, buildId, runtimeUrl: urlFor(runtime), runtimeSha256: runtime.sha256,
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
  const modern = fs.existsSync(path.join(paths.catalogDirectory, 'ecs-data.json'));
  const page = modern ? path.join(paths.pagesDirectory, 'ecs-architecture.html') : path.join(paths.packageRoot, 'ecs-architecture.html');
  const bootstrap = embeddedArchitectureBootstrap(fs.readFileSync(page, 'utf8'));
  if (bootstrap.schemaVersion !== 6) return bootstrap;
  function read(reference) {
    if (!reference || typeof reference.path !== 'string' || reference.path.includes('\\') || reference.path.split('/').some(part => !part || part === '.' || part === '..')
      || path.isAbsolute(reference.path) || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Unsafe architecture resource reference');
    const filename = path.resolve(paths.generatedDirectory, reference.path);
    if (!filename.startsWith(paths.generatedDirectory + path.sep) || fs.lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe architecture resource path');
    const text = fs.readFileSync(filename, 'utf8');
    if (sha256(text) !== reference.sha256 || reference.bytes !== undefined && Buffer.byteLength(text) !== reference.bytes) throw new Error('Architecture resource hash mismatch: ' + reference.path);
    return text;
  }
  const referenceFromUrl = (url, hash) => {
    if (typeof url !== 'string' || !url.startsWith('../')) throw new Error('Unsafe architecture bootstrap URL');
    return { path: url.slice(3), sha256: hash };
  };
  const manifest = JSON.parse(read(referenceFromUrl(bootstrap.manifestUrl, bootstrap.manifestSha256)));
  if (manifest.schemaVersion !== 1 || manifest.buildId !== bootstrap.buildId) throw new Error('Architecture manifest version mismatch');
  assert.deepEqual(referenceFromUrl(bootstrap.runtimeUrl, bootstrap.runtimeSha256), { path: manifest.runtime.path, sha256: manifest.runtime.sha256 });
  const runtime = JSON.parse(read(manifest.runtime)), model = JSON.parse(read(manifest.model));
  if (runtime.schemaVersion !== 6 || runtime.buildId !== manifest.buildId) throw new Error('Architecture runtime version mismatch');
  assert.deepEqual(runtime.model, { features: model.features, entities: model.entities }, 'Architecture runtime model projection mismatch');
  const descriptors = new Map(runtime.views.map(view => [view.id, view]));
  if (descriptors.size !== runtime.views.length || descriptors.size !== manifest.views.length) throw new Error('Architecture view index mismatch');
  const views = manifest.views.map(entry => {
    const metadata = JSON.parse(read(entry.data)), descriptor = descriptors.get(entry.id);
    if (metadata.id !== entry.id || !descriptor) throw new Error('Architecture view identity mismatch');
    const expected = Object.fromEntries(descriptorFields.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
    if (metadata.schedulePluginGroups) expected.schedulePluginGroups = metadata.schedulePluginGroups.map(({ id, systemCount }) => ({ id, systemCount }));
    expected.resources = Object.fromEntries(['data', 'svg'].filter(kind => entry[kind]).map(kind => [kind, { url: urlFor(entry[kind]), sha256: entry[kind].sha256, bytes: entry[kind].bytes }]));
    assert.deepEqual(descriptor, expected, 'Architecture descriptor mismatch: ' + entry.id);
    if (['svg', 'dot', 'mermaid'].some(kind => typeof metadata[kind] === 'string')) throw new Error('Embedded graph text remains in view data: ' + entry.id);
    return { ...metadata, svg: entry.svg ? read(entry.svg) : null,
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
  delete result.buildId;
  return result;
}
