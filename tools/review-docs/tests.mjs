import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { dependencies, defaultWorkspace, toolDirectory } from './dependencies.mjs';
import { git, hash, safePath, inventory } from './workspace.mjs';
import { init, loadSession, withLock, append } from './session.mjs';
import { check } from './check.mjs';
import { record } from './records.mjs';
import { report } from './report.mjs';

const deps = await dependencies();
const home = path.join(defaultWorkspace, 'tmp/review-docs/test-fixtures');
fs.mkdirSync(home, { recursive: true });
let counter = 0;
function trustFixture(root) {
  // D: 测试文件系统无所有者信息；仅为本测试进程明确创建的目录提供一次性信任。
  const index = Number(process.env.GIT_CONFIG_COUNT || 0);
  process.env[`GIT_CONFIG_KEY_${index}`] = 'safe.directory';
  process.env[`GIT_CONFIG_VALUE_${index}`] = root.replaceAll('\\', '/');
  process.env.GIT_CONFIG_COUNT = String(index + 1);
}
function write(root, name, content) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content); }
function commit(root, message = 'fixture') { git(root, ['add', '.']); git(root, ['-c', 'user.name=Review Docs Tests', '-c', 'user.email=review-docs@example.invalid', 'commit', '--allow-empty', '-m', message]); }
function fixture(files = { 'README.md': '# 文档\n', 'AGENTS.md': '# Rules\n' }) {
  const root = path.join(home, `隔离 空格-${process.pid}-${counter++}`);
  fs.mkdirSync(root, { recursive: true });
  trustFixture(root);
  git(root, ['init', '-q']);
  write(root, '.gitignore', 'tmp/\n');
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  commit(root);
  return root;
}
function start(root, scope = [], base) { const result = init(root, scope, base); return loadSession(root, result.session); }
function evidence(p = 'README.md') { return [{ path: p, reference: '全文及职责核对' }]; }
async function add(root, session, input) { return withLock(root, session.baseline.id, s => record(root, s, { schemaVersion: 1, ...input })); }
function assignment(actor, role = 'reviewer', scope = ['README.md']) { return { type: 'assignment', actor, role, scope, evidence: evidence(), execution: { model: role === 'editor' ? 'gpt-6.1-terra' : 'gpt-6.1-sol', effort: 'high', forkTurns: 'none' } }; }
function review(actor, type = 'content_review', scope = ['README.md']) { return { type, actor, scope, evidence: evidence(), result: 'no_findings', findings: [] }; }
function cli(args, cwd = defaultWorkspace) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(toolDirectory, 'cli.mjs'), ...args], { cwd, windowsHide: true });
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.on('close', code => resolve({ code, out, err, json: JSON.parse(out) }));
  });
}

test('保存预存 staged/unstaged/untracked/delete/rename，基线不随追加改变', async () => {
  const root = fixture({ 'README.md': '# Before\n', 'delete.md': '# Delete\n', 'old.md': '# Rename\n' });
  write(root, 'README.md', '# Staged\n'); git(root, ['add', 'README.md']); write(root, 'README.md', '# Unstaged\n');
  fs.unlinkSync(path.join(root, 'delete.md')); git(root, ['mv', 'old.md', 'renamed.md']); write(root, 'new.md', '# New\n');
  const session = start(root), before = fs.readFileSync(path.join(session.directory, 'baseline.json'));
  assert.match(session.baseline.initialStatus.porcelain, /MM README.md/);
  assert.match(session.baseline.initialStatus.porcelain, / D delete.md/);
  assert.match(session.baseline.initialStatus.porcelain, /R  renamed.md\0old.md/);
  assert.match(session.baseline.initialStatus.porcelain, /\?\? new.md/);
  assert.equal(session.baseline.documents.find(d => d.path === 'delete.md').hash, null);
  await add(root, session, assignment('reviewer'));
  assert.deepEqual(fs.readFileSync(path.join(session.directory, 'baseline.json')), before);
  write(root, 'README.md', '# Round change\n');
  assert.equal(report(root, loadSession(root, session.baseline.id)).changesSinceInit.find(d => d.path === 'README.md').before, hash('# Unstaged\n'));
});

