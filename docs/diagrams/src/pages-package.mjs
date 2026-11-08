import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { pathsForRepository, repositoryRoot } from './paths.mjs';
import { descriptorFields, embeddedArchitectureBootstrap, stampArchitecturePage, validateViewArtifactReferences } from './architecture-artifacts.mjs';
import { hashFile } from './stream-files.mjs';
import { validateArchitectureSvg } from './architecture-asset-loader.mjs';
import { replaceArtifactSync } from './architecture-artifact-writer.mjs';

export const PAGES_BUDGET_BYTES = 900000000;
const provenanceKeys = ['buildId', 'sourceCommit', 'target'];
const publicPath = /^(?:pages\/(?:ecs-architecture|ecs-source)\.html|data\/(?:runtime|manifest)\.json|data\/views\/[^/]+\.json|svg\/(?:object|schedule|legend)\/[^/]+\.svg|runtime\/[^/]+\.mjs|mermaid\/[^/]+\.mmd|dot\/[^/]+\.dot|licenses\/[^/]+)$/;
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const within = (root, target) => target.startsWith(root + path.sep);
const referenceUrl = reference => ({ url: '../' + reference.path, sha256: reference.sha256, bytes: reference.bytes });

function safePath(value) {
  if (typeof value !== 'string' || !value || /[\\\0:%?#]/.test(value) || path.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe Pages resource path: ' + value);
  return value;
}

function regularFile(directory, relative) {
  safePath(relative);
  let filename = directory;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Pages directory must not be a symbolic link');
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)
      || index < parts.length - 1 && !stat.isDirectory()) throw new Error('Pages resources must be regular files without links: ' + relative);
  }
  return filename;
}

function provenanceOf(value) {
  if (!/^[a-f0-9]{64}$/.test(value.buildId || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sourceCommit || '')
    || typeof value.target !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value.target) || value.target === 'unknown') throw new Error('Invalid Pages build provenance');
  return Object.fromEntries(provenanceKeys.map(key => [key, value[key]]));
}

function matchingProvenance(value, expected, label) {
  assert.deepEqual(provenanceOf(value), expected, 'Pages build provenance mismatch: ' + label);
}

function checkPageStamp(html, provenance) {
  for (const key of provenanceKeys) if (!html.includes(`<meta name="architecture-${key}" content="${provenance[key]}">`)) throw new Error('Missing Pages HTML provenance: ' + key);
}

