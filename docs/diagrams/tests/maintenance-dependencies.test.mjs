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
