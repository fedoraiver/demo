// 在根 tmp/ 的隔离仓库中实际提交，验证 Git Hook；不修改主仓库提交或启动游戏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const names = ['ecs-architecture.html', 'ecs-source.html', 'ecs-overview.svg', 'ecs-schedules.svg', 'ecs-relationships.svg', 'ecs-events.svg'];
const outputPaths = names.map(name => `docs/diagrams/${name}`);
function fixture({ withoutOutputs = false, withoutStagedDiagrams = false } = {}) {
  const parent = path.join(root, 'tmp/git-hooks/tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'pre-commit-'));
  for (const name of ['src', 'docs/diagrams', '.codex/hooks', '.githooks']) {
    fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  if (withoutOutputs) for (const file of outputPaths) fs.unlinkSync(path.join(directory, file));
  fs.writeFileSync(path.join(directory, '.gitignore'), 'tmp/\nart/\nassets/\n');
  const gitConfig = path.join(directory, 'tmp/git-test.config');
  fs.mkdirSync(path.dirname(gitConfig), { recursive: true });
  fs.writeFileSync(gitConfig, `[safe]\n\tdirectory = ${directory.replaceAll('\\', '/')}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Hook Test', GIT_AUTHOR_EMAIL: 'hook-test@example.invalid',
    GIT_COMMITTER_NAME: 'Hook Test', GIT_COMMITTER_EMAIL: 'hook-test@example.invalid' };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  }
  function git(args, expected = 0, cwd = directory, extraEnv = {}) {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, expected, result.stderr + result.stdout);
    return result;
  }
  git(['init', '--quiet', '--template=']);
  fs.chmodSync(path.join(directory, '.githooks/pre-commit'), 0o755);
  fs.chmodSync(path.join(directory, '.githooks/post-commit'), 0o755);
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  git(['add', '.', ...(withoutStagedDiagrams ? [':!docs/diagrams'] : [])]);
  const commit = (title, args = [], expected = 0) => git(['commit', '--quiet',
    '-m', `test: ${title}`, '-m', '验证架构图 Git Hook 的隔离回归。', ...args], expected);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), text);
  };
  const read = file => fs.readFileSync(path.join(directory, file), 'utf8');
  const append = (file, text) => fs.appendFileSync(path.join(directory, file), text);
  const show = file => git(['show', `HEAD:${file}`]).stdout;
  const reports = () => {
    const runs = path.join(directory, 'tmp/git-hooks/architecture');
    return fs.existsSync(runs) ? fs.readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(run => JSON.parse(fs.readFileSync(path.join(runs, run.name, 'run.json'), 'utf8'))) : [];
  };
  return { directory, git, commit, write, read, append, show, reports, env };
}
function sourceText(html, file) {
  const sources = JSON.parse(html.match(/<script id="sources" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  return sources.find(source => source.path === file).text;
}
function assertCommittedOutputs(f) {
  for (const file of outputPaths) assert.equal(f.git(['rev-parse', `HEAD:${file}`]).stdout, f.git(['rev-parse', `:${file}`]).stdout, file);
}

test('commits before architecture installation leave the index and unstaged artifacts unchanged', () => {
  const f = fixture({ withoutStagedDiagrams: true });
  const originalOutputs = outputPaths.map(f.read);
  for (const [index, title] of ['uninstalled initial snapshot', 'uninstalled source snapshot'].entries()) {
    if (index > 0) {
      f.append('src/input.rs', '\n// source update before architecture installation\n');
      f.git(['add', 'src/input.rs']);
    }
    const tree = f.git(['write-tree']).stdout;
    const result = f.commit(title);
    assert.match(result.stdout + result.stderr, /architecture_not_installed/);
    assert.equal(f.git(['write-tree']).stdout, tree);
    assert.equal(f.git(['rev-parse', 'HEAD^{tree}']).stdout, tree);
    assert.equal(f.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/diagrams']).stdout, '');
    assert.deepEqual(outputPaths.map(f.read), originalOutputs);
    assert.equal(fs.existsSync(path.join(f.directory, 'tmp/git-hooks/architecture')), false);
  }
});

test('partial first architecture installation without a model blocks the commit', () => {
  const f = fixture({ withoutStagedDiagrams: true });
  f.git(['add', 'docs/diagrams/README.md']);
  const tree = f.git(['write-tree']).stdout;
  const originalOutputs = outputPaths.map(f.read);
  const result = f.commit('incomplete initial architecture', [], 1);
  assert.match(result.stderr, /Staged ecs-data.json is missing/);
  assert.equal(f.git(['write-tree']).stdout, tree);
  f.git(['rev-parse', '--verify', '-q', 'HEAD'], 1);
  assert.deepEqual(outputPaths.map(f.read), originalOutputs);
  assert.equal(f.reports().length, 1);
  assert.equal(f.reports()[0].status, 'failed');
});

test('removing an installed model blocks the commit even when all diagrams are removed from the index', () => {
  const f = fixture();
  f.commit('installed architecture snapshot');
  const originalHead = f.git(['rev-parse', 'HEAD']).stdout;
  const originalOutputs = outputPaths.map(f.read);
  f.git(['rm', '--cached', '-r', 'docs/diagrams']);
  const tree = f.git(['write-tree']).stdout;
  const result = f.commit('removed installed architecture', [], 1);
  assert.match(result.stderr, /Staged ecs-data.json is missing/);
  assert.equal(f.git(['rev-parse', 'HEAD']).stdout, originalHead);
  assert.equal(f.git(['write-tree']).stdout, tree);
  assert.deepEqual(outputPaths.map(f.read), originalOutputs);
  assert.equal(f.reports().filter(report => report.status === 'failed').length, 1);
});

test('initial commit adds all six outputs; empty commits and amend regenerate before committing', () => {
  const f = fixture({ withoutOutputs: true });
  assert.equal(f.git(['ls-files', '--', ...outputPaths]).stdout, '');
  f.commit('initial snapshot');
  assert.equal(f.reports().length, 1);
  assert.equal(f.reports()[0].status, 'staged');
  assert.equal(f.reports()[0].base_commit, null);
  assert.equal(f.reports()[0].staged_outputs.length, 6);
  assertCommittedOutputs(f);
  f.commit('empty snapshot', ['--allow-empty']);
  f.append('src/input.rs', '\n// amended source snapshot\n');
  f.git(['add', 'src/input.rs']);
  f.commit('amended snapshot', ['--amend']);
  assert.equal(f.reports().length, 3);
  assert.equal(f.git(['rev-list', '--count', 'HEAD']).stdout.trim(), '2');
  assert.match(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs'), /amended source snapshot/);
  assertCommittedOutputs(f);
});

test('partially staged source is captured without unstaged model, generator or source edits', () => {
  const f = fixture();
  f.commit('initial snapshot');
  f.append('src/input.rs', '\n// staged input comment\n');
  f.git(['add', 'src/input.rs']);
  const selected = f.git(['rev-parse', ':src/input.rs']).stdout;
  f.append('src/input.rs', '// unstaged input comment\n');
  f.write('docs/diagrams/ecs-data.json', 'invalid unstaged JSON');
  f.write('docs/diagrams/check-ecs.mjs', 'throw new Error("unstaged validator must not run");\n');
  f.write('docs/diagrams/build-ecs.mjs', 'throw new Error("unstaged generator must not run");\n');
  f.write('unrelated.txt', 'untracked user file\n');
  f.commit('selected source snapshot');
  assert.equal(f.git(['rev-parse', 'HEAD:src/input.rs']).stdout, selected);
  const shown = sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs');
  assert.match(shown, /staged input comment/);
  assert.doesNotMatch(shown, /unstaged input comment/);
  assert.match(f.read('src/input.rs'), /unstaged input comment/);
  assert.equal(f.read('docs/diagrams/ecs-data.json'), 'invalid unstaged JSON');
  assert.equal(f.git(['ls-files', 'unrelated.txt']).stdout, '');
  assertCommittedOutputs(f);
  assert.equal(f.git(['diff', '--cached', '--name-only']).stdout, '');
});

test('commit -a includes its tracked source and generated artifacts but excludes untracked files', () => {
  const f = fixture();
  f.commit('initial snapshot');
  f.append('src/input.rs', '\n// automatic tracked source snapshot\n');
  f.write('unrelated.txt', 'untracked user file\n');
  f.commit('automatic tracked snapshot', ['-a']);
  assert.match(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs'), /automatic tracked source snapshot/);
  assert.equal(f.git(['ls-files', 'unrelated.txt']).stdout, '');
  assertCommittedOutputs(f);
  assert.equal(f.git(['diff', '--cached', '--name-only']).stdout, '');
});

test('path-limited commits and amend-only retain other staged files without reverting diagrams in the index', () => {
  const f = fixture();
  f.commit('initial snapshot');
  f.append('src/camera.rs', '\n// unrelated staged camera change\n');
  f.git(['add', 'src/camera.rs']);
  const unrelated = f.git(['rev-parse', ':src/camera.rs']).stdout;
  f.append('src/input.rs', '\n// only selected input snapshot\n');
  f.commit('only source snapshot', ['--only', '--', 'src/input.rs']);
  // Git 的候选提交与提交后保存的索引都必须包含产物，其他暂存文件不应被提交或丢失。
  assert.match(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs'), /only selected input snapshot/);
  assert.doesNotMatch(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/camera.rs'), /unrelated staged camera change/);
  assert.equal(f.git(['rev-parse', ':src/camera.rs']).stdout, unrelated);
  assertCommittedOutputs(f);
  assert.equal(f.git(['diff', '--cached', '--name-only']).stdout.trim(), 'src/camera.rs');
  f.append('src/input.rs', '// default path selection snapshot\n');
  f.commit('default selected snapshot', ['--', 'src/input.rs']);
  assert.match(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs'), /default path selection snapshot/);
  assertCommittedOutputs(f);
  f.commit('amend only snapshot', ['--amend', '--only']);
  assert.equal(f.git(['diff', '--cached', '--name-only']).stdout.trim(), 'src/camera.rs');
  assert.equal(f.git(['rev-parse', ':src/camera.rs']).stdout, unrelated);
  assertCommittedOutputs(f);
});

test('generation and validation failures block commits without changing the index or outputs', () => {
  const f = fixture();
  f.commit('initial snapshot');
  const head = f.git(['rev-parse', 'HEAD']).stdout;
  const previous = outputPaths.map(f.read);
  for (const [file, message] of [['build-ecs.mjs', 'fixture rendering failure'], ['check-ecs.mjs', 'fixture validation failure']]) {
    const input = `docs/diagrams/${file}`;
    f.write(input, `throw new Error(${JSON.stringify(message)});\n`);
    f.git(['add', input]);
    const originalTree = f.git(['write-tree']).stdout;
    const result = f.commit('rejected architecture snapshot', [], 1);
    assert.match(result.stderr, /Architecture pre-commit failed/);
    assert.ok(result.stderr.includes(message));
    assert.equal(f.git(['rev-parse', 'HEAD']).stdout, head);
    assert.equal(f.git(['write-tree']).stdout, originalTree);
    assert.deepEqual(outputPaths.map(f.read), previous);
    f.write(input, f.show(input));
    f.git(['add', input]);
  }
  assert.equal(f.reports().filter(report => report.status === 'failed').length, 2);
});

test('manually edited worktree output is preserved while the validated generated version is committed', () => {
  const f = fixture();
  f.commit('initial snapshot');
  f.append('src/input.rs', '\n// source for preserved output test\n');
  f.git(['add', 'src/input.rs']);
  const output = 'docs/diagrams/ecs-source.html';
  f.append(output, '\n<!-- manual user output edit -->\n');
  const manual = f.read(output);
  const result = f.commit('preserved output snapshot');
  assert.match(result.stderr, /preserved worktree files: docs\/diagrams\/ecs-source.html/);
  assert.equal(f.read(output), manual);
  assert.doesNotMatch(f.show(output), /manual user output edit/);
  assert.match(sourceText(f.show(output), 'src/input.rs'), /source for preserved output test/);
  assertCommittedOutputs(f);
  assert.ok(f.reports().some(report => report.preserved_worktree_outputs?.includes(output)));
});

test('commits from a repository subdirectory invoke the root pre-commit hook', () => {
  const f = fixture();
  f.git(['commit', '--quiet', '-m', 'test: subdirectory commit', '-m', '验证子目录中的提交。'], 0, path.join(f.directory, 'src'));
  assert.equal(f.reports().length, 1);
  assert.equal(f.reports()[0].status, 'staged');
  assertCommittedOutputs(f);
});

test('custom-index partial commits synchronize their own index and leave unrelated default locks untouched', () => {
  const f = fixture();
  f.commit('initial snapshot');
  const originalHead = f.git(['rev-parse', 'HEAD']).stdout;
  const originalIndex = fs.readFileSync(path.join(f.directory, '.git/index'));
  const defaultLock = path.join(f.directory, '.git/index.lock');
  fs.writeFileSync(defaultLock, originalIndex);
  const customIndex = path.join(f.directory, 'tmp/custom-index');
  fs.copyFileSync(path.join(f.directory, '.git/index'), customIndex);
  const extraEnv = { GIT_INDEX_FILE: customIndex };
  f.append('src/input.rs', '\n// selected custom index input\n');
  f.git(['add', 'src/input.rs'], 0, f.directory, extraEnv);
  f.git(['commit', '--quiet', '--only', '-m', 'test: custom partial snapshot', '-m', '验证自定义索引与其他操作锁隔离。', '--', 'src/input.rs'], 0, f.directory, extraEnv);
  assert.notEqual(f.git(['rev-parse', 'HEAD']).stdout, originalHead);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, '.git/index')), originalIndex);
  assert.deepEqual(fs.readFileSync(defaultLock), originalIndex);
  for (const file of outputPaths) {
    assert.equal(f.git(['rev-parse', `HEAD:${file}`]).stdout, f.git(['rev-parse', `:${file}`], 0, f.directory, extraEnv).stdout, file);
  }
  assert.match(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs'), /selected custom index input/);
  assert.equal(f.git(['diff', '--cached', '--name-only'], 0, f.directory, extraEnv).stdout, '');
});

test('no-verify skips generation and index synchronization; an unrelated retry token changes nothing', () => {
  const f = fixture();
  f.commit('initial snapshot');
  f.write('docs/diagrams/build-ecs.mjs', 'throw new Error("bypassed generator must not run");\n');
  f.git(['add', 'docs/diagrams/build-ecs.mjs']);
  const tree = f.git(['write-tree']).stdout.trim();
  f.commit('bypassed generation', ['--no-verify']);
  assert.equal(f.git(['rev-parse', 'HEAD^{tree}']).stdout.trim(), tree);
  assert.equal(f.reports().length, 1);
  f.append('docs/diagrams/ecs-source.html', '\n<!-- staged manual output -->\n');
  f.git(['add', 'docs/diagrams/ecs-source.html']);
  const selected = f.git(['write-tree']).stdout;
  const result = spawnSync(process.execPath, [path.join(f.directory, '.codex/hooks/architecture-hook.mjs'),
    'synchronize-index', '99999999-99999999'], { cwd: f.directory, env: f.env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /architecture_index_sync_skipped/);
  assert.equal(f.git(['write-tree']).stdout, selected);
});

test('a post-commit index failure leaves the commit intact and can retry its own pending receipt', () => {
  const f = fixture();
  f.commit('initial snapshot');
  f.append('src/camera.rs', '\n// retained source during retry\n');
  f.git(['add', 'src/camera.rs']);
  const retained = f.git(['rev-parse', ':src/camera.rs']).stdout;
  f.append('src/input.rs', '\n// committed source before index retry\n');
  const post = '.githooks/post-commit';
  // 只在隔离仓库中制造外部索引锁，模拟提交已写入后同步被其他操作阻止。
  f.write(post, f.read(post).replace('project_root=$(git rev-parse --show-toplevel) || exit 1',
    'project_root=$(git rev-parse --show-toplevel) || exit 1\ncp "$project_root/.git/index" "$project_root/.git/index.lock"'));
  const result = f.commit('retryable index snapshot', ['--only', '--', 'src/input.rs']);
  assert.match(result.stderr, /Commit is saved, but architecture index synchronization failed/);
  assert.match(sourceText(f.show('docs/diagrams/ecs-source.html'), 'src/input.rs'), /committed source before index retry/);
  const report = f.reports().find(item => item.index_sync === 'failed');
  assert.ok(report);
  fs.unlinkSync(path.join(f.directory, '.git/index.lock'));
  const retried = spawnSync(process.execPath, [path.join(f.directory, '.codex/hooks/architecture-hook.mjs'),
    'synchronize-index', report.invocation_id], { cwd: f.directory, env: f.env, encoding: 'utf8', windowsHide: true });
  assert.equal(retried.status, 0, retried.stderr);
  assertCommittedOutputs(f);
  assert.equal(f.git(['rev-parse', ':src/camera.rs']).stdout, retained);
  assert.equal(f.git(['diff', '--cached', '--name-only']).stdout.trim(), 'src/camera.rs');
  assert.equal(f.reports().find(item => item.invocation_id === report.invocation_id).index_sync, 'synchronized');
});