function checkHtmlResources(html, page, files) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const base = new URL(page, 'https://architecture.invalid/repository/');
  function resource(value, navigation = false) {
    if (!value || value.startsWith('#') || value.startsWith('data:')) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
      if (navigation) return;
      throw new Error('External Pages HTML resource: ' + value);
    }
    if (value.startsWith('/')) throw new Error('Pages HTML resources must be repository-relative: ' + value);
    const url = new URL(value, base);
    if (url.origin !== base.origin || !['https:', 'http:'].includes(url.protocol)) {
      if (navigation) return;
      throw new Error('External Pages HTML resource: ' + value);
    }
    if (!url.pathname.startsWith('/repository/')) throw new Error('Pages HTML resource escapes its repository: ' + value);
    const relative = safePath(decodeURIComponent(url.pathname.slice('/repository/'.length)));
    if (!files.has(relative)) throw new Error('Pages HTML resource is missing from the manifest: ' + relative);
  }
  function css(source) {
    if (/@import\b/i.test(source)) throw new Error('Pages HTML must not import undeclared stylesheets');
    for (const match of source.matchAll(/url\s*\(([^)]*)\)/gi)) resource(match[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  for (const element of [...document.getElementsByTagName('*')]) {
    const tag = element.localName.toLowerCase();
    if (tag === 'base' || element.hasAttribute('srcset')) throw new Error('Unsupported Pages HTML resource base or srcset');
    for (const attribute of ['src', 'href', 'poster', 'action']) if (element.hasAttribute(attribute)) resource(element.getAttribute(attribute), tag === 'a' && attribute === 'href');
    if (tag === 'object' && element.hasAttribute('data')) resource(element.getAttribute('data'));
    if (tag === 'style') css(element.textContent);
    if (element.hasAttribute('style')) css(element.getAttribute('style'));
  }
}

function readPublicSite(directory) {
  const files = new Map();
  function read(reference) {
    if (!reference || !publicPath.test(safePath(reference.path)) || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')
      || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0) throw new Error('Invalid Pages resource reference');
    if (files.has(reference.path)) assert.deepEqual(files.get(reference.path), reference, 'Conflicting Pages resource references');
    const filename = regularFile(directory, reference.path), integrity = hashFile(filename);
    if (integrity.sha256 !== reference.sha256 || integrity.bytes !== reference.bytes) throw new Error('Pages resource hash or size mismatch: ' + reference.path);
    if (reference.path.endsWith('.svg')) validateArchitectureSvg(fs.readFileSync(filename, 'utf8'), { DOMParser });
    files.set(reference.path, reference);
    return filename;
  }
  const htmlPath = regularFile(directory, 'pages/ecs-architecture.html'), html = fs.readFileSync(htmlPath, 'utf8');
  const bootstrap = embeddedArchitectureBootstrap(html), provenance = provenanceOf(bootstrap);
  if (bootstrap.schemaVersion !== 6 || bootstrap.manifestUrl !== '../data/manifest.json' || bootstrap.runtimeUrl !== '../data/runtime.json') throw new Error('Invalid Pages bootstrap');
  checkPageStamp(html, provenance);
  files.set('pages/ecs-architecture.html', { path: 'pages/ecs-architecture.html', ...hashFile(htmlPath) });
  const manifestReference = { path: 'data/manifest.json', sha256: bootstrap.manifestSha256, bytes: fs.statSync(regularFile(directory, 'data/manifest.json')).size };
  const manifest = json(read(manifestReference));
  const allowed = ['schemaVersion', ...provenanceKeys, 'runtime', 'objectRelationRuntime', 'views', 'guides', 'pages', 'licenses'];
  if (manifest.schemaVersion !== 2 || Object.keys(manifest).some(key => !allowed.includes(key))) throw new Error('Invalid browser Pages manifest');
  matchingProvenance(manifest, provenance, 'manifest');
  if (manifest.runtime.path !== 'data/runtime.json' || manifest.runtime.sha256 !== bootstrap.runtimeSha256) throw new Error('Pages runtime bootstrap mismatch');
  const runtime = json(read(manifest.runtime));
  if (runtime.schemaVersion !== 6) throw new Error('Invalid Pages runtime');
  matchingProvenance(runtime, provenance, 'runtime');
  assert.deepEqual(Object.keys(runtime.model).sort(), ['entities', 'features'], 'Pages runtime must not contain the audit model');
  const descriptors = new Map(runtime.views.map(view => [view.id, view]));
  if (descriptors.size !== runtime.views.length || descriptors.size !== manifest.views.length) throw new Error('Pages view index mismatch');
  const viewIds = new Set();
  for (const entry of manifest.views) {
    if (viewIds.has(entry.id) || entry.data.path !== `data/views/${entry.id}.json`) throw new Error('Pages view identity mismatch');
    viewIds.add(entry.id);
    const metadata = json(read(entry.data)), descriptor = descriptors.get(entry.id);
    if (!descriptor || metadata.id !== entry.id) throw new Error('Pages view descriptor is missing');
    validateViewArtifactReferences(metadata, entry);
    matchingProvenance(metadata, provenance, entry.id);
    const expected = Object.fromEntries(descriptorFields.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
    if (metadata.aspect === 'object') expected.relationCount = metadata.links.length;
    if (metadata.schedulePluginGroups) expected.schedulePluginGroups = metadata.schedulePluginGroups.map(({ id, systemCount }) => ({ id, systemCount }));
    expected.resources = Object.fromEntries(['data', 'svg', 'mermaid'].filter(kind => entry[kind]).map(kind => [kind, referenceUrl(entry[kind])]));
    assert.deepEqual(descriptor, expected, 'Pages view descriptor mismatch: ' + entry.id);
    for (const kind of ['svg', 'mermaid', 'dot']) if (entry[kind]) read(entry[kind]);
  }
  function guides(references, urls) {
    assert.deepEqual(Object.keys(references).sort(), Object.keys(urls).sort(), 'Pages legend index mismatch');
    for (const [key, value] of Object.entries(references)) {
      if (value.path) { read(value); if (urls[key] !== '../' + value.path) throw new Error('Pages legend URL mismatch'); }
      else guides(value, urls[key]);
    }
  }
  guides(manifest.guides, runtime.guideSamples);
  if (manifest.objectRelationRuntime) {
    read(manifest.objectRelationRuntime);
    assert.deepEqual(runtime.objectRelationRuntime, referenceUrl(manifest.objectRelationRuntime), 'Pages relation runtime mismatch');
  } else if (runtime.objectRelationRuntime) throw new Error('Missing Pages relation runtime reference');
  if (manifest.pages?.source?.path !== 'pages/ecs-source.html' || Object.keys(manifest.pages).length !== 1) throw new Error('Missing Pages source snapshot');
  const sourceHtml = fs.readFileSync(read(manifest.pages.source), 'utf8');
  checkPageStamp(sourceHtml, provenance);
  if (!Array.isArray(manifest.licenses)) throw new Error('Missing Pages license index');
  for (const license of manifest.licenses) {
    if (!license.path.startsWith('licenses/')) throw new Error('Invalid Pages license path');
    read(license);
  }
  checkHtmlResources(html, 'pages/ecs-architecture.html', files);
  checkHtmlResources(sourceHtml, 'pages/ecs-source.html', files);
  return { files, provenance };
}

export function pagesIndex(provenance) {
  return stampArchitecturePage('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ECS 架构</title></head><body><a href="pages/ecs-architecture.html">打开 ECS 架构图</a><script>const target=new URL("pages/ecs-architecture.html",location.href);target.search=location.search;target.hash=location.hash;location.replace(target.href);</script></body></html>', provenance);
}

export function checkPagesBudget(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PAGES_BUDGET_BYTES) throw new Error(`Pages artifact exceeds ${PAGES_BUDGET_BYTES} bytes: ${bytes}`);
}

function outputDirectory(workspace, value) {
  return path.resolve(workspace, value || 'tmp/ecs-architecture/pages');
}

function checkedTaskDirectory(workspace, directory, { create = false, missing = false } = {}) {
  directory = path.resolve(directory);
  const temporary = path.join(workspace, 'tmp/ecs-architecture');
  if (directory !== temporary && !within(temporary, directory)) throw new Error('Pages directory escapes workspace tmp/ecs-architecture');
  let current = workspace;
  for (const part of path.relative(workspace, directory).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create) { fs.mkdirSync(current); stat = fs.lstatSync(current); }
      else if (missing) return;
      else throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pages output directories must not contain links');
    if (!within(workspace, fs.realpathSync(current))) throw new Error('Pages output directory escapes its workspace');
  }
}

