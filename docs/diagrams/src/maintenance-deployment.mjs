import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const provenanceKeys = ['buildId', 'sourceCommit', 'target'];
const requiredFiles = ['index.html', 'site-manifest.json', 'pages/ecs-architecture.html', 'pages/ecs-source.html', 'data/manifest.json', 'data/runtime.json'];
const representativePrefixes = ['data/views/', 'svg/schedule/', 'svg/object/', 'svg/legend/', 'runtime/', 'dot/', 'mermaid/'];
const provenanceOf = value => Object.fromEntries(provenanceKeys.map(key => [key, value[key]]));

function expectedPublication(filename, expectedCommit) {
  const raw = fs.readFileSync(filename), value = JSON.parse(raw);
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.buildId || '')
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.sourceCommit || '')
    || typeof value.target !== 'string' || !value.target || value.target === 'unknown' || !Array.isArray(value.files)
    || expectedCommit && value.sourceCommit !== expectedCommit) throw new Error('Invalid deployment publication proof');
  const files = new Map();
  for (const reference of value.files) {
    if (typeof reference.path !== 'string' || !reference.path || /[\\:%?#\0]/.test(reference.path)
      || reference.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(reference.sha256 || '') || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0
      || files.has(reference.path)) throw new Error('Invalid deployment resource proof');
    files.set(reference.path, reference);
  }
  if (files.has('site-manifest.json')) throw new Error('Publication proof must not reference itself');
  files.set('site-manifest.json', { path: 'site-manifest.json', sha256: crypto.createHash('sha256').update(raw).digest('hex'), bytes: raw.byteLength });
  for (const filename of requiredFiles) if (!files.has(filename)) throw new Error('Missing deployment resource proof: ' + filename);
  const selected = [...requiredFiles];
  for (const prefix of representativePrefixes) {
    const filename = [...files.keys()].filter(filename => filename.startsWith(prefix)).sort()[0];
    if (filename) selected.push(filename);
  }
  return { provenance: provenanceOf(value), files, selected };
}

function verifyProvenance(value, expected, label) {
  for (const key of provenanceKeys) if (value[key] !== expected[key]) throw new Error('Deployed provenance mismatch: ' + label + '/' + key);
}

function verifyMetadata(filename, text, expected, files) {
  if (filename.endsWith('.html')) for (const key of provenanceKeys) {
    if (!text.includes(`<meta name="architecture-${key}" content="${expected[key]}">`)) throw new Error('Deployed HTML provenance mismatch: ' + filename + '/' + key);
  }
  if (filename === 'pages/ecs-architecture.html') {
    const match = text.match(/<script\b[^>]*\bid=["']architecture-data["'][^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Missing deployed architecture bootstrap');
    const bootstrap = JSON.parse(match[1]);
    verifyProvenance(bootstrap, expected, 'bootstrap');
    if (bootstrap.schemaVersion !== 6 || bootstrap.manifestUrl !== '../data/manifest.json' || bootstrap.runtimeUrl !== '../data/runtime.json'
      || bootstrap.manifestSha256 !== files.get('data/manifest.json').sha256 || bootstrap.runtimeSha256 !== files.get('data/runtime.json').sha256) throw new Error('Deployed bootstrap resource mismatch');
  } else if (filename === 'data/manifest.json' || filename === 'data/runtime.json' || filename.startsWith('data/views/')) {
    const data = JSON.parse(text);
    verifyProvenance(data, expected, filename);
    if (filename === 'data/manifest.json' && data.schemaVersion !== 2 || filename === 'data/runtime.json' && data.schemaVersion !== 6) throw new Error('Deployed architecture schema mismatch: ' + filename);
  }
}

/** 使用普通 HTTP 核对本轮发布证明；有限重试只容纳 Pages/CDN 的传播延迟。 */
export async function verifyDeployedPages({ workspace, url, expectedFile, expectedCommit, evidenceDirectory,
  maxAttempts = 6, retryDelayMs = 10000, fetch: fetcher = globalThis.fetch, sleep = delay } = {}) {
  const root = path.resolve(workspace), base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid deployment URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10000) throw new Error('Invalid deployment retry policy');
  const { provenance, files, selected } = expectedPublication(path.resolve(root, expectedFile), expectedCommit);
  const directory = path.resolve(root, evidenceDirectory || 'tmp/ecs-architecture/deployment');
  const temporary = path.join(root, 'tmp/ecs-architecture');
  if (!directory.startsWith(temporary + path.sep)) throw new Error('Deployment evidence must remain under workspace tmp/ecs-architecture');
  fs.mkdirSync(directory, { recursive: true });
  const evidencePath = path.join(directory, 'verification.json');
  const evidence = { url: base.href, expected: provenance, status: 'running', attempts: [] };
  const verified = new Set();
  const save = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  save();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const record = { attempt, startedAt: new Date().toISOString(), resources: [] };
    evidence.attempts.push(record);
    try {
      for (const filename of selected) {
        if (verified.has(filename)) continue;
        const resourceUrl = new URL(filename === 'index.html' ? './' : filename, base);
        resourceUrl.searchParams.set('ecs-build', provenance.buildId + '-' + attempt);
        const resource = { path: filename, url: resourceUrl.href };
        record.resources.push(resource); save();
        const response = await fetcher(resourceUrl, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
        Object.assign(resource, { status: response.status, etag: response.headers.get('etag'), contentType: response.headers.get('content-type') });
        if (!response.ok) throw new Error('Deployed resource request failed: ' + filename + '/' + response.status);
        const hash = crypto.createHash('sha256'), chunks = [], needsAll = filename === 'pages/ecs-architecture.html' || filename.endsWith('.json');
        let bytes = 0, captured = 0;
        for await (const chunk of response.body) {
          hash.update(chunk); bytes += chunk.byteLength;
          if (needsAll || captured < 65536) {
            const part = needsAll ? Buffer.from(chunk) : Buffer.from(chunk).subarray(0, 65536 - captured);
            chunks.push(part); captured += part.byteLength;
          }
        }
        const actual = hash.digest('hex'), expected = files.get(filename);
        Object.assign(resource, { bytes, sha256: actual, expectedBytes: expected.bytes, expectedSha256: expected.sha256 });
        if (bytes !== expected.bytes || actual !== expected.sha256) throw new Error('Deployed resource integrity mismatch: ' + filename);
        verifyMetadata(filename, Buffer.concat(chunks).toString('utf8'), provenance, files);
        verified.add(filename);
        save();
      }
      record.endedAt = new Date().toISOString(); evidence.status = 'passed'; save();
      return { status: 'passed', ...provenance, checkedResources: selected.length, attempts: attempt, evidencePath };
    } catch (error) {
      record.error = error.message; record.endedAt = new Date().toISOString(); save();
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
  }
  evidence.status = 'failed'; save();
  throw new Error('Deployed Pages verification failed; evidence: ' + evidencePath);
}
