// 从本次提交的索引快照生成架构图；校验通过后只暂存六份产物，临时文件留在根 tmp/。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(filename), '../..');
const diagramDirectory = 'docs/diagrams';
const outputs = ['ecs-architecture.html', 'ecs-source.html', 'ecs-overview.svg',
  'ecs-schedules.svg', 'ecs-relationships.svg', 'ecs-events.svg'];
const inputs = ['ecs-data.json', 'build-ecs.mjs', 'source-viewer.mjs', 'check-ecs.mjs', 'diagram-geometry.mjs'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizedText = value => value.toString('utf8').replaceAll('\r\n', '\n');
function runGit(root, args, { allowFailure = false, input } = {}) {
  // 保留 Git 提供的活动索引，包括部分路径提交所用的临时索引与提交后的真实索引。
  const result = spawnSync('git', args, { cwd: root, input, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`git failed: ${result.error?.message || result.stderr.toString('utf8')}`);
  }
  return result;
}
function pendingFile(root, invocation) {
  if (!/^[0-9]+-[0-9]+$/.test(invocation)) throw new Error('Invalid Git invocation identifier.');
  return path.join(root, 'tmp/git-hooks/architecture', `pending-${invocation}.json`);
}

/** 提交前只渲染暂存清单；架构语义、布局与源码入口仍需由 Agent 核对并暂存。 */
export function generateBeforeCommit(root = defaultRoot, invocation = null) {
  root = path.resolve(root);
  const git = (args, options) => runGit(root, args, options);
  const pending = invocation ? pendingFile(root, invocation) : null;
  const head = () => {
    const result = git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
    return result.status === 0 ? result.stdout.toString('utf8').trim() : null;
  };
  const baseCommit = head();
  const indexTree = git(['write-tree']).stdout.toString('utf8').trim();
  const entries = tree(indexTree);
  const previousEntries = baseCommit ? tree(baseCommit) : [];
  const modelPath = `${diagramDirectory}/ecs-data.json`;
  const modelEntry = entries.find(entry => entry.file === modelPath);
  // 首次安装图工具前允许独立提交源码；部分引入或删除已安装清单仍交给下方校验阻止。
  if (!modelEntry && !entries.some(entry => entry.file === diagramDirectory || entry.file.startsWith(`${diagramDirectory}/`))
    && !previousEntries.some(entry => entry.file === modelPath)) {
    return { status: 'architecture_not_installed', index_tree: indexTree, base_commit: baseCommit };
  }
  const runDirectory = path.join(root, 'tmp/git-hooks/architecture', `${indexTree}-${Date.now()}-${process.pid}`);
  const snapshot = path.join(runDirectory, 'snapshot');
  const reportFile = path.join(runDirectory, 'run.json');
  const report = { index_tree: indexTree, base_commit: baseCommit, invocation_id: invocation, status: 'generating',
    snapshot: path.relative(root, snapshot).replaceAll('\\', '/') };
  fs.mkdirSync(snapshot, { recursive: true });
  function saveReport() { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); }
  function worktreeFile(name) {
    const file = path.join(root, diagramDirectory, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    // 工作区的链接或其他非普通文件保留，不把生成结果写到链接目标。
    if (!stat.isFile()) return { kind: 'other' };
    const bytes = fs.readFileSync(file);
    return { kind: 'file', bytes, fingerprint: hash(bytes) };
  }
  const originalOutputs = new Map(outputs.map(name => [name, worktreeFile(name)]));
  function tree(revision) {
    return git(['ls-tree', '-r', '-z', revision]).stdout.toString('utf8').split('\0').filter(Boolean).map(entry => {
      const separator = entry.indexOf('\t');
      const [mode, type, object] = entry.slice(0, separator).split(' ');
      return { mode, type, object, file: entry.slice(separator + 1) };
    });
  }
  function blob(entry) { return git(['cat-file', 'blob', entry.object]).stdout; }
  function exportFile(entry, directory) {
    // 不跟随链接；导出的文件路径必须留在本次临时快照中。
    const destination = path.resolve(directory, entry.file);
    const relative = path.relative(directory, destination);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new Error(`Unsafe snapshot entry: ${entry.file}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, blob(entry));
  }
  try {
    if (!modelEntry) throw new Error('Staged ecs-data.json is missing. Stage the diagram model and generators before committing.');
    const model = JSON.parse(blob(modelEntry).toString('utf8'));
    const sourcePaths = new Set(['src/main.rs']);
    function collectSources(value) {
      if (!value || typeof value !== 'object') return;
      if (value.source?.path) sourcePaths.add(value.source.path);
      for (const [key, child] of Object.entries(value)) if (key !== 'source') collectSources(child);
    }
    collectSources(model);
    const required = new Set([...sourcePaths, ...inputs.map(name => `${diagramDirectory}/${name}`)]);
    for (const file of required) {
      const entry = entries.find(entry => entry.file === file);
      if (!entry) throw new Error(`Missing staged architecture input: ${file}`);
      exportFile(entry, snapshot);
    }
    // 生成器还可能引用清单外的源码；保持候选提交中的源码树供生成器使用。
    for (const entry of entries) {
      if (entry.file.startsWith('src/') && !required.has(entry.file)) exportFile(entry, snapshot);
    }
    const previous = new Set([...outputs, ...inputs].map(name => `${diagramDirectory}/${name}`));
    for (const entry of previousEntries) if (previous.has(entry.file)) exportFile(entry, path.join(runDirectory, 'before'));
    const baseTree = baseCommit || git(['hash-object', '-t', 'tree', '--stdin'], { input: Buffer.alloc(0) }).stdout.toString('utf8').trim();
    fs.writeFileSync(path.join(runDirectory, 'commit.patch'),
      git(['diff', '--binary', baseTree, indexTree, '--', '.', ':!art', ':!assets']).stdout);

    // 快照内的生成器不继承仓库索引变量，避免其误读主仓库的未提交状态。
    const generationEnvironment = { ...process.env };
    for (const variable of git(['rev-parse', '--local-env-vars']).stdout.toString('utf8').trim().split('\n')) {
      delete generationEnvironment[variable];
    }
    function runScript(name, logName, label) {
      const result = spawnSync(process.execPath, [path.join(snapshot, diagramDirectory, name)],
        { cwd: snapshot, env: generationEnvironment, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      fs.writeFileSync(path.join(runDirectory, logName), (result.stdout || '') + (result.stderr || ''));
      if (result.error || result.status !== 0) throw new Error(`Architecture ${label} failed: ${result.error?.message || result.stderr || result.stdout}`);
      return result.stdout;
    }
    runScript('build-ecs.mjs', 'generation.log', 'generation');
    const validation = JSON.parse(runScript('check-ecs.mjs', 'validation.log', 'validation'));
    const generated = outputs.map(name => ({ name, bytes: fs.readFileSync(path.join(snapshot, diagramDirectory, name)) }));

    // 所有产物先生成、校验；索引仍为原候选树时才一次性写入精确的生成内容。
    const generatedEntries = generated.map(({ name, bytes }) => {
      const object = git(['hash-object', '-w', '--stdin'], { input: bytes }).stdout.toString('utf8').trim();
      return { file: `${diagramDirectory}/${name}`, object };
    });
    const indexInfo = generatedEntries.map(({ file, object }) => `100644 ${object}\t${file}\0`).join('');
    if (head() !== baseCommit || git(['write-tree']).stdout.toString('utf8').trim() !== indexTree) {
      throw new Error('HEAD or the active index changed during architecture generation; retry the commit.');
    }
    git(['update-index', '-z', '--index-info'], { input: Buffer.from(indexInfo) });
    report.generated_tree = git(['write-tree']).stdout.toString('utf8').trim();

    // 只同步未手改的工作区产物；并发编辑同样保留，提交里的版本始终来自快照。
    const preserved = [];
    for (const { name, bytes } of generated) {
      const original = originalOutputs.get(name);
      const current = worktreeFile(name);
      const file = `${diagramDirectory}/${name}`;
      const indexed = entries.find(entry => entry.file === file);
      const committed = previousEntries.find(entry => entry.file === file);
      const matches = entry => entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode)
        && normalizedText(original.bytes) === normalizedText(blob(entry));
      const unchanged = original === null ? current === null
        : original.kind === 'file' && current?.kind === 'file' && original.fingerprint === current.fingerprint;
      if (unchanged && (original === null || matches(indexed) || matches(committed))) {
        try {
          fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
          fs.writeFileSync(path.join(root, file), bytes);
        } catch (error) {
          preserved.push(file);
          process.stderr.write(`Architecture output staged but worktree synchronization failed: ${file}: ${error.message}\n`);
        }
      } else preserved.push(file);
    }
    report.status = 'staged';
    report.validation = validation;
    report.staged_outputs = outputs.map(name => `${diagramDirectory}/${name}`);
    report.preserved_worktree_outputs = preserved;
    saveReport();
    // 记录同次 Git 调用的候选树。提交后仅对齐索引，不再运行生成器。
    if (pending) fs.writeFileSync(pending, JSON.stringify({ generated_tree: report.generated_tree,
      report_file: path.relative(root, reportFile).replaceAll('\\', '/'), entries: generatedEntries }, null, 2) + '\n');
    if (preserved.length) process.stderr.write(`Architecture outputs staged; preserved worktree files: ${preserved.join(', ')}\n`);
    return { status: 'architecture_staged', index_tree: indexTree, ...validation, preserved_worktree_outputs: preserved };
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    saveReport();
    throw new Error(`Architecture pre-commit failed: ${error.message}\nDetails: ${reportFile}\nRetry after staging corrected inputs: powershell -NoProfile -File .codex/hooks/architecture-hook.ps1 pre-commit`);
  }
}

/** 指定路径提交会保留另一份索引；提交后用 Git 提供的真实索引对齐产物，不猜测锁文件。 */
export function synchronizeCommittedIndex(root = defaultRoot, invocation = null) {
  root = path.resolve(root);
  const pending = invocation ? pendingFile(root, invocation) : null;
  if (!pending || !fs.existsSync(pending)) return { status: 'architecture_index_sync_skipped' };
  const receipt = JSON.parse(fs.readFileSync(pending, 'utf8'));
  const git = (args, options) => runGit(root, args, options);
  const reportFile = path.resolve(root, receipt.report_file);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  try {
    const committedTree = git(['rev-parse', 'HEAD^{tree}']).stdout.toString('utf8').trim();
    if (committedTree !== receipt.generated_tree) {
      // 失败或被其他 Hook 改写的候选树不用于后续提交的索引同步。
      fs.unlinkSync(pending);
      return { status: 'architecture_index_sync_skipped' };
    }
    const indexed = git(['ls-files', '--stage', '-z', '--', ...outputs.map(name => `${diagramDirectory}/${name}`)])
      .stdout.toString('utf8').split('\0');
    const updates = receipt.entries.filter(({ file, object }) => !indexed.includes(`100644 ${object} 0\t${file}`));
    if (updates.length) {
      const info = updates.map(({ file, object }) => `100644 ${object}\t${file}\0`).join('');
      git(['update-index', '-z', '--index-info'], { input: Buffer.from(info) });
    }
    report.commit = git(['rev-parse', 'HEAD']).stdout.toString('utf8').trim();
    report.index_sync = updates.length ? 'synchronized' : 'current';
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    fs.unlinkSync(pending);
    return { status: 'architecture_index_synchronized', updated_outputs: updates.map(entry => entry.file) };
  } catch (error) {
    report.index_sync = 'failed';
    report.index_sync_error = error.message;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    throw new Error(`Commit is saved, but architecture index synchronization failed: ${error.message}\nDetails: ${reportFile}\nRetry: powershell -NoProfile -File .codex/hooks/architecture-hook.ps1 synchronize-index ${invocation}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  // 已加载的旧对话 Hook 在配置重载前可能仍调用此文件；无参数调用不生成。
  if (!process.argv[2]) {
    process.stdout.write('{}\n');
  } else {
    try {
      const operation = process.argv[2];
      if (!['pre-commit', 'synchronize-index'].includes(operation)) throw new Error(`Unknown operation: ${operation}`);
      const result = operation === 'pre-commit' ? generateBeforeCommit(defaultRoot, process.argv[3])
        : synchronizeCommittedIndex(defaultRoot, process.argv[3]);
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    }
  }
}