test('Markdown AST、GFM slug、中文括号百分号、引用图片与HTML；代码伪链接忽略', async () => {
  const root = fixture({ 'README.md': '# 开始\n[重复](目标%20(一)%25.md#中文-标题-1)\n![图][image]\n\n[image]: image.png\n\n<a href="target.html#named">HTML</a>\n\n`[fake](missing.md)`\n```md\n[bad](absent.md)\n```\n', '目标 (一)%.md': '# 中文 标题\n# 中文 标题\n', 'target.html': '<a name="named"></a><div id="other"></div>' });
  write(root, 'image.png', 'not decoded');
  const result = await check(root, start(root).baseline, deps);
  assert.deepEqual(result.problems, []);
  assert.equal(result.status, 'pass');
});

test('断链、大小写、路径越界、范围外受影响入链与外部协议分别呈现', async () => {
  const root = fixture({ 'README.md': '# Main\n[external](https://example.invalid)\n[vs](vscode://file/a)\n[case](Target.md)\n[out](../../outside.md)\n', 'target.md': '# New\n', 'outside.md': '[incoming](target.md#old)\n' });
  const all = await check(root, start(root).baseline, deps);
  assert.equal(all.externalLinks.length, 2);
  assert.equal(all.status, 'fail');
  assert.ok(all.problems.some(p => /大小写/.test(p.message)));
  assert.ok(all.problems.some(p => /越出/.test(p.message)));
  const scoped = await check(root, start(root, ['target.md']).baseline, deps);
  assert.ok(scoped.problems.some(p => p.path === 'outside.md' && p.outsideScope && p.code === 'missing_anchor'));
});

test('Skill frontmatter、未填骨架与diff空白缺陷被检查', async () => {
  const root = fixture({ 'README.md': '# A\n', 'a/SKILL.md': '---\nname: a\ndescription: TODO\n---\n# TODO\n' });
  write(root, 'README.md', '# A  \n');
  const result = await check(root, start(root).baseline, deps);
  assert.ok(result.problems.some(p => p.code === 'skill_field'));
  assert.ok(result.problems.some(p => p.code === 'skill_skeleton'));
  assert.ok(result.problems.some(p => p.code === 'diff_whitespace'));
});

test('未知HTML/SVG不猜生成；许可证与来源明确保护，忽略新文件不进入清单', () => {
  const root = fixture({ 'README.md': '# A\n', 'unknown.svg': '<svg/>', 'LICENSE.md': 'License', 'assets/sources.json': '{}' });
  write(root, '.gitignore', 'tmp/\nignored.md\n'); write(root, 'ignored.md', '# Ignore\n'); write(root, '.hidden/guide.md', '# Hidden\n');
  const docs = inventory(root, []);
  assert.equal(docs.find(d => d.path === 'unknown.svg').kind, 'unclassified');
  assert.equal(docs.find(d => d.path === 'LICENSE.md').kind, 'protected_source_or_license');
  assert.equal(docs.find(d => d.path === 'assets/sources.json').automaticProseEdits, false);
  assert.ok(docs.some(d => d.path === '.hidden/guide.md'));
  assert.ok(!docs.some(d => d.path === 'ignored.md'));
});