function removeTaskDirectory(workspace, directory) {
  checkedTaskDirectory(workspace, directory);
  fs.rmSync(directory, { recursive: true });
}

function moveTaskDirectory(workspace, source, target, rename) {
  replaceArtifactSync(source, target, { rename: (from, to) => {
    checkedTaskDirectory(workspace, from);
    checkedTaskDirectory(workspace, path.dirname(to));
    checkedTaskDirectory(workspace, to, { missing: true });
    rename(from, to);
  } });
}

// 已校验的新目录安装失败时恢复完整旧目录；所有移动和递归清理前重新检查真实父路径。
export function replacePagesDirectory(workspace, staged, output, { rename = fs.renameSync } = {}) {
  workspace = fs.realpathSync(workspace); staged = path.resolve(staged); output = path.resolve(output);
  checkedTaskDirectory(workspace, staged);
  checkedTaskDirectory(workspace, path.dirname(output));
  checkedTaskDirectory(workspace, output, { missing: true });
  let previous;
  if (fs.existsSync(output)) {
    previous = fs.mkdtempSync(path.join(path.dirname(output), '.pages-previous-'));
    try { moveTaskDirectory(workspace, output, path.join(previous, 'site'), rename); }
    catch (error) {
      if (!fs.existsSync(path.join(previous, 'site'))) removeTaskDirectory(workspace, previous);
      throw error;
    }
  }
  try { moveTaskDirectory(workspace, staged, output, rename); }
  catch (error) {
    if (previous) moveTaskDirectory(workspace, path.join(previous, 'site'), output, rename);
    throw error;
  } finally {
    if (previous && !fs.existsSync(path.join(previous, 'site'))) removeTaskDirectory(workspace, previous);
  }
  if (previous) removeTaskDirectory(workspace, previous);
}

