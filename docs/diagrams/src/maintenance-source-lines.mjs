// 只修改主清单中明确声明的项目定义行号；角色与对象身份不由 source 字段猜测。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskRustSource } from './architecture-components.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pointer = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const catalogPath = 'docs/diagrams/catalog/ecs-data.json';

// JSON.parse 负责语法校验；扫描器只记录数值 token 的精确范围，不重排或重写 JSON。
function numberTokens(text) {
  const tokens = new Map(); let position = 0;
  const space = () => { while (/\s/.test(text[position] || '') && position < text.length) position++; };
  function string() {
    const start = position++;
    while (position < text.length) {
      if (text[position] === '\\') position += 2;
      else if (text[position++] === '"') break;
    }
    return JSON.parse(text.slice(start, position));
  }
  function value(parts) {
    space();
    if (text[position] === '{') {
      position++; space();
      while (text[position] !== '}') {
        const key = string(); space(); position++; value([...parts, key]); space();
        if (text[position] !== ',') break;
        position++; space();
      }
      position++;
    } else if (text[position] === '[') {
      position++; space(); let index = 0;
      while (text[position] !== ']') {
        value([...parts, index++]); space();
        if (text[position] !== ',') break;
        position++; space();
      }
      position++;
    } else if (text[position] === '"') string();
    else {
      const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(position));
      if (!match) throw new Error('Invalid catalog JSON token');
      if (/^-?\d/.test(match[0])) tokens.set(pointer(parts), { start: position, end: position + match[0].length, token: match[0] });
      position += match[0].length;
    }
  }
  value([]); return tokens;
}

function projectFile(workspace, filename) {
  if (typeof filename !== 'string' || !/^src\/.+\.rs$/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..') || filename.includes('\\')) throw new Error('Unsupported project definition path: ' + filename);
  const absolute = path.resolve(workspace, filename), relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(absolute));
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Project definition escapes workspace: ' + filename);
  return absolute;
}

function sourceSnapshots(workspace) {
  const files = new Map();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source-line repair does not follow source symlinks: ' + filename);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && entry.name.endsWith('.rs')) files.set(filename, digest(fs.readFileSync(filename)));
    }
  }
  walk(path.join(workspace, 'src'));
  return files;
}

