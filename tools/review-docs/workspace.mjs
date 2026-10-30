import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { toolDirectory } from './dependencies.mjs';

export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const stable = value => JSON.stringify(value);
export const unix = value => value.split(path.sep).join('/');
export function fail(message) { throw new Error(message); }
export function git(root, args, allowFailure = false) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, windowsHide: true }); }
  catch (error) { if (allowFailure) return error.stdout || ''; throw new Error(`Git 操作失败: ${error.stderr || error.message}`); }
}
export function identity(root) {
  root = fs.realpathSync(root);
  if (path.resolve(git(root, ['rev-parse', '--show-toplevel']).trim()).toLowerCase() !== root.toLowerCase()) fail('workspace 必须为 Git 工作树根目录');
  return { root, branch: git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true).trim() || null, gitDir: fs.realpathSync(git(root, ['rev-parse', '--absolute-git-dir']).trim()),
    commonDir: fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim())), head: git(root, ['rev-parse', 'HEAD']).trim() };
}
export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
// 每段都核对真实大小写与重解析点；允许树内链接，拒绝逃逸到树外。
export function safePath(root, relative, { missing = true, noLinks = false } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0')) fail('无效路径');
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) fail(`路径越出工作树: ${relative}`);
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    if (!fs.existsSync(current)) break;
    const entries = fs.readdirSync(current);
    if (!entries.includes(segment)) {
      if (entries.some(entry => entry.toLowerCase() === segment.toLowerCase())) fail(`路径大小写不匹配: ${relative}`);
      if (!missing) fail(`路径不存在: ${relative}`);
      current = path.join(current, segment); continue;
    }
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink() && noLinks) fail(`会话目录禁止链接: ${relative}`);
    if (!inside(root, fs.realpathSync(current))) fail(`符号链接越出工作树: ${relative}`);
  }
  return absolute;
}
export function readHash(root, relative) {
  const file = safePath(root, relative);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? hash(fs.readFileSync(file)) : null;
}
export function fileList(root) {
  return [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))]
    .filter(p => !/^(tmp|target|node_modules|\.git)\//.test(p) && !p.includes('/node_modules/')).sort();
}
export function isDocument(p) {
  return /\.(md|markdown|mdx|html?|svg|rst|adoc|txt)$/i.test(p) || /(^|\/)(AGENTS|LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*|SOURCES[^/]*|sources\.json|licenses\.json)$/i.test(p);
}
export function rules() {
  const value = JSON.parse(fs.readFileSync(path.join(toolDirectory, 'rules.json'), 'utf8'));
  if (value.schemaVersion !== 1) fail('不支持的规则版本');
  return value;
}
export function classify(p, r = rules()) {
  if (r.generatedEntries[p]) return { kind: 'generated', rule: `rules.json:generatedEntries:${p}`, ...r.generatedEntries[p], requiredReview: false, exclusionReason: '已知生成物由所列源码维护入口负责；普通文档审查不展开生成产物' };
  if (r.generatedPaths.includes(p) || r.generatedPrefixes.some(prefix => p.startsWith(prefix))) return { kind: 'generated', rule: 'rules.json:generatedPaths/generatedPrefixes', owner: r.generatedOwner, requiredReview: false, exclusionReason: '已知生成物由维护入口负责；普通文档审查不展开生成产物' };
  const basename = path.posix.basename(p);
  if (r.licenseEntries[p] || new RegExp(r.licenseBasenamePattern, 'i').test(basename) || new RegExp(r.licenseDirectoryPattern, 'i').test(p)) return { kind: 'protected_source_or_license', rule: r.licenseEntries[p] ? `rules.json:licenseEntries:${p}` : 'rules.json:licenseBasenamePattern/licenseDirectoryPattern', ...r.licenseEntries[p], automaticProseEdits: false, requiredReview: false, exclusionReason: '许可/第三方许可正文不作一般内容改写；链接引用时按需检查目标' };
  if (r.protectedBasenames.some(n => n.toLowerCase() === basename.toLowerCase()) || new RegExp(r.protectedSourceBasenamePattern, 'i').test(basename)) return { kind: 'protected_source_or_license', rule: 'rules.json:protectedBasenames/protectedSourceBasenamePattern', automaticProseEdits: false };
  if (/\.(md|markdown)$/i.test(p)) return { kind: 'handwritten', rule: 'Markdown candidate; content ownership still requires review' };
  return { kind: 'unclassified', rule: 'No explicit source rule; extension does not establish generated status' };
}
export function inScope(p, scope) { return scope.length === 0 || scope.some(s => p === s || p.startsWith(`${s}/`)); }
export function inventory(root, scope) {
  const r = rules();
  return fileList(root).filter(isDocument).map(p => {
    const classification = classify(p, r), selected = inScope(p, scope);
    return { path: p, hash: classification.requiredReview === false ? null : readHash(root, p), ...classification, selected, inScope: selected && classification.requiredReview !== false };
  });
}
export function entries(root, documents) {
  const all = fileList(root), result = new Set(rules().readingEntries.filter(p => all.includes(p)));
  for (const doc of documents) {
    let dir = path.posix.dirname(doc.path);
    while (dir !== '.') { const candidate = `${dir}/AGENTS.md`; if (all.includes(candidate)) result.add(candidate); dir = path.posix.dirname(dir); }
  }
  return [...result].sort();
}
export function toolHashes() {
  const values = Object.fromEntries(fs.readdirSync(toolDirectory).filter(p => /\.(mjs|json)$/.test(p)).sort().map(p => [p, hash(fs.readFileSync(path.join(toolDirectory, p)))]));
  values['scripts/check-docs.ps1'] = hash(fs.readFileSync(path.resolve(toolDirectory, '../../scripts/check-docs.ps1')));
  return values;
}
export function environment(root, scope) {
  const docs = inventory(root, scope);
  const entryPaths = entries(root, docs.filter(d => d.inScope));
  const r = rules();
  const classificationEvidence = [...new Set([r.generatedOwner, ...Object.values(r.generatedEntries).map(e => e.owner),
    ...Object.values(r.generatedEntries).map(e => e.evidence.split(':')[0]), ...Object.values(r.licenseEntries).map(e => e.evidence.split(':')[0])])].sort();
  return { documents: docs.filter(d => d.inScope).map(d => ({ path: d.path, hash: d.hash })),
    rules: Object.fromEntries([...new Set([...entryPaths, ...classificationEvidence])].sort().map(p => [p, readHash(root, p)])), tool: toolHashes() };
}
export function status(root) {
  return { porcelain: git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    staged: git(root, ['diff', '--cached', '--binary', '--no-ext-diff']), unstaged: git(root, ['diff', '--binary', '--no-ext-diff']) };
}