test('唯一编辑者、实际派发元数据与独立终审身份约束', async () => {
  const root = fixture(), session = start(root);
  await add(root, session, assignment('writer', 'editor'));
  await assert.rejects(add(root, session, assignment('other', 'editor')), /一个编辑者/);
  await assert.rejects(add(root, session, assignment('writer', 'independent_reviewer')), /历史编辑者/);
  await assert.rejects(add(root, session, { ...assignment('bad'), execution: { model: 'unknown', effort: 'high', forkTurns: 'none' } }), /能力范围/);
  await assert.rejects(add(root, session, { ...assignment('bad'), execution: { model: 'gpt-6.1-sol', effort: 'high', forkTurns: 'all' } }), /forkTurns/);
  await assert.rejects(add(root, session, { ...assignment('bad'), execution: { model: 'gpt-6.1-sol', effort: 'high', forkTurns: 'none', requestedModel: 'gpt-6.1-terra' } }), /不一致/);
  await assert.rejects(add(root, session, { ...review('reviewer'), findings: undefined }), /findings/);
  write(root, 'README.md', '# Changed\n');
  await assert.rejects(add(root, session, assignment('writer', 'independent_reviewer')), /历史编辑者/);
});

test('仅链接检查或未回收委派不能完成；具名内容与独立复审可完成', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  let result = report(root, loadSession(root, session.baseline.id));
  assert.equal(result.coverage[0].status, 'links_only'); assert.equal(result.complete, false);
  await add(root, session, { ...assignment('reader'), type: 'delegation' });
  await add(root, session, review('reader'));
  assert.equal(report(root, loadSession(root, session.baseline.id)).coverage[0].status, 'delegated_pending');
  await add(root, session, review('reader', 'return'));
  await add(root, session, assignment('final', 'independent_reviewer'));
  await add(root, session, review('final', 'independent_review'));
  result = report(root, loadSession(root, session.baseline.id));
  assert.equal(result.complete, true); assert.equal(result.content.status, 'no_findings');
});

test('依据变动使审查过期，具名reconfirmation保留旧事件；commit本身不使证据过期', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await add(root, session, assignment('reader')); const event = await add(root, session, review('reader'));
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  commit(root, 'pure commit');
  assert.equal(report(root, loadSession(root, session.baseline.id)).mechanical.status, 'pass');
  write(root, 'README.md', '# Changed\n');
  assert.equal(report(root, loadSession(root, session.baseline.id)).mechanical.status, 'stale');
  assert.equal(report(root, loadSession(root, session.baseline.id)).coverage[0].status, 'pending');
  await add(root, session, { type: 'reconfirmation', actor: 'reader', scope: ['README.md'], evidence: evidence(), eventId: event.id, reason: '重新通读变化后的必要事实' });
  const loaded = loadSession(root, session.baseline.id);
  assert.equal(loaded.events.find(e => e.id === event.id).evidence[0].hash, event.evidence[0].hash);
  assert.equal(report(root, loaded).coverage[0].status, 'content_reviewed');
});

test('限定范围的规则引用变化使机械与审查证据过期', async () => {
  const references = ['scope', 'delegation', 'review-rules', 'validation']
    .map(name => `.agents/skills/review-docs/references/${name}.md`);
  for (const changed of references) {
    const files = { 'README.md': '# Main\n', 'AGENTS.md': '# Rules\n' };
    for (const reference of references) files[reference] = `# ${reference}\n`;
    const root = fixture(files), session = start(root, ['README.md']);
    for (const reference of references) {
      assert.ok(session.baseline.readingEntries.includes(reference));
      assert.equal(session.baseline.environment.rules[reference], hash(files[reference]));
    }
    await add(root, session, assignment('reader'));
    await add(root, session, review('reader'));
    await add(root, session, assignment('final', 'independent_reviewer'));
    await add(root, session, review('final', 'independent_review'));
    await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
    let result = report(root, loadSession(root, session.baseline.id));
    assert.equal(result.mechanical.status, 'pass');
    assert.equal(result.complete, true);
    // 会话记录自身不属于输入；追加记录后旧证据仍有效。
    await add(root, session, review('reader'));
    result = report(root, loadSession(root, session.baseline.id));
    assert.equal(result.mechanical.status, 'pass');
    assert.equal(result.complete, true);
    write(root, changed, `${files[changed]}Changed\n`);
    result = report(root, loadSession(root, session.baseline.id));
    assert.equal(result.mechanical.status, 'stale');
    assert.equal(result.coverage[0].status, 'pending');
    assert.equal(result.coverage[0].independentReview, false);
    assert.deepEqual(result.coverage[0].independentEvents, []);
    assert.equal(result.complete, false);
  }
});

