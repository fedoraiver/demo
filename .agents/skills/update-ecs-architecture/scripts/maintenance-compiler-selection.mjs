import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executablePath, normalizedEnvironment } from './maintenance-inputs.mjs';
import { importDiagramDependency } from './maintenance-paths.mjs';

const selectors = [['rustc', 'RUSTC', 'CARGO_BUILD_RUSTC'], ['rustc-wrapper', 'RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER'],
  ['rustc-workspace-wrapper', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER']];

export function activeCargoConfigs(workspace, environment = process.env) {
  environment = normalizedEnvironment(environment);
  const directories = [];
  let current = path.resolve(workspace);
  for (;;) {
    directories.push(path.join(current, '.cargo'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  directories.push(path.resolve(workspace, environment.CARGO_HOME || path.join(os.homedir(), '.cargo')));
  // Cargo home 优先级最低；同目录存在两种文件名时只使用无扩展名配置。
  return [...new Set(directories)].reverse().map(directory => ['config', 'config.toml'].map(name => path.join(directory, name)).find(filename => fs.existsSync(filename))).filter(Boolean);
}

const resolveProgram = (value, base, environment) => value.includes('/') || value.includes('\\') ? path.resolve(base, value) : executablePath(value, environment);

/** 输入为标准 TOML parser 的结果；这里只执行 Cargo 的层级和环境优先级。 */
export function resolveCompilerSelection({ workspace, environment = process.env, configs = [] }) {
  environment = normalizedEnvironment(environment);
  const configured = {};
  for (const { filename, data } of configs) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unsupported Cargo config root');
    if (Object.hasOwn(data, 'include')) throw new Error('Cargo config include is unsupported for compiler identity evidence');
    if (data.env && Object.keys(normalizedEnvironment(data.env)).some(name => name === 'PATH' || name === 'PATHEXT' || /^(?:RUST|CARGO_)/.test(name))) throw new Error('Cargo config [env] tool/build selectors are unsupported for compiler identity evidence');
    const build = data.build || {};
    if (typeof build !== 'object' || Array.isArray(build)) throw new Error('Unsupported Cargo build configuration');
    for (const [key] of selectors) if (Object.hasOwn(build, key)) {
      if (typeof build[key] !== 'string') throw new Error(`Cargo build.${key} must be a program-path string`);
      configured[key] = { value: build[key], base: path.dirname(path.dirname(filename)), source: filename };
    }
  }
  const result = {};
  for (const [key, direct, cargo] of selectors) {
    const setting = Object.hasOwn(environment, direct) ? { value: environment[direct], base: workspace, source: direct }
      : Object.hasOwn(environment, cargo) ? { value: environment[cargo], base: workspace, source: cargo } : configured[key];
    if (!setting) { result[key] = { source: 'default', disabled: key !== 'rustc' }; continue; }
    if (typeof setting.value !== 'string') throw new Error(`Unsupported compiler selector: ${setting.source}`);
    if (!setting.value) {
      if (key === 'rustc') throw new Error('An empty rustc selector cannot establish compiler identity');
      result[key] = { source: setting.source, disabled: true }; continue;
    }
    result[key] = { source: setting.source, path: resolveProgram(setting.value, setting.base, environment), disabled: false };
  }
  return result;
}

export async function loadCompilerSelection({ workspace, environment = process.env, configParser } = {}) {
  environment = normalizedEnvironment(environment);
  const files = activeCargoConfigs(workspace, environment);
  let parse = configParser;
  if (files.length && !parse) {
    try { parse = (await importDiagramDependency('smol-toml')).parse; }
    catch { throw new Error('Cargo config compiler identity requires the locked smol-toml dependency; install diagram dependencies first'); }
  }
  const configs = files.map(filename => {
    try { return { filename, data: parse(fs.readFileSync(filename, 'utf8')) }; }
    catch { throw new Error(`Cannot parse Cargo config for compiler identity: ${filename}`); }
  });
  return resolveCompilerSelection({ workspace, environment, configs });
}