function actualFiles(directory, relative = '', root = directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = relative ? relative + '/' + entry.name : entry.name, absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...actualFiles(absolute, filename, root));
    else { regularFile(root, filename); result.push(filename); }
  }
  return result;
}

/** 仅验证静态发布闭包；完整编译器事实由独立 audit-manifest 和 check-ecs 验收。 */
export function checkPages({ workspace = repositoryRoot, directory } = {}) {
  const root = outputDirectory(workspace, directory), { files, provenance } = readPublicSite(root);
  const publication = json(regularFile(root, 'site-manifest.json'));
  if (publication.schemaVersion !== 1 || publication.budgetBytes !== PAGES_BUDGET_BYTES) throw new Error('Invalid Pages package manifest');
  matchingProvenance(publication, provenance, 'package');
  const index = fs.readFileSync(regularFile(root, 'index.html'), 'utf8');
  if (index !== pagesIndex(provenance) || fs.statSync(regularFile(root, '.nojekyll')).size !== 0) throw new Error('Invalid Pages entry point');
  for (const relative of ['index.html', '.nojekyll']) files.set(relative, { path: relative, ...hashFile(regularFile(root, relative)) });
  assert.deepEqual(publication.files, [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), 'Pages package file manifest mismatch');
  const expected = [...files.keys(), 'site-manifest.json'].sort();
  assert.deepEqual(actualFiles(root).sort(), expected, 'Unexpected or missing Pages package files');
  const bytes = expected.reduce((sum, relative) => sum + fs.statSync(regularFile(root, relative)).size, 0);
  checkPagesBudget(bytes);
  return { directory: root, ...provenance, files: expected.length, bytes, budgetBytes: PAGES_BUDGET_BYTES };
}

export function packPages({ workspace = repositoryRoot, outdir } = {}) {
  const root = fs.realpathSync(path.resolve(workspace)), output = outputDirectory(root, outdir), temporary = path.join(root, 'tmp/ecs-architecture');
  if (!within(temporary, output)) throw new Error('Pages output must remain under workspace tmp/ecs-architecture');
  const { generatedDirectory } = pathsForRepository(root), { files, provenance } = readPublicSite(generatedDirectory);
  checkPagesBudget([...files.values()].reduce((sum, reference) => sum + reference.bytes, 0));
  checkedTaskDirectory(root, path.dirname(output), { create: true });
  const staged = fs.mkdtempSync(path.join(path.dirname(output), '.pages-pack-'));
  try {
    for (const reference of files.values()) {
      const target = path.join(staged, reference.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(regularFile(generatedDirectory, reference.path), target);
    }
    fs.writeFileSync(path.join(staged, 'index.html'), pagesIndex(provenance));
    fs.writeFileSync(path.join(staged, '.nojekyll'), '');
    for (const relative of ['index.html', '.nojekyll']) files.set(relative, { path: relative, ...hashFile(path.join(staged, relative)) });
    fs.writeFileSync(path.join(staged, 'site-manifest.json'), JSON.stringify({ schemaVersion: 1, ...provenance, budgetBytes: PAGES_BUDGET_BYTES,
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) }));
    const checked = checkPages({ workspace: root, directory: staged });
    replacePagesDirectory(root, staged, output);
    return { ...checked, directory: output };
  } finally {
    if (fs.existsSync(staged)) removeTaskDirectory(root, staged);
  }
}