test('检查期间修改输入不能记录pass；链接目标源文件也是依赖', async () => {
  const root = fixture({ 'README.md': '# A\n[source](code.rs)\n', 'code.rs': 'fn main() {}\n' });
  const session = start(root, ['README.md']);
  const result = await check(root, session.baseline, deps, { afterRead: () => write(root, 'code.rs', 'changed') });
  assert.equal(result.status, 'fail');
  assert.ok(result.problems.some(p => p.code === 'input_changed_during_check'));
});

test('并发追加不丢事件，历史篡改与截断会被拒绝', async () => {
  const root = fixture(), session = start(root);
  await Promise.all(Array.from({ length: 8 }, (_, i) => add(root, session, assignment(`reader${i}`))));
  assert.equal(loadSession(root, session.baseline.id).events.length, 8);
  const log = path.join(session.directory, 'events.jsonl'), original = fs.readFileSync(log, 'utf8');
  fs.writeFileSync(log, original.replace('reader0', 'tampered'));
  assert.throws(() => loadSession(root, session.baseline.id), /历史记录/);
  fs.writeFileSync(log, original.split('\n').slice(0, -2).join('\n') + '\n');
  assert.throws(() => loadSession(root, session.baseline.id), /历史记录/);
});

test('baseline篡改与越界session拒绝', () => {
  const root = fixture(), session = start(root);
  assert.throws(() => loadSession(root, '../escape'), /会话必须/);
  const base = path.join(session.directory, 'baseline.json'); fs.appendFileSync(base, ' ');
  assert.throws(() => loadSession(root, session.baseline.id), /baseline 完整性/);
});

test('junction/symlink真实逃逸拒绝（文件系统不支持时明确未验证）', t => {
  const root = fixture(), outside = fixture();
  try { fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EISDIR', 'ENOTSUP', 'EPERM', 'EINVAL', 'EACCES'].includes(error.code)) { t.skip(`当前文件系统无法创建junction/symlink: ${error.code}; 本分支未验证`); return; }
    throw error;
  }
  assert.throws(() => safePath(root, 'escape/README.md'), /越出/);
});

test('最新具名结论覆盖旧unverified，已解决约束不永久阻塞完成', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await add(root, session, assignment('reader'));
  await add(root, session, { ...review('reader'), result: 'unverified' });
  await add(root, session, review('reader'));
  await add(root, session, assignment('final', 'independent_reviewer'));
  await add(root, session, { ...review('final', 'independent_review'), result: 'findings', findings: [{ severity: 'constraint', message: '必要事实尚缺' }] });
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, false);
  await add(root, session, review('final', 'independent_review'));
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, true);
});

test('初始未跟踪文档被删除仍保留本轮删除与覆盖记录', () => {
  const root = fixture(); write(root, 'draft.md', '# Draft\n'); const session = start(root);
  fs.unlinkSync(path.join(root, 'draft.md'));
  const result = report(root, session);
  assert.equal(result.changesSinceInit.find(d => d.path === 'draft.md').after, null);
  assert.ok(result.coverage.some(d => d.path === 'draft.md'));
});

