import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  const environment = { PUPPETEER_SKIP_DOWNLOAD: 'false', PUPPETEER_CHROME_SKIP_DOWNLOAD: 'false', PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD: 'true' };
  for (const [name, value] of Object.entries(environment)) assert.ok(workflow.includes(`${name}: '${value}'`));
  assert.doesNotMatch(workflow, /dangerously-allow-all-scripts|--allow-scripts=/);
  const source = "import {getConfiguration} from 'puppeteer/internal/getConfiguration.js';const c=await getConfiguration();console.log(JSON.stringify({skip:c.skipDownload,chrome:c.chrome.skipDownload,shell:c['chrome-headless-shell'].skipDownload}));";
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: packageRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...environment } }));
  assert.deepEqual(result, { skip: false, chrome: false, shell: true });
});
