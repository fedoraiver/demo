import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exportProducerInputs, repositoryRoot } from './maintenance-paths.mjs';
import { fileSnapshot, relevantInputNames, dependencyState, npmCommand, headMetadata, digest, processAlive, executablePath } from './maintenance-inputs.mjs';
import { atomicJson, executeMaintenanceCommand } from './maintenance-execution.mjs';
import { readModelSummary } from './maintenance-summary.mjs';
import { exportContextInputs } from './maintenance-export-context.mjs';
import { mermaidDependencyIdentity } from './mermaid-cache.mjs';

const now = () => new Date().toISOString();
const maintenanceRoot = workspace => path.join(workspace, 'tmp/ecs-architecture/maintenance');
const generated = 'docs/diagrams/generated';
const sourceRoot = repositoryRoot;
const renderedStages = new Set(['build', 'check', 'test']);
const requireWorkspace = workspace => {
  if (!workspace) throw new Error('--workspace is required');
  const resolved = fs.realpathSync(path.resolve(workspace));
  if (!fs.existsSync(path.join(resolved, 'Cargo.toml')) || !fs.existsSync(path.join(resolved, 'docs/diagrams/package.json'))) throw new Error(`Not a diagram workspace: ${resolved}`);
  return resolved;
};
const safeRunId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === '.' || value === '..') throw new Error('Invalid maintenance run ID');
  return value;
};
const loadRun = (workspace, runId) => {
  const root = maintenanceRoot(workspace);
  if (!runId) {
    if (!fs.existsSync(root)) return null;
    runId = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'state.json'))).map(entry => entry.name).sort().at(-1);
  }
  if (!runId) return null;
  const state = JSON.parse(fs.readFileSync(path.join(root, safeRunId(runId), 'state.json'), 'utf8'));
  return state;
};

async function validDump(workspace, debugdumpDirectory) {
  const { readDebugdump, DEBUGDUMP_MANIFEST } = await import('./debugdump-input.mjs');
  const directory = path.resolve(workspace, debugdumpDirectory || 'tmp/ecs-architecture/compiler/debugdump');
  const filename = directory === path.join(workspace, generated, 'dot') ? DEBUGDUMP_MANIFEST : 'manifest.json';
  try {
    const data = readDebugdump(directory, workspace, filename);
    return { valid: true, reusable: true, directory, filename, manifest: data.manifest,
      files: [path.join(directory, filename), ...data.schedules.map(entry => path.join(directory, entry.filename))] };
  } catch (error) { return { valid: false, reusable: false, directory, filename, reason: error.message }; }
}

const binaryIdentity = filename => {
  try { filename = executablePath(filename); return { path: fs.realpathSync(filename), sha256: digest(fs.readFileSync(filename)) }; }
  catch (error) { return { path: filename, error: error.message }; }
};
const toolsForRun = () => {
  let npm;
  try { npm = binaryIdentity(npmCommand().args[0]); } catch (error) { npm = { unavailable: error.message }; }
  return { node: { ...binaryIdentity(process.execPath), version: process.version, platform: process.platform, arch: process.arch }, cargo: binaryIdentity('cargo'), npm };
};
const dependencySnapshot = inputs => Object.fromEntries((inputs || []).map(input => [input.path, fs.existsSync(input.path) ? digest(fs.readFileSync(input.path)) : null]).sort(([a], [b]) => a.localeCompare(b)));
const exportProvenance = manifest => Object.fromEntries(['schemaVersion', 'bevyVersion', 'debugdumpVersion', 'sourceFingerprint', 'exportedAt', 'target', 'features', 'schedules'].map(key => [key, key === 'schedules'
  ? manifest.schedules.map(entry => Object.fromEntries(['id', 'app', 'label', 'systemCount', 'sha256'].map(field => [field, entry[field]]))) : manifest[key]]));

