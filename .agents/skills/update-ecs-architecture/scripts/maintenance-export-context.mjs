import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { digest, fileSnapshot, executablePath, normalizedEnvironment } from './maintenance-inputs.mjs';
import { atomicJson } from './maintenance-execution.mjs';
import { loadCompilerSelection } from './maintenance-compiler-selection.mjs';

export const EXPORT_CONTEXT = 'maintenance-export-context.json';
const selectedEnvironment = name => /^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTUP_TOOLCHAIN|RUSTC_BOOTSTRAP|CARGO_BUILD_TARGET|CARGO_BUILD_RUSTFLAGS|CARGO_HOME|RUSTUP_HOME)$/.test(name)
  || /^(?:PATH|PATHEXT)$/.test(name)
  || /^CARGO_BUILD_RUSTC(?:_WRAPPER|_WORKSPACE_WRAPPER)?$/.test(name)
  || /^CARGO_TARGET_.+_(?:RUSTFLAGS|LINKER|RUNNER)$/.test(name) || /^CARGO_PROFILE_.+_(?:OPT_LEVEL|DEBUG|SPLIT_DEBUGINFO|STRIP|DEBUG_ASSERTIONS|OVERFLOW_CHECKS|LTO|PANIC|INCREMENTAL|CODEGEN_UNITS|RPATH)$/.test(name);

// 仅白名单构建 selector；配置和环境只保存内容哈希，不复制凭据或配置正文。
export function exportContextInputs(workspace, environment = process.env) {
  environment = normalizedEnvironment(environment);
  const names = [];
  let directory = path.resolve(workspace);
  for (;;) {
    for (const name of ['.cargo/config', '.cargo/config.toml', 'rust-toolchain', 'rust-toolchain.toml']) names.push(path.join(directory, name));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const name of ['config', 'config.toml']) names.push(path.join(environment.CARGO_HOME || path.join(os.homedir(), '.cargo'), name));
  names.push(path.join(environment.RUSTUP_HOME || path.join(os.homedir(), '.rustup'), 'settings.toml'));
  return { files: fileSnapshot(workspace, names), environment: Object.fromEntries(Object.keys(environment).filter(selectedEnvironment).sort().map(name => [name, digest(environment[name])])),
    invocation: { cwd: path.resolve(workspace), locked: true, features: ['debugdump'], cargoCommand: executablePath('cargo', environment) } };
}

const identity = filename => {
  const resolved = fs.realpathSync(executablePath(filename));
  return { path: resolved, sha256: digest(fs.readFileSync(resolved)) };
};
const dumpProof = manifest => ({ sourceFingerprint: manifest.sourceFingerprint, bevyVersion: manifest.bevyVersion, debugdumpVersion: manifest.debugdumpVersion,
  exportedAt: manifest.exportedAt, target: manifest.target, features: manifest.features,
  schedules: manifest.schedules.map(entry => ({ id: entry.id, app: entry.app, label: entry.label, systemCount: entry.systemCount, sha256: entry.sha256 })) });