export function planSourceLineFixes({ workspace }) {
  workspace = path.resolve(workspace);
  const absoluteCatalog = path.join(workspace, catalogPath), catalogBytes = fs.readFileSync(absoluteCatalog), text = catalogBytes.toString('utf8');
  const model = JSON.parse(text), tokens = numberTokens(text), snapshots = sourceSnapshots(workspace);
  snapshots.set(absoluteCatalog, digest(catalogBytes));
  const eligible = new Map(), ignored = [], proposals = [], errors = [];
  function authorize(record, parts, kind, symbol) {
    if (!/^[A-Za-z_]\w*$/.test(symbol || '')) return;
    const sources = [];
    if (record.definition_source) sources.push(['definition_source', record.definition_source]);
    if (record.source?.role === 'definition') sources.push(['source', record.source]);
    for (const field of ['sourceEntries', 'source_entries', 'sources']) for (const [index, source] of (record[field] || []).entries()) if (source.role === 'definition') sources.push([[field, index], source]);
    for (const [field, source] of sources) if ((!source.role || source.role === 'definition') && !source.dependency && source.path?.startsWith('src/')) eligible.set(pointer([...parts, ...[field].flat()]), { id: record.id, kind, symbol });
  }
  for (const [index, feature] of (model.features || []).entries()) {
    if (/^[A-Za-z_]\w*$/.test(feature.plugin || '') && feature.source?.path?.startsWith('src/') && !feature.source.dependency && (!feature.source.role || feature.source.role === 'definition')) eligible.set(pointer(['features', index, 'source']), { id: feature.id, kind: 'struct', symbol: feature.plugin });
  }
  for (const field of ['systems', 'nodes']) for (const [index, record] of (model[field] || []).entries()) {
    if (['System', 'Observer', 'Plugin'].includes(record.kind)) authorize(record, [field, index], record.kind === 'Plugin' ? 'struct' : 'fn', record.name);
  }
  function visit(value, parts = []) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && Number.isSafeInteger(value.line)) {
      const key = pointer(parts), identity = eligible.get(key);
      if (!identity) { ignored.push({ entry: key, path: value.path, line: value.line, role: value.role || 'unclassified', reason: 'unsupported-role-or-declaration-identity' }); return; }
      try {
        const file = projectFile(workspace, value.path), bytes = fs.readFileSync(file);
        if (snapshots.get(file) !== digest(bytes)) throw new Error('Source-line repair input changed while planning: ' + value.path);
        const code = maskRustSource(bytes.toString('utf8'));
        const expression = new RegExp(`\\b${identity.kind}\\s+${escape(identity.symbol)}\\b`, 'gm');
        const matches = [...code.matchAll(expression)].map(match => code.slice(0, match.index).split('\n').length);
        if (matches.length !== 1) throw new Error(`Expected one declaration for ${identity.symbol} in ${value.path}; found ${matches.length}`);
        const token = tokens.get(pointer([...parts, 'line']));
        if (!token || token.token !== String(value.line) || value.line < 1) throw new Error('Invalid numeric definition line token: ' + key);
        if (matches[0] !== value.line) proposals.push({ entry: key, id: identity.id, symbol: identity.symbol, path: value.path, from: value.line, to: matches[0], ...token });
      } catch (error) { errors.push({ entry: key, message: error.message }); }
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...parts, key]);
  }
  visit(model);
  return { workspace, catalog: catalogPath, inputFingerprint: digest([...snapshots].map(([file, hash]) => `${path.relative(workspace, file).replaceAll('\\', '/')}\0${hash}`).sort().join('\n')), proposals, ignored, errors,
    // 仅显式 apply 消费这些内部快照；公开 JSON 结果不携带源码内容。
    snapshots, text, absoluteCatalog };
}

export function applySourceLineFixes(plan) {
  if (plan.errors.length) throw new Error('Source-line repair refused:\n' + plan.errors.map(error => error.message).join('\n'));
  function assertUnchanged() {
    const current = sourceSnapshots(plan.workspace);
    current.set(plan.absoluteCatalog, digest(fs.readFileSync(plan.absoluteCatalog)));
    if (current.size !== plan.snapshots.size) throw new Error('Source-line repair input changed: source file inventory');
    for (const [file, hash] of plan.snapshots) if (current.get(file) !== hash) throw new Error('Source-line repair input changed: ' + path.relative(plan.workspace, file));
  }
  assertUnchanged();
  let text = plan.text;
  for (const proposal of [...plan.proposals].sort((a, b) => b.start - a.start)) text = text.slice(0, proposal.start) + proposal.to + text.slice(proposal.end);
  if (plan.proposals.length) {
    const parent = path.join(plan.workspace, 'tmp/ecs-architecture/source-line-repair');
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, 'apply-')), stagedCatalog = path.join(staging, 'ecs-data.json');
    try {
      fs.writeFileSync(stagedCatalog, text);
      assertUnchanged();
      // 只替换一个目录文件；完整暂存后原子替换，避免中断留下半份清单。
      fs.renameSync(stagedCatalog, plan.absoluteCatalog);
    } finally {
      if (fs.existsSync(stagedCatalog)) fs.unlinkSync(stagedCatalog);
      fs.rmdirSync(staging);
    }
  }
  return plan.proposals.length;
}

export async function fixSourceLines({ workspace, apply = false }) {
  const plan = planSourceLineFixes({ workspace });
  if (plan.errors.length) throw new Error('Source-line repair refused:\n' + plan.errors.map(error => error.message).join('\n'));
  const changed = apply ? applySourceLineFixes(plan) : 0;
  return { catalog: plan.catalog, applied: apply, changed, inputFingerprint: plan.inputFingerprint, proposals: plan.proposals.map(({ start, end, token, ...proposal }) => proposal), ignored: plan.ignored };
}