/** 只读计划不创建 tmp、不运行 Cargo，也不触发 npm 模块加载或安装。 */
export async function planMaintenance({ workspace, debugdumpDirectory } = {}) {
  workspace = requireWorkspace(workspace);
  const previous = loadRun(workspace);
  const selectedDump = debugdumpDirectory;
  const dependencies = dependencyState(workspace), dump = await validDump(workspace, selectedDump);
  const analysis = await compilerAnalysisState(workspace);
  const plannedStages = [
    { id: 'dependencies', action: dependencies.valid ? 'reuse' : 'install', reason: dependencies.reason },
    { id: 'extract', action: analysis.facts ? 'validate' : 'extract', reason: 'Collect rustc facts and the matching real Schedule snapshot' },
    { id: 'model', action: 'compose', reason: 'Compose the compiler semantic graph' },
    { id: 'preflight', action: 'validate' }, { id: 'build', action: 'build' }, { id: 'check', action: 'check' }, { id: 'test', action: 'full-node-tests' },
  ];
  if (previous) {
    const tools = toolsForRun(), definitions = defaultPipeline({ workspace, dump, directory: path.join(maintenanceRoot(workspace), previous.runId), dependencies });
    let invalidated = false;
    for (const stage of definitions) {
      const record = [...previous.stages].reverse().find(item => item.id === stage.id);
      let reusable = false;
      try {
        reusable = matching(record, stageInputs(workspace, stage, previous, tools), workspace);
        if (reusable && stage.validate) reusable = digest(await stage.validate()) === digest(record.validation);
      } catch { reusable = false; }
      if (!invalidated && reusable) Object.assign(plannedStages.find(item => item.id === stage.id), { action: 'reuse', sourceRunId: previous.runId });
      else invalidated = true;
    }
  }
  return { schemaVersion: 1, workspace, head: headMetadata(workspace), inputs: fileSnapshot(workspace, relevantInputNames(workspace)),
    dependencies, debugdump: dump, analysis,
    dependencyInputs: previous?.dependencyInputs || [],
    stages: plannedStages };
}

async function compilerAnalysisState(workspace) {
  const directory = path.join(workspace, 'tmp/ecs-architecture/compiler');
  const facts = path.join(directory, 'facts.json'), runtime = path.join(directory, 'runtime.json'), model = path.join(directory, 'model.json');
  const result = { directory, facts: fs.existsSync(facts) && fs.existsSync(runtime), model: false };
  if (fs.existsSync(model)) {
    try {
      const { readCompilerModel } = await import('./rustc-model.mjs');
      const value = readCompilerModel(workspace).model;
      result.model = value.schemaVersion === 2;
    } catch (error) { result.reason = error.message; }
  }
  return result;
}

