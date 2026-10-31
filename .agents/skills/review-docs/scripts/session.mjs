import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hash, stable, identity, safePath, inventory, entries, environment, status, git, readHash, fail } from './workspace.mjs';

export function init(root, scope, base) {
  const who = identity(root);
  const initialStatus = status(root);
  scope = scope.map(s => { safePath(who.root, s); return path.relative(who.root, path.resolve(who.root, s)).split(path.sep).join('/'); });
  if (scope.includes('')) scope = [];
  const resolvedBase = git(root, ['rev-parse', '--verify', `${base || 'HEAD'}^{commit}`]).trim();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const relative = `tmp/review-docs/sessions/${id}`;
  safePath(root, relative, { noLinks: true });
  const directory = path.join(root, relative);
  const documents = inventory(root, scope);
  for (const requested of scope) if (!documents.some(d => inScopeForRequest(d.path, requested))) fail(`scope 不存在或不包含文档: ${requested}`);
  if (!documents.some(d => d.inScope)) fail('范围没有需要内容审查的维护文档；已知生成物/纯许可须使用其维护入口');
  fs.mkdirSync(directory, { recursive: true });
  const capturedEnvironment = environment(root, scope);
  const snapshots = Object.fromEntries(documents.filter(d => d.inScope && d.hash !== null).map(d => {
    const bytes = fs.readFileSync(safePath(root, d.path));
    if (hash(bytes) !== d.hash) fail(`init 期间文档变动: ${d.path}`);
    return [d.path, bytes.toString('base64')];
  }));
  if (stable(initialStatus) !== stable(status(root)) || stable(capturedEnvironment) !== stable(environment(root, scope))) fail('init 期间工作树输入变动；请重新创建会话');
  const baseline = { schemaVersion: 1, id, createdAt: new Date().toISOString(), ...who, base: resolvedBase,
    baseArgument: base || null, scope, initialStatus, documents, readingEntries: entries(root, documents.filter(d => d.inScope)),
    environment: capturedEnvironment, snapshots };
  const bytes = `${stable(baseline)}\n`;
  fs.writeFileSync(path.join(directory, 'baseline.json'), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'events.jsonl'), '', { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'head.json'), stable({ baselineHash: hash(bytes), count: 0, hash: null }), { flag: 'wx' });
  return { session: id, sessionPath: directory, baseline: { head: who.head, base: resolvedBase, scope, documents: documents.filter(d => d.inScope).length }, readingEntries: baseline.readingEntries };
}
function inScopeForRequest(p, scope) { return p === scope || p.startsWith(`${scope}/`); }
function sessionDirectory(root, value) {
  if (!value) fail('--session 必填');
  const home = safePath(root, 'tmp/review-docs/sessions', { noLinks: true });
  const directory = path.isAbsolute(value) || value.includes('/') || value.includes('\\') ? path.resolve(root, value) : path.join(home, value);
  if (path.dirname(directory) !== home) fail('会话必须直接位于当前工作树 tmp/review-docs/sessions');
  safePath(root, path.relative(root, directory), { missing: false, noLinks: true });
  return directory;
}
export function loadSession(root, value) {
  const directory = sessionDirectory(root, value);
  for (const name of ['baseline.json', 'head.json', 'events.jsonl']) safePath(root, path.relative(root, path.join(directory, name)), { missing: false, noLinks: true });
  const bytes = fs.readFileSync(path.join(directory, 'baseline.json'));
  const baseline = JSON.parse(bytes), head = JSON.parse(fs.readFileSync(path.join(directory, 'head.json'), 'utf8'));
  if (baseline.schemaVersion !== 1 || head.baselineHash !== hash(bytes)) fail('baseline 完整性校验失败');
  const who = identity(root);
  for (const field of ['root', 'gitDir', 'commonDir']) if (who[field] !== baseline[field]) fail(`会话工作树身份不匹配: ${field}`);
  const raw = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  let previous = null;
  events.forEach((event, i) => {
    const { hash: eventHash, ...body } = event;
    if (event.seq !== i + 1 || event.previousHash !== previous || event.baselineHash !== head.baselineHash || eventHash !== hash(stable(body))) fail('历史记录链损坏');
    previous = eventHash;
  });
  if (head.count !== events.length || head.hash !== previous) fail('历史记录长度或末尾校验失败');
  return { directory, baseline, head, events };
}
// 原子重命名整份追加日志；锁同时保护读取、校验和追加，避免并发覆盖。
export async function withLock(root, value, action) {
  const directory = sessionDirectory(root, value);
  const lockHome = safePath(root, 'tmp/review-docs/locks', { noLinks: true });
  fs.mkdirSync(lockHome, { recursive: true });
  const lock = path.join(lockHome, `${path.basename(directory)}.lock`);
  safePath(root, path.relative(root, lock), { noLinks: true });
  let descriptor;
  for (let i = 0; i < 100; i++) {
    try { descriptor = fs.openSync(lock, 'wx'); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  if (descriptor === undefined) fail('会话正被其他进程使用；若进程异常退出，请核实后移除 .lock');
  try { return await action(loadSession(root, value)); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}
export function append(session, payload) {
  const body = { ...payload, id: crypto.randomUUID(), seq: session.head.count + 1, at: new Date().toISOString(), baselineHash: session.head.baselineHash, previousHash: session.head.hash };
  const event = { ...body, hash: hash(stable(body)) };
  const log = path.join(session.directory, 'events.jsonl'), head = path.join(session.directory, 'head.json');
  fs.writeFileSync(`${log}.next`, session.events.map(e => stable(e)).concat(stable(event)).join('\n') + '\n', { flag: 'wx' });
  fs.writeFileSync(`${head}.next`, stable({ baselineHash: session.head.baselineHash, count: event.seq, hash: event.hash }), { flag: 'wx' });
  fs.renameSync(`${log}.next`, log);
  fs.renameSync(`${head}.next`, head);
  return event;
}
export function dependenciesFor(root, baseline, scope, evidence = []) {
  const env = environment(root, baseline.scope);
  return { base: comparisonBase(root, baseline).current, tool: env.tool, rules: env.rules,
    membership: env.documents.map(d => d.path), files: Object.fromEntries([...new Set([...scope, ...evidence.map(e => e.path)])].sort().map(p => [p, readHash(root, p)])) };
}
export function currentEvent(root, session, event) {
  if (!event.dependencies) return true;
  if (comparisonBase(root, session.baseline).status !== 'current') return false;
  return stable(event.dependencies) === stable(dependenciesFor(root, session.baseline, event.scope || [], event.evidence || []));
}
export function comparisonBase(root, baseline) {
  const current = baseline.baseArgument ? git(root, ['rev-parse', '--verify', `${baseline.baseArgument}^{commit}`], true).trim() || null : baseline.base;
  return { frozen: baseline.base, argument: baseline.baseArgument, current, status: current === baseline.base ? 'current' : 'moved' };
}
export function sessionDocuments(root, baseline) {
  const current = inventory(root, baseline.scope), present = new Set(current.map(d => d.path));
  return [...current, ...baseline.documents.filter(d => !present.has(d.path)).map(d => ({ ...d, hash: null }))].sort((a, b) => a.path.localeCompare(b.path));
}
