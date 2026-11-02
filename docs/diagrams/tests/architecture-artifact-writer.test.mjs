import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRoot } from '../src/paths.mjs';
import { replaceArtifactSync, copyVerifiedArtifactSync } from '../src/architecture-artifact-writer.mjs';

const oldContent = Buffer.from('previous complete artifact\n旧版本\n');
const newContent = Buffer.from('new complete artifact\n新版本\n');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error('Injected rename failure: ' + code), { code });

function fixture(t) {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/artifact-writer-tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(parent) + path.sep));
  const target = path.join(directory, 'target.svg'), staged = path.join(directory, 'staged.svg'), source = path.join(directory, 'source.svg');
  fs.writeFileSync(target, oldContent); fs.writeFileSync(staged, newContent); fs.writeFileSync(source, newContent);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { target, staged, source };
}

function unchanged({ target, staged }) {
  assert.deepEqual(fs.readFileSync(target), oldContent);
  assert.deepEqual(fs.readFileSync(staged), newContent);
}

test('Windows transient occupancy retries the intact staged file and atomically replaces the old target', t => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const files = fixture(t), waits = []; let calls = 0;
    replaceArtifactSync(files.staged, files.target, { platform: 'win32', wait: milliseconds => { unchanged(files); waits.push(milliseconds); },
      rename: (staged, target) => {
        unchanged(files);
        if (++calls === 1) throw failure(code);
        fs.renameSync(staged, target);
      } });
    assert.equal(calls, 2); assert.deepEqual(waits, [20]);
    assert.deepEqual(fs.readFileSync(files.target), newContent); assert.equal(fs.existsSync(files.staged), false);
  }
});

test('persistent Windows occupancy has a fixed retry budget and preserves both complete files and the original error', t => {
  const files = fixture(t), error = failure('EPERM'), waits = []; let calls = 0;
  assert.throws(() => replaceArtifactSync(files.staged, files.target, { platform: 'win32',
    rename: () => { calls++; unchanged(files); throw error; }, wait: milliseconds => { unchanged(files); waits.push(milliseconds); } }), actual => actual === error);
  assert.equal(calls, 6); assert.deepEqual(waits, [20, 40, 80, 160, 320]);
  assert.equal(waits.reduce((sum, value) => sum + value, 0), 620); unchanged(files);
});

test('non-retryable errors and other platforms propagate immediately without waiting or touching either file', t => {
  for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'EXDEV'], ['win32', 'EINVAL'], ['linux', 'EPERM'], ['darwin', 'EACCES']]) {
    const files = fixture(t), error = failure(code); let calls = 0;
    assert.throws(() => replaceArtifactSync(files.staged, files.target, { platform,
      rename: () => { calls++; throw error; }, wait: () => assert.fail('This error must not wait') }), actual => actual === error);
    assert.equal(calls, 1); unchanged(files);
  }
});

test('a changed compiler sidecar fails SHA verification before any replacement or retry', t => {
  const files = fixture(t), expected = digest(newContent);
  fs.writeFileSync(files.source, Buffer.from('changed after compiler extraction\n'));
  assert.throws(() => copyVerifiedArtifactSync(files.source, files.staged, files.target, expected, {
    platform: 'win32', rename: () => assert.fail('SHA failure must not reach replacement'), wait: () => assert.fail('SHA failure must not wait'),
  }), /Compiler call graph changed during artifact copy/);
  assert.deepEqual(fs.readFileSync(files.target), oldContent);
  assert.deepEqual(fs.readFileSync(files.staged), fs.readFileSync(files.source));
});

test('a verified compiler sidecar uses the same bounded replacement path while preserving its bytes during retries', t => {
  const files = fixture(t), waits = [], expected = digest(newContent); let calls = 0;
  fs.writeFileSync(files.staged, 'obsolete staging bytes');
  copyVerifiedArtifactSync(files.source, files.staged, files.target, expected, { platform: 'win32', wait: milliseconds => waits.push(milliseconds),
    rename: (staged, target) => {
      unchanged(files); assert.equal(digest(fs.readFileSync(staged)), expected);
      if (++calls === 1) throw failure('EPERM');
      fs.renameSync(staged, target);
    } });
  assert.equal(calls, 2); assert.deepEqual(waits, [20]);
  assert.deepEqual(fs.readFileSync(files.target), newContent); assert.deepEqual(fs.readFileSync(files.source), newContent);
});
