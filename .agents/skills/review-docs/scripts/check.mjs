import fs from 'node:fs';
import path from 'node:path';
import { inventory, safePath, readHash, hash, git, stable, environment } from './workspace.mjs';
import { parseDocument } from './markdown.mjs';
import { comparisonBase } from './session.mjs';

export async function check(root, baseline, deps, hooks = {}) {
  const before = environment(root, baseline.scope), reads = {}, parsed = new Map(), problems = [], externalLinks = [], inbound = [];
  const docs = inventory(root, baseline.scope);
  const baseBefore = comparisonBase(root, baseline);
  if (baseBefore.status !== 'current') problems.push({ code: 'base_moved', message: '显式比较基点已迁移；必须创建新会话', comparisonBase: baseBefore });
  const scopedPaths = new Set(docs.filter(d => d.inScope).map(d => d.path));
  const checkedSources = new Set();
  const read = relative => {
    const absolute = safePath(root, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) { reads[relative] = null; return null; }
    const bytes = fs.readFileSync(absolute);
    // 同一次检查内重复读取也必须看到相同输入。
    const digest = hash(bytes);
    if (relative in reads && reads[relative] !== digest) problems.push({ code: 'input_changed_during_check', path: relative, message: '重复读取时输入已改变' });
    reads[relative] = digest;
    return bytes.toString('utf8');
  };
  for (const doc of docs) {
    if (doc.requiredReview === false) continue;
    const source = read(doc.path);
    if (source === null) continue;
    const data = parseDocument(doc.path, source, deps);
    parsed.set(doc.path, data);
    if (doc.inScope) {
      checkedSources.add(doc.path);
      for (const p of data.problems) problems.push({ path: doc.path, ...p });
    }
  }
  for (const doc of docs) {
    const data = parsed.get(doc.path);
    if (!data) continue;
    for (const link of data.links) {
      const url = link.url.trim();
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) { if (doc.inScope) externalLinks.push({ source: doc.path, ...link, status: 'unverified' }); continue; }
      const issue = (code, message, target) => problems.push({ path: doc.path, line: link.line, url, target, code, message, outsideScope: !doc.inScope });
      let filePart, anchor, target;
      try {
        const hashAt = url.indexOf('#'), rawFile = hashAt < 0 ? url : url.slice(0, hashAt);
        anchor = hashAt < 0 ? '' : decodeURIComponent(url.slice(hashAt + 1));
        filePart = decodeURIComponent(rawFile.split('?')[0]);
        target = filePart ? path.posix.normalize(filePart.startsWith('/') ? filePart.slice(1) : path.posix.join(path.posix.dirname(doc.path), filePart.replaceAll('\\', '/'))) : doc.path;
        if (!doc.inScope && !scopedPaths.has(target)) continue;
        checkedSources.add(doc.path);
        if (scopedPaths.has(target)) inbound.push({ source: doc.path, target, anchor, url, outsideScope: !doc.inScope });
        const absolute = safePath(root, target, { missing: false });
        if (fs.statSync(absolute).isDirectory()) {
          if (anchor) issue('anchor_on_directory', '目录链接无法确定章节目标', target);
          continue;
        }
        if (!(target in reads)) {
          const source = read(target);
          if (source !== null && /\.(md|markdown|mdx|html?|svg)$/i.test(target)) parsed.set(target, parseDocument(target, source, deps));
        }
        if (anchor) {
          const targetData = parsed.get(target);
          if (targetData && !targetData.anchors.has(anchor)) issue('missing_anchor', `锚点不存在: ${anchor}`, target);
          else if (!targetData) externalLinks.push({ source: doc.path, ...link, status: 'unverified', reason: '本地非文档片段未验证' });
        }
      } catch (error) {
        if (doc.inScope || (target && scopedPaths.has(target))) issue('invalid_local_link', error.message, target);
      }
    }
  }
  const diffBefore = git(root, ['diff', '--check'], true) + git(root, ['diff', '--cached', '--check'], true);
  if (diffBefore.trim()) problems.push({ code: 'diff_whitespace', message: diffBefore.trim() });
  if (hooks.afterRead) await hooks.afterRead();
  const changed = Object.entries(reads).filter(([p, digest]) => readHash(root, p) !== digest).map(([p]) => p);
  if (stable(before) !== stable(environment(root, baseline.scope))) changed.push('(inventory/rules/tool)');
  if (stable(baseBefore) !== stable(comparisonBase(root, baseline))) changed.push('(comparison base)');
  const diffAfter = git(root, ['diff', '--check'], true) + git(root, ['diff', '--cached', '--check'], true);
  if (diffBefore !== diffAfter) changed.push('(git diff --check)');
  if (changed.length) problems.push({ code: 'input_changed_during_check', message: '检查期间输入变动，结果不能作为通过证据', paths: changed });
  return { status: problems.length ? 'fail' : 'pass', problems, externalLinks, inbound,
    semanticStatus: 'unverified', readInputs: reads, environment: before, diffCheck: diffAfter,
    discoveredDocuments: docs.length, parsedDocuments: parsed.size, checkedDocuments: checkedSources.size,
    scannedDocuments: parsed.size, scopedDocuments: docs.filter(d => d.inScope).length };
}
export function currentMechanical(root, baseline, event) {
  if (comparisonBase(root, baseline).status !== 'current') return false;
  if (stable(event.result.environment) !== stable(environment(root, baseline.scope))) return false;
  if (Object.entries(event.result.readInputs).some(([p, digest]) => readHash(root, p) !== digest)) return false;
  const diff = git(root, ['diff', '--check'], true) + git(root, ['diff', '--cached', '--check'], true);
  return diff === event.result.diffCheck;
}
