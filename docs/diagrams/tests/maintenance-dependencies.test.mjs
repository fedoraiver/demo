import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmCommand } from '../src/maintenance-inputs.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('install-script approvals cover only the reviewed locked esbuild and Puppeteer versions', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.allowScripts, { 'esbuild@0.28.2': true, 'puppeteer@25.15.0': true });
  const installScripts = Object.entries(lock.packages).filter(([, value]) => value.hasInstallScript);
  assert.deepEqual(installScripts.map(([name, value]) => name.slice('node_modules/'.length) + '@' + value.version).sort(), Object.keys(manifest.allowScripts).sort());
  for (const [name, value] of installScripts) {
    assert.ok(value.resolved.startsWith('https://registry.npmjs.org/'));
    assert.equal(manifest.devDependencies[name.slice('node_modules/'.length)], value.version);
  }
});

test('CI enables only locked Chrome download despite the local skipDownload default', () => {
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/ecs-architecture.yml', import.meta.url), 'utf8');
  const environment = { PUPPETEER_SKIP_DOWNLOAD: 'false', PUPPETEER_CHROME_SKIP_DOWNLOAD: 'false', PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD: 'true', PUPPETEER_FIREFOX_SKIP_DOWNLOAD: 'true' };
  for (const [name, value] of Object.entries(environment)) assert.ok(workflow.includes(`${name}: '${value}'`));
  assert.doesNotMatch(workflow, /dangerously-allow-all-scripts|--allow-scripts=/);
  assert.ok(workflow.includes('npm ci --foreground-scripts'));
  assert.ok(workflow.includes('npm exec --yes=false -- puppeteer browsers install chrome'));
  assert.ok(workflow.indexOf('browsers install chrome') < workflow.indexOf("if(!fs.existsSync(browser))"));
  const source = "import {getConfiguration} from 'puppeteer/internal/getConfiguration.js';const c=await getConfiguration();console.log(JSON.stringify({skip:c.skipDownload,chrome:c.chrome.skipDownload,shell:c['chrome-headless-shell'].skipDownload,firefox:c.firefox.skipDownload}));";
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: packageRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...environment } }));
  assert.deepEqual(result, { skip: false, chrome: false, shell: true, firefox: true });
});

test('CI rejects tracked file changes after packaging and before artifact uploads', () => {
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/ecs-architecture.yml', import.meta.url), 'utf8');
  const packaging = workflow.indexOf('      - name: Package and check static Pages files');
  const verification = workflow.indexOf('      - name: Verify generation leaves tracked files unchanged');
  const upload = workflow.indexOf('      - name: Preserve execution logs');
  assert.ok(packaging >= 0 && verification > packaging && upload > verification);
  const check = workflow.indexOf('npm run maintain --prefix docs/diagrams -- check-pages', packaging);
  assert.ok(check > packaging && check < verification);
  const step = workflow.slice(verification, workflow.indexOf('      - name:', verification + 1));
  assert.match(step, /^\s{10}git diff --exit-code\s*$/m);
  assert.match(step, /^\s{10}git diff --cached --exit-code\s*$/m);
  assert.doesNotMatch(step, /^\s+(?:if|continue-on-error):/m);
});

test('CI preserves the compiler model, call graph and failed routing diagnostics after generation failure', () => {
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/ecs-architecture.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('      - name: Preserve complete audit outputs');
  assert.ok(start >= 0);
  const step = workflow.slice(start, workflow.indexOf('      - name:', start + 1));
  assert.match(step, /^\s{8}if: \$\{\{ always\(\) \}\}\s*$/m);
  for (const filename of ['facts.json', 'runtime.json', 'model.json', 'model.calls.ndjson']) {
    assert.ok(step.split(/\r?\n/).some(line => line.trim() === `tmp/ecs-architecture/compiler/${filename}`));
  }
  const logStart = workflow.indexOf('      - name: Preserve execution logs');
  assert.ok(logStart >= 0);
  const logs = workflow.slice(logStart, workflow.indexOf('      - name:', logStart + 1));
  assert.match(logs, /^\s{8}if: \$\{\{ always\(\) \}\}\s*$/m);
  assert.deepEqual(logs.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('tmp/ecs-architecture/routing/')), [
    'tmp/ecs-architecture/routing/*-failed.json', 'tmp/ecs-architecture/routing/*-failed.svg',
  ]);
});