test('不存在scope拒绝，不允许空候选strict绿灯；四千生成物只留排除记录', async () => {
  const root = fixture({ 'README.md': '# Main\n', 'SOURCES.md': '# 来源\n[source](README.md)\n', 'ATTRIBUTION.md': '# Attribution\n', 'LICENSE.md': 'Pure license\n' });
  assert.throws(() => start(root, ['docs/typo-does-not-exist.md']), /scope 不存在/);
  for (let i = 0; i < 4000; i++) write(root, `docs/diagrams/generated/sources/asset-${i}.${i % 2 ? 'html' : 'svg'}`, '<a href="missing.md">generated</a>');
  const session = start(root), generated = session.baseline.documents.filter(d => d.kind === 'generated');
  assert.equal(generated.length, 4000);
  assert.ok(generated.every(d => !d.inScope && d.hash === null));
  assert.equal(Object.keys(session.baseline.snapshots).length, 3);
  assert.ok(session.baseline.documents.find(d => d.path === 'SOURCES.md').inScope);
  assert.ok(session.baseline.documents.find(d => d.path === 'ATTRIBUTION.md').inScope);
  const result = await check(root, session.baseline, deps);
  assert.equal(result.status, 'pass');
  assert.ok(!Object.keys(result.readInputs).some(p => p.startsWith('docs/diagrams/generated/')));
  assert.equal(report(root, session).exclusions.length, 4001);
  assert.throws(() => start(root, ['docs/diagrams/generated']), /范围没有/);
});

test('具名美术生成入口和manifest许可规则准确；未知audition保留；发现/实际检查数分开', async () => {
  const root = fixture({ 'README.md': '# Main\n', 'art/previews/items/catalog.html': '<a href="missing.md">generated</a>',
    'assets/audio/audition.html': '<div id="audition">unknown origin</div>',
    'assets/audio/sources/kenney_impact-sounds-License.txt': 'License',
    'assets/audio/sources/kenney_interface-sounds-License.txt': 'License' });
  const session = start(root);
  const catalog = session.baseline.documents.find(d => d.path === 'art/previews/items/catalog.html');
  assert.equal(catalog.kind, 'generated'); assert.equal(catalog.owner, 'art/scripts/compose_item_catalog.py');
  assert.equal(session.baseline.documents.find(d => d.path === 'assets/audio/audition.html').kind, 'unclassified');
  assert.equal(session.baseline.documents.filter(d => d.requiredReview === false).length, 3);
  const result = await check(root, session.baseline, deps);
  assert.equal(result.status, 'pass'); assert.equal(result.discoveredDocuments, 5); assert.equal(result.parsedDocuments, 2);
  assert.equal(result.checkedDocuments, 2); assert.equal(result.scannedDocuments, 2);
});

test('linked worktree、其他cwd、空格中文CLI与只读check不写session', async () => {
  const original = fixture(), linked = `${original}-linked`;
  trustFixture(linked);
  git(original, ['worktree', 'add', '-q', '-b', 'test-linked', linked]);
  const created = await cli(['init', '--workspace', linked, '--scope', 'README.md'], home);
  assert.equal(created.code, 0);
  const session = loadSession(linked, created.json.session);
  assert.notEqual(session.baseline.gitDir, session.baseline.commonDir);
  const before = Object.fromEntries(fs.readdirSync(session.directory).map(name => [name, hash(fs.readFileSync(path.join(session.directory, name)))]));
  assert.equal((await cli(['check', '--workspace', linked, '--session', session.baseline.id], home)).code, 0);
  const after = Object.fromEntries(fs.readdirSync(session.directory).map(name => [name, hash(fs.readFileSync(path.join(session.directory, name)))]));
  assert.deepEqual(after, before);
  assert.equal((await cli(['report', '--workspace', linked, '--session', session.baseline.id, '--require-complete'], home)).code, 1);
  assert.equal((await cli(['report', '--workspace', original, '--session', session.directory], home)).code, 2);
});

test('base迁移需新会话，不能沿用旧事件；未知参数为2', async () => {
  const root = fixture(), first = start(root, ['README.md']);
  write(root, 'README.md', '# B\n'); commit(root, 'next');
  const next = start(root, ['README.md']);
  assert.notEqual(first.baseline.base, next.baseline.base);
  assert.equal(next.events.length, 0);
  assert.equal((await cli(['report', '--workspace', root, '--session', first.baseline.id, '--base', 'HEAD'])).code, 2);
});

