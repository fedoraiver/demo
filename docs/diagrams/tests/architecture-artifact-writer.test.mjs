import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRoot } from '../src/paths.mjs';
import { replaceArtifactSync, writeTextArtifactSync, copyVerifiedArtifactSync } from '../src/architecture-artifact-writer.mjs';

const oldContent = Buffer.from('previous complete artifact\n旧版本\n');
const newContent = Buffer.from('new complete artifact\n新版本\n');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = code => Object.assign(new Error('Injected rename failure: ' + code), { code });
// 精确计数只覆盖注入的重试；宿主系统的额外占用由真实替换路径处理。
const renameOnHost = (staged, target) => replaceArtifactSync(staged, target);

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

function textFixture(t) {
  const directory = path.dirname(fixture(t).target), output = path.join(directory, 'generated'), staging = path.join(directory, 'staging');
  const filename = 'data/model.json', target = path.join(output, filename), staged = path.join(staging, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, oldContent);
  return { output, staging, filename, target, staged };
}

test('text artifacts preserve UTF-8 bytes through atomic replacement and reuse identical targets', t => {
  const files = textFixture(t), content = newContent.toString('utf8'); let calls = 0;
  writeTextArtifactSync(files.output, files.staging, files.filename, content, {
    rename: (staged, target) => {
      calls++; unchanged({ staged, target }); renameOnHost(staged, target);
    },
  });
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(files.target), newContent);
  assert.equal(fs.existsSync(files.staged), false);
  fs.writeFileSync(files.staged, 'untouched staging bytes');
  writeTextArtifactSync(files.output, files.staging, files.filename, content, {
    rename: () => assert.fail('An identical text target must not be replaced'),
  });
  assert.equal(fs.readFileSync(files.staged, 'utf8'), 'untouched staging bytes');
});

test('text artifacts reject the 100 MiB UTF-8 byte boundary before touching output or staging', t => {
  const files = textFixture(t), limit = 100 * 1024 * 1024, atLimit = 'é'.repeat(limit / 2);
  assert.equal(atLimit.length, limit / 2); assert.equal(Buffer.byteLength(atLimit), limit);
  const options = { rename: () => assert.fail('An oversized text artifact must not reach replacement') };
  assert.throws(() => writeTextArtifactSync(files.output, files.staging, files.filename, atLimit, options),
    { message: 'Architecture artifact exceeds 100 MiB: ' + files.filename });
  assert.deepEqual(fs.readFileSync(files.target), oldContent); assert.equal(fs.existsSync(files.staging), false);
  fs.mkdirSync(path.dirname(files.staged), { recursive: true }); fs.writeFileSync(files.staged, 'untouched staging bytes');
  assert.throws(() => writeTextArtifactSync(files.output, files.staging, files.filename, atLimit + 'a', options),
    { message: 'Architecture artifact exceeds 100 MiB: ' + files.filename });
  assert.deepEqual(fs.readFileSync(files.target), oldContent);
  assert.equal(fs.readFileSync(files.staged, 'utf8'), 'untouched staging bytes');

  const belowLimit = atLimit.slice(0, -1) + 'a';
  assert.equal(Buffer.byteLength(belowLimit), limit - 1);
  writeTextArtifactSync(files.output, files.staging, files.filename, belowLimit);
  assert.equal(fs.statSync(files.target).size, limit - 1); assert.equal(fs.existsSync(files.staged), false);
  const file = fs.openSync(files.target, 'r'), bytes = Buffer.alloc(2);
  try {
    fs.readSync(file, bytes, 0, 2, 0); assert.deepEqual(bytes, Buffer.from('é'));
    fs.readSync(file, bytes, 0, 1, limit - 2); assert.equal(bytes[0], 'a'.charCodeAt(0));
  } finally { fs.closeSync(file); }
});

test('text artifact paths must remain inside both the output and staging directories', t => {
  const files = textFixture(t);
  for (const filename of ['../outside.json', files.target]) {
    assert.throws(() => writeTextArtifactSync(files.output, files.staging, filename, 'small UTF-8 文本'), /Unsafe architecture output path/);
  }
  assert.deepEqual(fs.readFileSync(files.target), oldContent); assert.equal(fs.existsSync(files.staging), false);
  assert.equal(fs.existsSync(path.join(files.output, '../outside.json')), false);
});

test('Windows transient occupancy retries the intact staged file and atomically replaces the old target', t => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const files = fixture(t), waits = []; let calls = 0;
    replaceArtifactSync(files.staged, files.target, { platform: 'win32', wait: milliseconds => { unchanged(files); waits.push(milliseconds); },
      rename: (staged, target) => {
        unchanged(files);
        if (++calls === 1) throw failure(code);
        renameOnHost(staged, target);
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
      renameOnHost(staged, target);
    } });
  assert.equal(calls, 2); assert.deepEqual(waits, [20]);
  assert.deepEqual(fs.readFileSync(files.target), newContent); assert.deepEqual(fs.readFileSync(files.source), newContent);
});

test('an identical verified target is reused without copying or trying a locked rename', t => {
  const files = fixture(t), expected = digest(newContent), staging = Buffer.from('untouched staging bytes');
  fs.writeFileSync(files.target, newContent); fs.writeFileSync(files.staged, staging);
  copyVerifiedArtifactSync(files.source, files.staged, files.target, expected, {
    platform: 'win32', rename: () => { throw failure('EPERM'); }, wait: () => assert.fail('An identical target must not wait'),
  });
  assert.deepEqual(fs.readFileSync(files.target), newContent);
  assert.deepEqual(fs.readFileSync(files.staged), staging);
  assert.deepEqual(fs.readFileSync(files.source), newContent);
});

test('an identical target cannot hide a changed or missing compiler source', t => {
  for (const missing of [false, true]) {
    const files = fixture(t), expected = digest(newContent);
    fs.writeFileSync(files.target, newContent);
    if (missing) fs.unlinkSync(files.source);
    else fs.writeFileSync(files.source, 'changed compiler source');
    assert.throws(() => copyVerifiedArtifactSync(files.source, files.staged, files.target, expected, {
      platform: 'win32', rename: () => assert.fail('Invalid source must not reach replacement'), wait: () => assert.fail('Invalid source must not wait'),
    }), missing ? { code: 'ENOENT' } : /Compiler call graph changed during artifact copy/);
    assert.deepEqual(fs.readFileSync(files.target), newContent);
    assert.deepEqual(fs.readFileSync(files.staged), newContent);
  }
});

test('a compiler source changed during copying still fails staged SHA verification and preserves the target', t => {
  const files = fixture(t), expected = digest(newContent), changed = Buffer.from('changed during copy');
  const copyFile = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, staged) => {
    fs.writeFileSync(source, changed);
    copyFile(source, staged);
  });
  assert.throws(() => copyVerifiedArtifactSync(files.source, files.staged, files.target, expected, {
    platform: 'win32', rename: () => assert.fail('Changed staged bytes must not reach replacement'), wait: () => assert.fail('Changed staged bytes must not wait'),
  }), /Compiler call graph changed during artifact copy/);
  assert.deepEqual(fs.readFileSync(files.target), oldContent);
  assert.deepEqual(fs.readFileSync(files.staged), changed);
});

test('a missing target is created through the verified atomic replacement path', t => {
  const files = fixture(t), expected = digest(newContent); let calls = 0;
  fs.unlinkSync(files.target);
  copyVerifiedArtifactSync(files.source, files.staged, files.target, expected, {
    rename: (staged, target) => { calls++; renameOnHost(staged, target); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(files.target), newContent);
  assert.equal(fs.existsSync(files.staged), false);
});
