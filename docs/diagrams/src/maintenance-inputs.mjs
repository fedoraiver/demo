import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const slash = value => value.replaceAll('\\', '/');

// 遍历实际文件而非 Git 清单，新增且尚未跟踪的维护模块也必须参与失效判断。
export function fileSnapshot(workspace, names, { optional = true } = {}) {
  const result = {};
  function visit(relative) {
    const filename = path.resolve(workspace, relative);
    if (!fs.existsSync(filename)) {
      if (!optional) throw new Error(`Missing input/output: ${filename}`);
      result[slash(relative)] = null;
      return;
    }
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`Symlink input/output is unsupported: ${filename}`);
    if (stat.isDirectory()) {
      result[slash(relative) + '/'] = 'directory';
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) result[slash(relative)] = digest(fs.readFileSync(filename));
    else throw new Error(`Unsupported input/output: ${filename}`);
  }
  for (const name of [...new Set(names)].sort()) visit(name);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function relevantInputNames(workspace) {
  const names = ['Cargo.toml', 'Cargo.lock', 'src', 'docs/diagrams/package.json', 'docs/diagrams/package-lock.json',
    'docs/diagrams/src', 'docs/diagrams/catalog', 'docs/diagrams/tests'];
  for (const name of ['build.rs', '.cargo/config.toml', 'rust-toolchain', 'rust-toolchain.toml']) if (fs.existsSync(path.join(workspace, name))) names.push(name);
  const root = path.join(workspace, 'docs/diagrams');
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) if (name.endsWith('.mjs')) names.push(`docs/diagrams/${name}`);
  return names;
}

export function dependencyState(workspace) {
  const root = path.join(workspace, 'docs/diagrams');
  try {
    const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/.package-lock.json'), 'utf8'));
    for (const [name, record] of Object.entries(locked.packages || {})) {
      if (!name) continue;
      const supports = (selectors, value) => !selectors || !selectors.includes(`!${value}`) && (!selectors.some(item => !item.startsWith('!')) || selectors.includes(value));
      if (record.optional && (!supports(record.os, process.platform) || !supports(record.cpu, process.arch))) continue;
      const actual = installed.packages?.[name];
      if (!actual || ['version', 'integrity', 'resolved'].some(key => record[key] !== actual[key])) throw new Error(`Installed lock mismatch: ${name}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
      if (manifest.version !== record.version) throw new Error(`Installed package mismatch: ${name}`);
    }
    return { valid: true, lockSha256: digest(fs.readFileSync(path.join(root, 'package-lock.json'))), installedLockSha256: digest(fs.readFileSync(path.join(root, 'node_modules/.package-lock.json'))) };
  } catch (error) { return { valid: false, reason: error.message }; }
}

export function npmCommand() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  if (process.platform !== 'win32') {
    try { candidates.push(fs.realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8', windowsHide: true }).trim())); } catch { /* 未安装时由明确错误结束维护。 */ }
  }
  const cli = candidates.find(filename => fs.existsSync(filename) && filename.endsWith('.js'));
  if (!cli) throw new Error('Cannot find npm-cli.js beside Node; set npm_execpath to the installed npm CLI');
  return { command: process.execPath, args: [cli] };
}

export function headMetadata(workspace) {
  try { return execFileSync('git', ['-c', `safe.directory=${slash(workspace)}`, '-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function normalizedEnvironment(environment = process.env, platform = process.platform) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (Object.hasOwn(result, key) && result[key] !== value) throw new Error(`Conflicting case-insensitive environment key: ${key}`);
    result[key] = value;
  }
  return result;
}

export function executablePath(command, environment = process.env) {
  environment = normalizedEnvironment(environment);
  if (path.isAbsolute(command)) return command;
  const extensions = process.platform === 'win32' ? (environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const directory of (environment.PATH || '').split(path.delimiter)) for (const extension of ['', ...extensions]) {
    const filename = path.join(directory, command + extension);
    if (fs.existsSync(filename) && fs.statSync(filename).isFile()) return filename;
  }
  return command;
}