function defaultPipeline({ workspace, dependencies }) {
  const cli = path.join(workspace, 'docs/diagrams/maintain.mjs');
  const compilerDirectory = path.join(workspace, 'tmp/ecs-architecture/compiler');
  const exportDirectory = path.join(compilerDirectory, 'debugdump');
  const facts = path.join(compilerDirectory, 'facts.json'), runtime = path.join(compilerDirectory, 'runtime.json'), model = path.join(compilerDirectory, 'model.json');
  const inputs = relevantInputNames(workspace);
  const node = (filename, args = []) => ({ command: process.execPath, args: [filename, ...args] });
  const analysis = args => ({ command: 'pwsh', args: ['-NoProfile', '-File', path.join(workspace, 'scripts/rustc-analysis.ps1'), ...args] });
  const compilerInputs = ['Cargo.toml', 'Cargo.lock', 'src', 'tools/rustc-analysis/Cargo.toml', 'tools/rustc-analysis/Cargo.lock',
    'tools/rustc-analysis/build.rs', 'tools/rustc-analysis/contract', 'tools/rustc-analysis/compiler',
    'tools/rustc-analysis/runner/Cargo.toml', 'tools/rustc-analysis/runner/src/host.rs',
    'tools/rustc-analysis/runner/src/report_cache.rs', 'tools/rustc-analysis/runner/src/unit_graph.rs', 'tools/rustc-analysis/runner/src/unit_binding.rs',
    'tools/rustc-analysis/runner/src/lib.rs', 'tools/rustc-analysis/runner/src/main.rs', 'scripts/rustc-analysis.ps1', ...exportProducerInputs,
    ...(fs.existsSync(path.join(workspace, 'build.rs')) ? ['build.rs'] : [])];
  return [
    { id: 'dependencies', inputs: ['docs/diagrams/package.json', 'docs/diagrams/package-lock.json'], outputs: [],
      reuse: dependencies.valid, reuseReason: 'Installed packages match package-lock',
      command: () => { const npm = npmCommand(); return { command: npm.command, args: [...npm.args, 'ci', '--prefix', path.join(workspace, 'docs/diagrams')] }; },
      validate: () => { const state = dependencyState(workspace); if (!state.valid) throw new Error(state.reason); return state; } },
    { id: 'extract', inputs: compilerInputs, outputs: [facts, runtime, exportDirectory, path.join(compilerDirectory, 'analysis-summary.json')],
      command: analysis(['extract', '--workspace', workspace, '--out', compilerDirectory]),
      validate: async () => {
        const { readDebugdump } = await import('./debugdump-input.mjs');
        const dump = readDebugdump(exportDirectory, workspace);
        const snapshot = JSON.parse(fs.readFileSync(runtime, 'utf8'));
        if (snapshot?.schemaVersion !== 1 || snapshot.sourceFingerprint !== dump.manifest.sourceFingerprint || !Array.isArray(snapshot.schedules)) throw new Error('Invalid compiler runtime snapshot');
        if (!fs.statSync(facts).isFile() || fs.statSync(facts).size === 0) throw new Error('Missing compiler facts');
        // Rust 在下一阶段流式解析完整事实；此处用流式指纹登记原始字节，避免 JS 的单字符串大小限制。
        const cache = JSON.parse(fs.readFileSync(path.join(compilerDirectory, 'analysis-summary.json'), 'utf8'));
        if (cache.schemaVersion !== 2 || cache.incremental !== true || ['compiled', 'reused', 'recovered', 'attempts', 'cargoMs', 'bindingMs', 'totalMs'].some(key => !Number.isSafeInteger(cache[key]) || cache[key] < 0)) throw new Error('Invalid analysis cache summary');
        return { files: fileSnapshot(workspace, [facts, runtime, exportDirectory, path.join(compilerDirectory, 'analysis-summary.json')], { optional: false }), sourceFingerprint: dump.manifest.sourceFingerprint, cache };
      } },
    { id: 'model', inputs: [...compilerInputs, 'tools/rustc-analysis/runner/src/model.rs', 'tools/rustc-analysis/runner/src/model_tests.rs', facts, runtime], outputs: [model, path.join(compilerDirectory, 'model.calls.ndjson')],
      command: analysis(['model', '--facts', facts, '--runtime', runtime, '--out', model]) },
    { id: 'preflight', inputs: [...inputs, model, path.join(compilerDirectory, 'model.calls.ndjson'), exportDirectory], outputs: [],
      command: node(cli, ['preflight', '--workspace', workspace, '--debugdump', exportDirectory]), dependencyInputs: true },
    { id: 'build', inputs: [...inputs, model, path.join(compilerDirectory, 'model.calls.ndjson'), exportDirectory], outputs: [generated],
      command: node(path.join(workspace, 'docs/diagrams/build-ecs.mjs'), ['--debugdump', exportDirectory]), dependencyInputs: true,
      after: state => { state.finalModel = readModelSummary(workspace); if (!state.finalModel.available) throw new Error(state.finalModel.reason); } },
    { id: 'check', inputs: [...inputs, generated], outputs: [], command: node(path.join(workspace, 'docs/diagrams/check-ecs.mjs')), dependencyInputs: true },
    { id: 'test', inputs: [...inputs, generated], outputs: [], command: () => ({ command: process.execPath,
      args: ['--test', '--test-concurrency=1', ...fs.readdirSync(path.join(workspace, 'docs/diagrams/tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(workspace, 'docs/diagrams/tests', name))] }), dependencyInputs: true },
  ];
}
function renderContextIdentity(workspace) {
  try { return { available: true, sha256: digest(mermaidDependencyIdentity(workspace)) }; }
  catch (error) { return { available: false, reason: error.message }; }
}

function stageInputs(workspace, stage, state, tools) {
  return { files: fileSnapshot(workspace, stage.inputs || []), tools,
    exportContext: exportContextInputs(workspace),
    // 提交只改变发布归属；浏览器与字体只改变呈现，均不使编译事实重新提取。
    ...(renderedStages.has(stage.id) ? { sourceCommit: headMetadata(workspace), rendering: renderContextIdentity(workspace) } : {}),
    producer: stage.producer || { command: typeof stage.command === 'function' ? stage.command.toString() : stage.command,
      action: stage.action?.toString(), validate: stage.validate?.toString(), finalize: stage.finalize?.toString(), after: stage.after?.toString(), outputs: stage.outputs || [] },
    ...(stage.dumpManifest ? { export: exportProvenance(JSON.parse(fs.readFileSync(stage.dumpManifest, 'utf8'))) } : {}),
    ...(stage.id !== 'dependencies' ? { installation: dependencyState(workspace) } : {}),
    ...(stage.dependencyInputs ? { dependencies: dependencySnapshot(state.dependencyInputs) } : {}) };
}
function matching(record, inputs, workspace) {
  if (!record || record.status !== 'passed' || digest(record.inputs) !== digest(inputs)) return false;
  try {
    if (record.logHashes && Object.entries(record.logHashes).some(([filename, hash]) => digest(fs.readFileSync(filename)) !== hash)) return false;
    return digest(record.outputs) === digest(fileSnapshot(workspace, record.outputPaths, { optional: false }));
  }
  catch { return false; }
}

function acquireLock(root, runId) {
  fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'lock.json'), token = crypto.randomUUID();
  let fd;
  try { fd = fs.openSync(filename, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') {
      let owner; try { owner = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { owner = { unreadable: true }; }
      throw new Error(`Maintenance lock conflict; existing lock is never stolen: ${JSON.stringify(owner)}`);
    }
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ runId, token, pid: process.pid, acquiredAt: now() })); } finally { fs.closeSync(fd); }
  return () => { if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename); };
}

/** pipeline 仅供小型真实子进程夹具注入；正式命令始终使用上述串行流水线。 */
export async function runMaintenance({ workspace, resume, debugdumpDirectory, pipeline } = {}) {
  workspace = requireWorkspace(workspace);
  if (!pipeline && workspace !== sourceRoot) throw new Error('Run the maintenance entry point from the selected workspace; build/check module roots must match --workspace');
  const checkpoint = !resume ? loadRun(workspace) : null;
  let state = resume ? loadRun(workspace, typeof resume === 'string' ? resume : undefined) : null;
  if (resume && !state) throw new Error('No maintenance run to resume');
  const runId = state?.runId || `${now().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const root = maintenanceRoot(workspace), release = acquireLock(root, runId), directory = path.join(root, runId);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, 'state.json'), tools = toolsForRun(), commandTools = new Map([[process.execPath, tools.node]]);
    state ||= { schemaVersion: 1, runId, workspace, createdAt: now(),
      stages: checkpoint ? [...new Map(checkpoint.stages.map(stage => [stage.id, stage])).values()].map(stage => ({ ...structuredClone(stage), sourceRunId: checkpoint.runId })) : [],
      dependencyInputs: structuredClone(checkpoint?.dependencyInputs || []), events: [],
      ...(checkpoint ? { sourceRunId: checkpoint.runId,
        finalModel: checkpoint.finalModel, preflightModel: checkpoint.preflightModel } : {}) };
    if (state.workspace !== workspace) throw new Error('Resume workspace mismatch');
    state.events.push({ kind: resume ? 'resume' : 'start', at: now(), pid: process.pid });
    state.status = 'running'; state.pid = process.pid; state.head = headMetadata(workspace); state.updatedAt = now();
    const save = () => { state.updatedAt = now(); atomicJson(filename, state); };
    for (const record of state.stages) if (record.status === 'running') { record.status = 'interrupted'; record.error = 'Previous invocation did not record a successful exit'; }
    save();
    const stages = pipeline || defaultPipeline({ workspace, directory, dependencies: dependencyState(workspace) });
    let invalidated = false, handedOffAt = now();
    for (const stage of stages) {
      const previous = [...state.stages].reverse().find(record => record.id === stage.id);
      const inputs = stageInputs(workspace, stage, state, tools);
      let validation;
      try { if (stage.validate) validation = await stage.validate(); } catch { /* 执行或重建后再次验证，旧成功不可直接复用。 */ }
      if (!invalidated && matching(previous, inputs, workspace) && (!stage.validate || validation && digest(validation) === digest(previous.validation))) {
        state.events.push({ kind: 'reuse', stage: stage.id, at: now(), attempt: previous.attempt, ...(previous.sourceRunId ? { sourceRunId: previous.sourceRunId } : {}) }); save(); handedOffAt = now(); continue;
      }
      invalidated = true;
      const record = { id: stage.id, attempt: (previous?.attempt || 0) + 1, requestedAt: now(), inputPaths: stage.inputs || [],
        outputPaths: stage.outputs || [], dumpManifest: stage.dumpManifest, producer: inputs.producer, usesDependencyInputs: Boolean(stage.dependencyInputs), inputs, status: 'queued' };
      record.handoffWaitMs = Math.max(0, Date.parse(record.requestedAt) - Date.parse(handedOffAt));
      state.stages.push(record); save();
      try {
        if (stage.dependencyInputs && stage.id !== 'preflight') {
          const expected = Object.fromEntries(state.dependencyInputs.map(input => [input.path, input.sha256]).sort(([a], [b]) => a.localeCompare(b)));
          if (digest(expected) !== digest(dependencySnapshot(state.dependencyInputs))) throw new Error('Locked dependency source changed after preflight; resume to repeat semantic validation');
        }
        if (stage.reuse && validation) {
          record.status = 'passed'; record.startedAt = now(); record.endedAt = record.startedAt; record.durationMs = 0; record.queueWaitMs = 0;
          record.reusedExternal = true; record.reason = stage.reuseReason; record.validation = validation;
        } else if (stage.action) {
          record.startedAt = now(); record.queueWaitMs = Date.parse(record.startedAt) - Date.parse(record.requestedAt);
          record.result = await stage.action(state); record.status = 'passed'; record.endedAt = now(); record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
        } else {
          const spec = typeof stage.command === 'function' ? stage.command() : stage.command;
          if (!spec?.command || !Array.isArray(spec.args)) throw new Error(`Invalid command for ${stage.id}`);
          if (!commandTools.has(spec.command)) commandTools.set(spec.command, binaryIdentity(spec.command));
          record.tool = commandTools.get(spec.command);
          if (!await executeMaintenanceCommand({ spec, cwd: workspace, directory, record, save })) throw new Error(`Stage ${stage.id} failed (exit ${record.exitCode}, signal ${record.signal || 'none'})`);
        }
        if (digest(inputs) !== digest(stageInputs(workspace, stage, state, tools))) throw new Error(`Inputs changed while stage ${stage.id} was running`);
        if (stage.id === 'preflight' && record.stdout) {
          const output = fs.readFileSync(record.stdout, 'utf8').trim();
          const result = JSON.parse(output || '{}');
          if (result.modelSummary) state.preflightModel = result.modelSummary;
          if (result.dependencyInputs) {
            const expected = Object.fromEntries(result.dependencyInputs.map(input => [input.path, input.sha256]).sort(([a], [b]) => a.localeCompare(b)));
            if (digest(expected) !== digest(dependencySnapshot(result.dependencyInputs))) throw new Error('Dependency inputs changed during preflight');
            state.dependencyInputs = result.dependencyInputs;
            record.inputs = stageInputs(workspace, stage, state, tools);
          }
        }
        if (stage.finalize && !record.reusedExternal) await stage.finalize(record);
        if (stage.validate) record.validation = await stage.validate();
        if (stage.after) await stage.after(state);
        record.outputs = fileSnapshot(workspace, record.outputPaths, { optional: false });
        record.status = 'passed'; save(); handedOffAt = now();
      } catch (error) {
        record.status = record.status === 'interrupted' ? 'interrupted' : 'failed'; record.error = error.message; record.endedAt ||= now();
        state.status = record.status; state.error = error.message; state.endedAt = now(); save(); return state;
      }
    }
    const stale = stages.filter(stage => {
      const record = [...state.stages].reverse().find(item => item.id === stage.id);
      return !matching(record, stageInputs(workspace, stage, state, tools), workspace);
    }).map(stage => stage.id);
    if (stale.length) {
      state.status = 'failed'; state.error = `Inputs or outputs changed after successful stages: ${stale.join(', ')}`;
      state.invalidated = stale; state.endedAt = now(); save(); return state;
    }
    state.status = 'passed'; delete state.error; state.endedAt = now();

    save(); return state;
  } finally { release(); }
}

export async function maintenanceStatus({ workspace, runId } = {}) {
  workspace = requireWorkspace(workspace);
  const state = loadRun(workspace, runId);
  if (!state) return { schemaVersion: 1, workspace, status: 'not-started' };
  const result = structuredClone(state), tools = toolsForRun();
  const latest = new Map(state.stages.map(stage => [stage.id, stage]));
  result.invalidated = [];
  for (const record of latest.values()) {
    if (record.status !== 'passed') continue;
    const stage = { id: record.id, inputs: record.inputPaths, dumpManifest: record.dumpManifest, producer: record.producer, dependencyInputs: record.usesDependencyInputs };
    try { if (!matching(record, stageInputs(workspace, stage, state, tools), workspace)) result.invalidated.push(record.id); }
    catch { result.invalidated.push(record.id); }
    if (record.id === 'dependencies' && !dependencyState(workspace).valid) result.invalidated.push(record.id);
  }
  result.invalidated = [...new Set(result.invalidated)];
  if (state.status === 'running' && !processAlive(state.pid)) result.status = 'interrupted';
  else if (state.status === 'passed' && result.invalidated.length) result.status = 'stale';
  result.automatic = result.status;
  return result;
}

export async function maintenanceReport({ workspace, runId, format = 'json' } = {}) {
  const state = await maintenanceStatus({ workspace, runId });
  if (format === 'json') return state;
  if (!['markdown', 'md'].includes(format)) throw new Error(`Unknown report format: ${format}`);
  const stages = new Map((state.stages || []).map(stage => [stage.id, stage]));
  const lines = [`# ECS 架构图维护`, '', `自动检查：${state.status}`, `工作区：${state.workspace}`, `运行：${state.runId || '未开始'}`, '',
    '| 阶段 | 结果 | PID | 开始 | 结束 | 退出码 | 原始日志 |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...[...stages.values()].map(stage => `| ${stage.id} | ${stage.status} | ${stage.pid ?? '—'} | ${stage.startedAt || '—'} | ${stage.endedAt || '—'} | ${stage.exitCode ?? '—'} | ${[stage.stdout, stage.stderr].filter(Boolean).join(', ') || '—'} |`)];
  if (state.error) lines.push('', `失败：${state.error}`);
  const cache = stages.get('extract')?.validation?.cache;
  if (cache) lines.push('', `编译报告：新编译 ${cache.compiled}，复用 ${cache.reused}，局部恢复包 ${cache.recovered}；Cargo ${cache.cargoMs} ms，证据绑定 ${cache.bindingMs} ms，总计 ${cache.totalMs} ms。`);
  const modelSummary = state.finalModel?.summary || state.preflightModel;
  if (modelSummary?.analysisGaps) {
    const gaps = modelSummary.analysisGaps;
    lines.push('', `分析边界：${gaps.length} 项。`);
    if (gaps.length) {
      const counts = modelSummary.analysisGapSummary?.byKind || Object.fromEntries([...Map.groupBy(gaps, gap => gap.kind)].map(([kind, entries]) => [kind, entries.length]));
      lines.push(`分类：${Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join('；')}。`, '',
        ...gaps.map(gap => `- ${gap.unit} · ${gap.kind} · ${gap.owner}：${gap.reason}${gap.sourceEntries.length ? '（' + gap.sourceEntries.map(source => `${source.path}:${source.line}`).join('，') + '）' : ''}`));
    }
  }
  if (state.modelChanges?.available) {
    const changes = state.modelChanges;
    lines.push('', `对象：新增 ${changes.objects.added.length}，退役 ${changes.objects.retired.length}，保留 ${changes.objects.preserved.length}。`,
      `关系：新增 ${changes.relationships.added.length}，退役 ${changes.relationships.retired.length}，保留 ${changes.relationships.preserved.length}。`,
      `注册变化 ${changes.registrations.length}；泛型变化 ${changes.generics.length}；投影变化 ${changes.projections.length}；源码变化 ${changes.sources.length}。`, '',
      '详细身份及字段差异：', '', '```json', JSON.stringify(changes, null, 2), '```');
  }
  return lines.join('\n') + '\n';
}
