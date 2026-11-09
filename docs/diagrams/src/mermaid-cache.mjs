import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { NODE_STYLES } from './architecture-style.mjs';
import { pathsForRepository } from './paths.mjs';
import { replaceArtifactSync } from './architecture-artifact-writer.mjs';
import { architectureBrowserPath } from './architecture-browser.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const geometryFields = ['svg', 'mermaid', 'width', 'height', 'bounds', 'routing', 'sections', 'entityGroups', 'layoutLinks'];
const cachePath = workspace => path.join(workspace, 'tmp/ecs-architecture/mermaid-build/geometry-cache');

export function mermaidDependencyIdentity(workspace, { environment = process.env, platform = process.platform } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(pathsForRepository(workspace).packageRoot, 'package-lock.json'), 'utf8'));
  // 这两个独立工具不参与 Mermaid 布局。
  for (const name of ['@viz-js/viz', 'smol-toml']) {
    delete lock.packages[''].devDependencies[name];
    delete lock.packages['node_modules/' + name];
  }
  const browser = architectureBrowserPath({ environment, platform, required: false });
  return JSON.stringify({ lock, platform, architecture: process.arch,
    browser: browser ? hash(fs.readFileSync(browser)) : null,
    renderContext: environment.MERMAID_RENDER_CONTEXT || null }, null, 2) + '\n';
}

// 只散列实际绘图输入；定位证据不参与 SVG 编译。
export function mermaidRenderIdentity(view, registry, dependencies) {
  const inputs = { version: 5, id: view.id, definition: view.mermaid, dependencies,
    categories: view.nodes.map(node => [node.id, node.visualType, NODE_STYLES[node.visualType].label]),
    titles: view.nodes.map(node => [node.id, registry[node.id].name, registry[node.id].feature]),
    componentDetails: view.componentDetails };
  return { fingerprint: hash(JSON.stringify(inputs)),
    inputs: Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, hash(JSON.stringify(value))])) };
}