export async function validateExportContext({ workspace, directory, manifest, environment = process.env, configParser }) {
  environment = normalizedEnvironment(environment);
  const filename = path.join(directory, EXPORT_CONTEXT);
  if (!fs.existsSync(filename)) return { status: 'unknown', reason: 'Legacy export has no build-context evidence; one dedicated export is required' };
  try {
    const context = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (context.schemaVersion !== 2) throw new Error('Export context schema does not prove the selected compiler and wrappers');
    if (digest(context.inputs) !== digest(exportContextInputs(workspace, environment))) throw new Error('Export build configuration or selector environment changed');
    const selection = await loadCompilerSelection({ workspace, environment, configParser });
    if (digest(context.selection) !== digest(selection)) throw new Error('Selected compiler or wrapper changed');
    if (digest(context.dump) !== digest(dumpProof(manifest))) throw new Error('Export context does not bind the current DOT provenance');
    for (const tool of Object.values(context.tools || {})) if (digest(identity(tool.path)) !== digest(tool)) throw new Error('Export toolchain binary changed');
    if (!context.tools?.cargo || !context.tools?.rustc) throw new Error('Missing actual Cargo/rustc toolchain identity');
    for (const probe of context.probes || []) {
      if (probe.exitCode !== 0 || probe.signal || !Number.isInteger(probe.pid) || probe.pid <= 0) throw new Error('Unsuccessful toolchain identity probe');
      if (digest(fs.readFileSync(probe.stdout)) !== probe.stdoutSha256 || digest(fs.readFileSync(probe.stderr)) !== probe.stderrSha256) throw new Error('Toolchain probe raw log missing or changed');
    }
    if (digest(context.inputs) !== digest(exportContextInputs(workspace, environment))) throw new Error('Export configuration changed during context validation');
    return { status: 'valid', sha256: digest(fs.readFileSync(filename)), context };
  } catch (error) { return { status: 'stale', reason: error.message }; }
}

/** 仅在专用导出成功后解析已安装工具链；计划和状态绝不调用 rustup。 */
export async function captureExportContext({ workspace, directory, manifest, environment = process.env, toolchainProvider, configParser, beforeInputs }) {
  environment = normalizedEnvironment(environment);
  if (!beforeInputs && !toolchainProvider) throw new Error('Pre-export build context evidence is required');
  const before = beforeInputs || exportContextInputs(workspace, environment);
  if (digest(before) !== digest(exportContextInputs(workspace, environment))) throw new Error('Export configuration changed during execution; context cannot be captured');
  const selection = await loadCompilerSelection({ workspace, environment, configParser });
  const probes = [];
  const select = toolchainProvider || (() => {
    const which = name => {
      const startedAt = new Date().toISOString(), args = ['which', name];
      const result = spawnSync('rustup', args, { cwd: workspace, encoding: 'utf8', env: environment, windowsHide: true, shell: false });
      const stdout = path.join(directory, `toolchain-${name}.stdout.log`), stderr = path.join(directory, `toolchain-${name}.stderr.log`);
      fs.writeFileSync(stdout, result.stdout || ''); fs.writeFileSync(stderr, result.stderr || '');
      probes.push({ command: 'rustup', args, cwd: workspace, pid: result.pid, startedAt, endedAt: new Date().toISOString(), exitCode: result.status,
        signal: result.signal, stdout, stderr, stdoutSha256: digest(result.stdout || ''), stderrSha256: digest(result.stderr || '') });
      if (result.status !== 0 || result.error || result.signal) throw new Error(`Cannot identify installed ${name} after export: ${result.error?.message || result.stderr || result.status}`);
      return result.stdout.trim();
    };
    const proxy = identity(executablePath('rustup', environment));
    const actual = (filename, name) => identity(filename).sha256 === proxy.sha256 ? which(name) : filename;
    return { cargo: actual(executablePath('cargo', environment), 'cargo'),
      rustc: actual(selection.rustc.path || executablePath('rustc', environment), 'rustc') };
  });
  const selected = select(selection);
  if (selection.rustc.path && toolchainProvider) selected.rustc = selection.rustc.path;
  const tools = Object.fromEntries(Object.entries(selected).map(([name, filename]) => [name, identity(filename)]));
  if (!toolchainProvider) {
    tools.cargoLauncher = identity('cargo');
    tools.rustupLauncher = identity('rustup');
  }
  for (const name of ['rustc-wrapper', 'rustc-workspace-wrapper']) if (!selection[name].disabled) tools[name] = identity(selection[name].path);
  const after = exportContextInputs(workspace, environment);
  if (digest(before) !== digest(after)) throw new Error('Export configuration changed during execution or toolchain probing; context cannot be captured');
  const context = { schemaVersion: 2, capturedAt: new Date().toISOString(), inputs: before, selection, dump: dumpProof(manifest), tools, probes };
  atomicJson(path.join(directory, EXPORT_CONTEXT), context);
  return context;
}
