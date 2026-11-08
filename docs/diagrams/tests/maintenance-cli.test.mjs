import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMaintenanceArgs } from '../src/maintenance-cli.mjs';
import { npmCommand } from '../src/maintenance-inputs.mjs';
import { maintenanceScripts, repositoryRoot } from '../src/maintenance-paths.mjs';

const cli = fileURLToPath(new URL('../src/maintenance-cli.mjs', import.meta.url));
test('CLI can show help from another working directory without importing installed toolchain', () => {
  const output = execFileSync(process.execPath, [cli, '--help'], { cwd: path.parse(cli).root, encoding: 'utf8', windowsHide: true });
  assert.match(output, /preflight/);
  assert.doesNotMatch(output, /fix-source-lines/);
});
test('Maintenance CLI help works in an isolated workspace with spaces and no installed dependencies', t => {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/maintenance-cli-tests');
  fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'workspace with spaces '));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const name of [`${maintenanceScripts}/maintenance-cli.mjs`, `${maintenanceScripts}/maintenance-paths.mjs`, 'docs/diagrams/src/paths.mjs', 'docs/diagrams/maintain.mjs', 'docs/diagrams/package.json']) {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, name), target);
  }
  assert.equal(fs.existsSync(path.join(workspace, 'docs/diagrams/node_modules')), false);
  const isolatedCli = path.join(workspace, maintenanceScripts, 'maintenance-cli.mjs');
  const output = execFileSync(process.execPath, [isolatedCli, '--help'], { cwd: path.dirname(workspace), encoding: 'utf8', windowsHide: true });
  assert.match(output, /ECS architecture maintenance/);
  const { command, args } = npmCommand();
  const npmOutput = execFileSync(command, [...args, 'run', 'maintain', '--prefix', path.join(workspace, 'docs/diagrams'), '--', '--help'], { cwd: path.dirname(workspace), encoding: 'utf8', windowsHide: true });
  assert.match(npmOutput, /ECS architecture maintenance/);
});
test('default workspace comes from the maintenance repository instead of the caller directory', () => {
  assert.equal(parseMaintenanceArgs(['plan']).options.workspace, repositoryRoot);
});
test('retired source-repair command is rejected', () => {
  assert.throws(() => parseMaintenanceArgs(['fix-source-lines']), /Unknown/);
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

test('Pages packaging options resolve against the selected workspace', () => {
  const workspace = path.resolve('tmp/selected pages workspace');
  assert.equal(parseMaintenanceArgs(['pack-pages', '--workspace', workspace, '--out', 'tmp/site']).options.outdir, path.join(workspace, 'tmp/site'));
  assert.equal(parseMaintenanceArgs(['check-pages', '--workspace', workspace, '--directory', 'tmp/site']).options.directory, path.join(workspace, 'tmp/site'));
  const verification = parseMaintenanceArgs(['verify-pages', '--workspace', workspace, '--url', 'https://example.test/demo/', '--expected', 'proof.json', '--commit', 'a'.repeat(40), '--evidence', 'tmp/evidence']).options;
  assert.equal(verification.expectedFile, path.join(workspace, 'proof.json'));
  assert.equal(verification.expectedCommit, 'a'.repeat(40));
  assert.equal(verification.evidenceDirectory, path.join(workspace, 'tmp/evidence'));
  assert.throws(() => parseMaintenanceArgs(['verify-pages', '--url', 'https://example.test/demo/']), /--expected/);
});