function primaryWorktree(workspace) {
  try {
    const records = execFileSync('git', ['-C', workspace, 'worktree', 'list', '--porcelain', '-z'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0\0');
    for (const record of records) {
      const fields = record.split('\0'), entry = fields.find(field => field.startsWith('worktree '));
      if (entry && !fields.includes('bare')) return path.resolve(entry.slice('worktree '.length));
    }
  } catch { /* 无 Git 的离线目录仍可使用自身缓存和正式产物。 */ }
  return workspace;
}

export function mermaidGeometryRecord(view) {
  return { geometry: Object.fromEntries(geometryFields.map(key => [key, view[key]])),
    positions: Object.fromEntries(view.nodes.map(node => [node.id, node.position])),
    scheduleBounds: Object.fromEntries(view.scheduleGroups.map(group => [group.id, group.labelBounds ? { labelBounds: group.labelBounds } : {}])) };
}

export function restoreMermaidGeometry(view, cached) {
  if (!cached?.geometry || !cached.positions || !cached.scheduleBounds) throw new Error('Incomplete Mermaid geometry cache');
  return { ...view, ...Object.fromEntries(geometryFields.map(key => [key, cached.geometry[key]])),
    nodes: view.nodes.map(node => ({ ...node, position: cached.positions[node.id] })),
    scheduleGroups: view.scheduleGroups.map(group => ({ ...group, ...cached.scheduleBounds[group.id] })) };
}

// 输入指纹只决定候选；调用方仍须执行当前的文字、几何和路由检查。
export function createMermaidCache(workspace) {
  const local = cachePath(workspace), shared = cachePath(primaryWorktree(workspace));
  const directories = [...new Set([local, shared])];
  const generated = pathsForRepository(workspace).generatedDirectory;
  const manifestPath = path.join(generated, 'data/manifest.json');
  let published = new Map();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion === 2 && Array.isArray(manifest.views)) published = new Map(manifest.views.map(entry => [entry.id, entry]));
  } catch { /* 首次生成或损坏的旧清单不作为可复用输入。 */ }

  function readReference(reference) {
    if (!reference || typeof reference.path !== 'string' || reference.path.includes('\\') || path.isAbsolute(reference.path)
      || reference.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0)
      throw new Error('Invalid published Mermaid cache reference');
    let filename = generated;
    for (const part of reference.path.split('/')) {
      filename = path.join(filename, part);
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Symlink in published Mermaid cache reference');
    }
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== reference.bytes || hash(bytes) !== reference.sha256) throw new Error('Published Mermaid cache integrity mismatch');
    return bytes.toString('utf8');
  }

  function* candidates(view, fingerprint) {
    for (const directory of directories) {
      const filename = path.join(directory, fingerprint + '.json');
      if (!fs.existsSync(filename)) continue;
      try {
        if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('Symlink in Mermaid geometry cache');
        const cached = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (cached.fingerprint !== undefined && cached.fingerprint !== fingerprint) throw new Error('Mermaid cache input mismatch');
        yield { source: directory === local ? 'local' : 'shared', cached };
      } catch (error) { yield { source: 'invalid', error }; }
    }
    const entry = published.get(view.id);
    if (!entry || entry.renderFingerprint !== fingerprint) return;
    try {
      const metadata = JSON.parse(readReference(entry.data));
      if (metadata.id !== view.id || metadata.renderFingerprint !== fingerprint) throw new Error('Published Mermaid cache input mismatch');
      const result = { ...metadata, svg: readReference(entry.svg), mermaid: readReference(entry.mermaid) };
      yield { source: 'published', cached: mermaidGeometryRecord(result) };
    } catch (error) { yield { source: 'invalid', error }; }
  }

  function plan(views, identities) {
    const result = { candidates: { local: 0, shared: 0, published: 0, missing: 0 }, missingReasons: {}, examples: [] };
    for (const view of views) {
      const identity = identities.get(view.id);
      if (!identity) continue;
      const { fingerprint, inputs } = identity;
      const directory = directories.find(directory => fs.existsSync(path.join(directory, fingerprint + '.json')));
      if (directory) { result.candidates[directory === local ? 'local' : 'shared']++; continue; }
      const entry = published.get(view.id);
      if (entry?.renderFingerprint === fingerprint) { result.candidates.published++; continue; }
      result.candidates.missing++;
      const reason = !entry ? 'no-published-view' : !entry.renderFingerprint ? 'unversioned-published-view' : 'render-input-changed';
      result.missingReasons[reason] = (result.missingReasons[reason] || 0) + 1;
      if (result.examples.length >= 5) continue;
      let changedInputs;
      if (entry?.renderFingerprint) {
        try {
          const previous = JSON.parse(readReference(entry.data)).renderInputs || {};
          changedInputs = [...new Set([...Object.keys(previous), ...Object.keys(inputs)])].filter(key => previous[key] !== inputs[key]);
        } catch { changedInputs = ['published-integrity']; }
      }
      result.examples.push({ view: view.id, reason, ...(changedInputs ? { changedInputs } : {}) });
    }
    return result;
  }

  let warned = false;
  function store(fingerprint, inputs, view) {
    const payload = JSON.stringify({ fingerprint, inputs, ...mermaidGeometryRecord(view) });
    let failure;
    for (const directory of new Set([shared, local])) {
      const filename = path.join(directory, fingerprint + '.json');
      const staged = path.join(directory, `.${fingerprint}-${process.pid}-${crypto.randomUUID()}.tmp`);
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(staged, payload);
        replaceArtifactSync(staged, filename);
        if (failure && !warned) { console.warn('Mermaid shared cache unavailable; using the local worktree cache: ' + failure.message); warned = true; }
        return directory;
      } catch (error) {
        failure = error;
        try { fs.unlinkSync(staged); } catch { /* 只清理本次创建的暂存文件；不可写时不影响已验证结果。 */ }
      }
    }
    if (!warned) { console.warn('Mermaid cache write unavailable; retaining the verified result: ' + failure.message); warned = true; }
    return null;
  }

  return { candidates, plan, store, localDirectory: local, sharedDirectory: shared };
}