test('显式base分支推进使机械与内容过期，默认冻结HEAD仍允许空提交', async () => {
  const root = fixture(); git(root, ['branch', 'comparison-base']);
  const session = start(root, ['README.md'], 'comparison-base');
  await add(root, session, assignment('reader')); await add(root, session, review('reader'));
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  commit(root, 'pure commit'); git(root, ['branch', '-f', 'comparison-base', 'HEAD']);
  const result = report(root, loadSession(root, session.baseline.id));
  assert.equal(result.mechanical.status, 'stale');
  assert.equal(result.coverage[0].status, 'pending');
  assert.equal(result.comparisonBase.status, 'moved');
  await assert.rejects(add(root, session, review('reader')), /基点已迁移/);
  assert.ok((await check(root, session.baseline, deps)).problems.some(p => p.code === 'base_moved'));
});

test('frontmatter后的Markdown/HTML错误行号指向原文', async () => {
  const root = fixture({ 'README.md': '# Main\n', 's/SKILL.md': '---\nname: s\ndescription: valid\n---\n\n# Title\n\n[link](missing.md)\n\n<a href="other-missing.md">bad</a>\n' });
  const result = await check(root, start(root).baseline, deps);
  assert.equal(result.problems.find(p => p.url === 'missing.md').line, 8);
  assert.equal(result.problems.find(p => p.url === 'other-missing.md').line, 10);
});

test('links角色可回收委派，但不能充当内容审查', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await add(root, session, { ...assignment('links', 'links'), type: 'delegation' });
  await add(root, session, review('links', 'return'));
  assert.equal(report(root, loadSession(root, session.baseline.id)).coverage[0].status, 'pending');
});

test('独立终审return按角色完成覆盖，历史编辑者不能通过return绕过独立性', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await add(root, session, { ...assignment('reviewer'), type: 'delegation' });
  await add(root, session, review('reviewer', 'return'));
  await add(root, session, { ...assignment('final', 'independent_reviewer'), type: 'delegation' });
  await add(root, session, review('final', 'return'));
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, true);
  await assert.rejects(add(root, session, assignment('final', 'editor')), /独立终审者/);
  await add(root, session, { ...assignment('conflict', 'independent_reviewer'), type: 'delegation' });
  await add(root, session, assignment('conflict', 'editor'));
  await assert.rejects(add(root, session, review('conflict', 'return')), /参与过编辑/);
});

test('手工全排除仍需异于决策者且在排除之后的独立确认', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await add(root, session, assignment('decider', 'independent_reviewer'));
  await add(root, session, review('decider', 'independent_review'));
  await add(root, session, assignment('final', 'independent_reviewer'));
  await add(root, session, review('final', 'independent_review'));
  await add(root, session, { type: 'exclusion', actor: 'decider', scope: ['README.md'], evidence: evidence(), reason: '明确不属于本轮内容范围' });
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, false);
  await add(root, session, review('decider', 'independent_review'));
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, false);
  await add(root, session, review('final', 'independent_review'));
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, true);
});

test('未解决unverified发现阻塞strict，具名确认resolved后可完成；建议不阻塞', async () => {
  const root = fixture(), session = start(root, ['README.md']);
  await add(root, session, assignment('reader'));
  await add(root, session, { ...review('reader'), result: 'findings', findings: [{ severity: 'unverified', message: '本地事实尚需确认' }] });
  await add(root, session, assignment('final', 'independent_reviewer'));
  await add(root, session, review('final', 'independent_review'));
  await withLock(root, session.baseline.id, async s => append(s, { type: 'mechanical', result: await check(root, s.baseline, deps) }));
  let result = report(root, loadSession(root, session.baseline.id));
  assert.equal(result.complete, false); assert.equal(result.content.status, 'unverified'); assert.equal(result.unresolvedUnverified.length, 1);
  await add(root, session, { ...review('reader'), result: 'findings', findings: [{ severity: 'unverified', message: '本地事实已由所列依据确认', resolved: true }] });
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, true);
  await add(root, session, { ...review('reader'), result: 'findings', findings: [{ severity: 'suggestion', message: '可选表达改进' }] });
  assert.equal(report(root, loadSession(root, session.baseline.id)).complete, true);
});

