import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRoot } from '../src/paths.mjs';
import { hashFile, visitNdjson } from '../src/stream-files.mjs';
import { fileSnapshot } from '../src/maintenance-inputs.mjs';

function fixture(t, content) {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/stream-tests'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-')), filename = path.join(directory, 'calls.ndjson');
  fs.writeFileSync(filename, content); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filename };
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('NDJSON retains split UTF8, CRLF and final records without a newline', t => {
  const values = [{ id: '中文条件', expression: '有值 && "读取"\n换行' }, { id: 'else', deferred: true }];
  const text = values.map(value => JSON.stringify(value)).join('\r\n'), f = fixture(t, text), actual = [];
  assert.deepEqual(visitNdjson(f.filename, (value, line) => actual.push([value, line]), { chunkBytes: 3 }),
    { sha256: sha(text), bytes: Buffer.byteLength(text), records: 2 });
  assert.deepEqual(actual, values.map((value, index) => [value, index + 1]));
});

test('records crossing normal chunk boundaries retain full content and file hashes use raw bytes', t => {
  const value = { id: 'large-proof', proof: '条件'.repeat(200000) }, text = JSON.stringify(value) + '\n', f = fixture(t, text);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    assert.notEqual(path.resolve(String(filename)), f.filename, 'Large artifact hashes must use chunked reads');
    return read(filename, ...args);
  });
  let count = 0; const result = visitNdjson(f.filename, record => { assert.deepEqual(record, value); count++; });
  assert.equal(count, 1); assert.equal(result.sha256, sha(text));
  assert.deepEqual(hashFile(f.filename), { sha256: sha(text), bytes: Buffer.byteLength(text) });
  assert.deepEqual(fileSnapshot(f.directory, ['calls.ndjson']), { 'calls.ndjson': sha(text) });
});

test('empty sidecars are valid zero-edge streams and blank or truncated records fail', t => {
  const f = fixture(t, ''); assert.deepEqual(visitNdjson(f.filename, () => assert.fail()), { sha256: sha(''), bytes: 0, records: 0 });
  for (const text of ['\n', '{}\n\n', '{"partial":']) {
    fs.writeFileSync(f.filename, text); assert.throws(() => visitNdjson(f.filename, () => {}), /Invalid compiler call graph JSON at line/);
  }
});
