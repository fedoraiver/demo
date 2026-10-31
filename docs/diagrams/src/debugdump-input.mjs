// 调度导出的来源核对不依赖渲染器；plan 与 preflight 共用同一指纹协议。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEBUGDUMP_MANIFEST = 'debugdump-manifest.json';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const scheduleId = (app, label) => sha256(`${app}\0${label}`).slice(0, 16);
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

/** 与 Rust 导出器共用换行归一化和按仓库相对路径排序的指纹协议。 */
export function sourceFingerprint(root) {
  const filenames = ['Cargo.toml', 'Cargo.lock'];
  if (fs.existsSync(path.join(root, 'build.rs'))) filenames.push('build.rs');
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const filename = `${directory}/${entry.name}`;
      requireCondition(!entry.isSymbolicLink(), `Source fingerprint does not support symlinks: ${filename}`);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && filename.endsWith('.rs')) filenames.push(filename);
    }
  }
  walk('src');
  const hash = crypto.createHash('sha256');
  for (const filename of filenames.sort()) hash.update(filename + '\0' + fs.readFileSync(path.join(root, filename), 'utf8').replace(/\r\n/g, '\n') + '\0');
  return hash.digest('hex');
}

function lockedVersion(root, name) {
  const packages = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8').split('[[package]]');
  return packages.find(item => new RegExp(`^name = "${name}"$`, 'm').test(item))?.match(/^version = "([^"]+)"/m)?.[1];
}

/** 在任何正式产物写入之前核实来源与所有 DOT；失败不复用旧图。 */
export function readDebugdump(directory, root, filename = 'manifest.json') {
  const manifestPath = path.join(directory, filename);
  requireCondition(fs.existsSync(manifestPath), `Missing debugdump manifest: ${manifestPath}. Run cargo run --locked --features debugdump -- --dump-schedules tmp/debugdump, then build with --debugdump tmp/debugdump`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  requireCondition(manifest.schemaVersion === 1, 'Unsupported debugdump manifest schema');
  for (const [field, crate] of [['bevyVersion', 'bevy'], ['debugdumpVersion', 'bevy_mod_debugdump']]) {
    requireCondition(manifest[field] === lockedVersion(root, crate), `Debugdump dependency version mismatch: ${crate}`);
  }
  requireCondition(manifest.sourceFingerprint === sourceFingerprint(root), 'Debugdump source fingerprint is stale; run the export command again');
  requireCondition(Number.isSafeInteger(manifest.exportedAt) && manifest.exportedAt >= 0 && typeof manifest.target === 'string' && manifest.target.length > 0, 'Invalid debugdump provenance');
  requireCondition(Array.isArray(manifest.features) && manifest.features.includes('debugdump'), 'Debugdump feature provenance is missing');
  requireCondition(Array.isArray(manifest.schedules) && manifest.schedules.length > 0, 'Debugdump contains no schedules');
  const ids = new Set();
  const schedules = manifest.schedules.map(entry => {
    requireCondition(typeof entry.app === 'string' && entry.app.length > 0 && typeof entry.label === 'string' && entry.label.length > 0, 'Invalid debugdump Schedule identity');
    const id = scheduleId(entry.app, entry.label);
    requireCondition(entry.id === id && !ids.has(id), `Invalid or duplicate debugdump Schedule: ${entry.id}`);
    ids.add(id);
    requireCondition([`schedule-${id}.dot`, `ecs-schedule-${id}.dot`].includes(entry.filename), `Unsafe debugdump DOT filename: ${entry.filename}`);
    requireCondition(Number.isSafeInteger(entry.systemCount) && entry.systemCount >= 0, `Invalid debugdump system count: ${id}`);
    const file = path.join(directory, entry.filename);
    requireCondition(fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile(), `Missing debugdump DOT: ${entry.filename}`);
    const dot = fs.readFileSync(file, 'utf8');
    requireCondition(sha256(dot) === entry.sha256, `Debugdump DOT hash mismatch: ${entry.filename}`);
    return { ...entry, dot };
  });
  schedules.sort((a, b) => (a.app === 'main' ? '' : a.app).localeCompare(b.app === 'main' ? '' : b.app) || a.label.localeCompare(b.label));
  return { manifest, schedules };
}