test('PowerShell从其他cwd调用，恢复cwd与npm cache', () => {
  const root = fixture();
  const script = path.join(defaultWorkspace, 'scripts/check-docs.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const code = `$env:npm_config_cache='original-cache'; $before=(Get-Location).Path; & ${quote(script)} init --workspace ${quote(root)} --scope README.md; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if ((Get-Location).Path -ne $before -or $env:npm_config_cache -ne 'original-cache') { exit 9 }`;
  const output = execFileSync('pwsh', ['-NoProfile', '-Command', code], { cwd: home, encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(output).command, 'init');
});

test('PowerShell低Node版本、入口缺参、依赖缺失均输出单个错误JSON并恢复环境', () => {
  const root = fixture(), script = path.join(defaultWorkspace, 'scripts/check-docs.ps1');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const probe = (target, args, prefix = '') => {
    const code = `$env:npm_config_cache='original-cache'; $before=(Get-Location).Path; $encodingBefore=[Console]::OutputEncoding.WebName; $pipelineBefore=$OutputEncoding.WebName; ${prefix}; $payload = & ${quote(target)} ${args}; $code = $LASTEXITCODE; @{payload=($payload -join [Environment]::NewLine); code=$code; sameLocation=((Get-Location).Path -eq $before); sameCache=($env:npm_config_cache -eq 'original-cache'); sameEncoding=([Console]::OutputEncoding.WebName -eq $encodingBefore -and $OutputEncoding.WebName -eq $pipelineBefore)} | ConvertTo-Json -Compress -EscapeHandling EscapeNonAscii`;
    return JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command', code], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  const checkError = result => {
    assert.equal(result.code, 2); assert.equal(result.sameLocation, true); assert.equal(result.sameCache, true); assert.equal(result.sameEncoding, true);
    const json = JSON.parse(result.payload); assert.equal(json.schemaVersion, 1); assert.equal(typeof json.error, 'string'); return json;
  };
  checkError(probe(script, ''));
  if (process.platform === 'win32') {
    write(root, 'fake-node/node.cmd', '@echo off\r\necho 20.0.0\r\nexit /b 0\r\n');
    const json = checkError(probe(script, 'init', `$env:PATH=${quote(path.join(root, 'fake-node'))}+[IO.Path]::PathSeparator+$env:PATH`));
    assert.match(json.error, /22\.13/);
    const environment = { ...process.env }, pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path');
    environment[pathKey] = path.join(root, 'fake-node') + path.delimiter + environment[pathKey];
    const direct = spawnSync('pwsh', ['-NoProfile', '-File', script, 'init'], { env: environment, cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(direct.status, 2); assert.ok(!direct.stdout.includes('\uFFFD')); assert.ok(!direct.stderr.includes('\uFFFD'));
    assert.match(JSON.parse(direct.stdout).error, /需要 Node.js/); assert.match(direct.stderr, /需要 Node.js/);
  }
  for (const name of fs.readdirSync(toolDirectory).filter(p => /\.(mjs|json)$/.test(p))) write(root, `tools/review-docs/${name}`, fs.readFileSync(path.join(toolDirectory, name)));
  write(root, 'scripts/check-docs.ps1', fs.readFileSync(script));
  const missing = checkError(probe(path.join(root, 'scripts/check-docs.ps1'), 'init'));
  assert.match(missing.error, /依赖缺失|锁文件/);
});
