import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMaintenanceArgs } from '../src/maintenance-cli.mjs';

const cli = fileURLToPath(new URL('../src/maintenance-cli.mjs', import.meta.url));
test('CLI can show help from another working directory without importing installed toolchain', () => {
  const output = execFileSync(process.execPath, [cli, '--help'], { cwd: path.parse(cli).root, encoding: 'utf8', windowsHide: true });
  assert.match(output, /preflight/);
  assert.match(output, /--apply/);
});
test('source repair remains read-only unless its own explicit apply flag is present', () => {
  assert.equal(parseMaintenanceArgs(['fix-source-lines']).options.apply, undefined);
  assert.equal(parseMaintenanceArgs(['fix-source-lines', '--apply']).options.apply, true);
  assert.throws(() => parseMaintenanceArgs(['run', '--apply']), /Unsupported/);
});

test('explicit worktree anchors relative input and output paths from any caller directory', () => {
  const workspace = path.resolve('tmp/chosen worktree');
  const { options } = parseMaintenanceArgs(['visual', 'record', '--workspace', workspace, '--plan', 'tmp/batch/plan.json', '--input', 'tmp/observations.json', '--index', 'tmp/index-v2.json'], path.parse(workspace).root);
  assert.equal(options.planPath, path.join(workspace, 'tmp/batch/plan.json'));
  assert.equal(options.observationFile, path.join(workspace, 'tmp/observations.json'));
  assert.equal(options.indexPath, path.join(workspace, 'tmp/index-v2.json'));
  const plan = parseMaintenanceArgs(['visual', 'plan', '--workspace', workspace, '--outdir', 'tmp/output']).options;
  assert.equal(plan.outdir, path.join(workspace, 'tmp/output'));
  assert.equal(parseMaintenanceArgs(['preflight', '--workspace', workspace, '--debugdump', 'tmp/dump']).options.debugdumpDirectory, path.join(workspace, 'tmp/dump'));
  const absolutePlan = path.resolve('tmp/absolute batch/plan.json'), browser = path.resolve('tmp/absolute browser/chrome.exe');
  const render = parseMaintenanceArgs(['visual', 'render', '--workspace', workspace, '--plan', absolutePlan, '--browser', browser]).options;
  assert.equal(render.planPath, absolutePlan);
  assert.equal(render.browser, browser);
  assert.equal(parseMaintenanceArgs(['visual', 'render', '--workspace', workspace, '--plan', 'tmp/plan.json', '--browser', 'tools/chrome.exe']).options.browser, path.join(workspace, 'tools/chrome.exe'));
});
test('sampling and actual observations require explicit scope and input', () => {
  assert.throws(() => parseMaintenanceArgs(['visual', 'plan', '--sample', '100']), /Sampling requires/);
  assert.throws(() => parseMaintenanceArgs(['visual', 'record', '--plan', 'p.json']), /--input/);
  assert.throws(() => parseMaintenanceArgs(['visual', 'bind']), /--commit/);
  const { options } = parseMaintenanceArgs(['visual', 'plan', '--workspace', 'folder with spaces', '--sample', '3', '--seed', 's', '--scope', 'requested sample', '--force-object', 'a', '--force-object', 'b']);
  assert.equal(options.workspace, path.resolve('folder with spaces'));
  assert.deepEqual(options.forcedObjectIds, ['a', 'b']);
});
test('unknown commands, duplicate options and invalid ranges fail before any work', () => {
  for (const args of [['merge'], ['run', '--dangerous', '--help'], ['visual', 'bogus', '--help'], ['plan', '--workspace', 'a', '--workspace', 'b'], ['visual', 'render', '--plan', 'p', '--from', '4', '--to', '2'], ['visual', 'plan', '--sample', '-1']]) assert.throws(() => parseMaintenanceArgs(args));
  const result = spawnSync(process.execPath, [cli, 'run', '--apply'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported/);
});