test('CI saves the compact Markdown report before appending the same bytes to the job summary', () => {
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/ecs-architecture.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('      - name: Summarize execution and remaining resources');
  assert.ok(start >= 0);
  const step = workflow.slice(start, workflow.indexOf('      - name:', start + 1));
  assert.match(step, /^\s{8}if: \$\{\{ always\(\) \}\}\s*$/m);
  const save = step.indexOf('report --format markdown > tmp/ecs-architecture/maintenance-summary.md');
  const append = step.indexOf('cat tmp/ecs-architecture/maintenance-summary.md | tee -a "$GITHUB_STEP_SUMMARY"');
  assert.ok(save >= 0 && append > save);
  const logStart = workflow.indexOf('      - name: Preserve execution logs');
  assert.ok(logStart >= 0);
  const logs = workflow.slice(logStart, workflow.indexOf('      - name:', logStart + 1));
  assert.ok(logs.split(/\r?\n/).some(line => line.trim() === 'tmp/ecs-architecture/maintenance-summary.md'));
});

test('CI saves only geometry candidates after failures with a unique key and compatible restore prefixes', () => {
  const workflow = fs.readFileSync(new URL('../../../.github/workflows/ecs-architecture.yml', import.meta.url), 'utf8');
  const restoreStart = workflow.indexOf('      - name: Restore checked geometry candidates');
  const saveStart = workflow.indexOf('      - name: Preserve checked geometry candidates');
  const verified = workflow.indexOf('      - name: Verify generation leaves tracked files unchanged');
  const upload = workflow.indexOf('      - name: Preserve execution logs');
  assert.ok(restoreStart >= 0 && verified > restoreStart && saveStart > verified && upload > saveStart);
  const restore = workflow.slice(restoreStart, workflow.indexOf('      - name:', restoreStart + 1));
  const save = workflow.slice(saveStart, workflow.indexOf('      - name:', saveStart + 1));
  const sha = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
  assert.ok(restore.includes(`uses: actions/cache/restore@${sha}`));
  assert.ok(save.includes(`uses: actions/cache/save@${sha}`));
  assert.match(restore, /^\s{8}id: geometry\s*$/m);
  assert.ok(save.includes("if: ${{ always() && steps.geometry.outcome == 'success' }}"));
  assert.ok(save.includes('key: ${{ steps.geometry.outputs.cache-primary-key }}'));
  for (const step of [restore, save]) {
    assert.deepEqual(step.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('path:')), [
      'path: tmp/ecs-architecture/mermaid-build/geometry-cache',
    ]);
    assert.doesNotMatch(step, /facts|runtime|compiler|save-always/);
  }
  const family = "ecs-geometry-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('docs/diagrams/package-lock.json') }}-";
  const exact = family + "${{ hashFiles('docs/diagrams/src/**') }}-";
  assert.ok(restore.includes(`key: ${exact}` + '${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.deepEqual(restore.split('restore-keys: |')[1].trim().split(/\r?\n/).map(line => line.trim()), [exact, family]);
  const browserStart = workflow.indexOf('      - name: Restore locked browser');
  assert.ok(browserStart >= 0);
  const browser = workflow.slice(browserStart, workflow.indexOf('      - name:', browserStart + 1));
  assert.ok(browser.includes(`uses: actions/cache@${sha}`));
  assert.ok(browser.includes('path: tmp/ecs-architecture/puppeteer'));
});

test('the installed pinned Puppeteer CLI propagates an HTTP download failure without installing another package', async t => {
  const temporary = fileURLToPath(new URL('../../../tmp/ecs-architecture/browser-install-tests/', import.meta.url));
  fs.mkdirSync(temporary, { recursive: true });
  const cache = fs.mkdtempSync(path.join(temporary, 'rejected-download-')), requests = [];
  const server = http.createServer((request, response) => { requests.push(request.url); response.writeHead(404); response.end('Fixture download rejected'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(cache, { recursive: true, force: true }); });
  const npm = npmCommand();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(npm.command, [...npm.args, 'exec', '--yes=false', '--', 'puppeteer', 'browsers', 'install', 'chrome', '--base-url', `http://127.0.0.1:${server.address().port}`], {
      cwd: packageRoot, windowsHide: true, env: { ...process.env, PUPPETEER_CACHE_DIR: cache, PUPPETEER_CHROME_VERSION: '', NO_PROXY: '127.0.0.1,localhost' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.notEqual(result.code, 0); assert.equal(result.signal, null);
  assert.ok(requests.length > 0); assert.ok(requests.every(url => /\/chrome-[^/]+\.zip$/.test(url)));
  assert.match(result.stderr, /404|All providers failed/);
  assert.doesNotMatch(result.stderr, /Skipping browser installation because the Puppeteer build is not available/);
});
