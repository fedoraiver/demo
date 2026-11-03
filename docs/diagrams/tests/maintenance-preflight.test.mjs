import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareArchitecture } from '../src/architecture-preparation.mjs';

test('preparation requires compiler evidence and never falls back to an authored semantic catalog', async t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const parent = path.join(repository, 'tmp/ecs-architecture/preparation-tests'); fs.mkdirSync(parent, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(parent, 'missing-compiler-')); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'docs/diagrams/catalog'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs/diagrams/catalog/ecs-data.json'), JSON.stringify({ systems: [{ id: 'authored-guess' }] }));
  await assert.rejects(prepareArchitecture({ workspace }), /Missing compiler architecture model/);
});

test('preparation imports presentation and frozen evidence only', () => {
  const source = fs.readFileSync(new URL('../src/architecture-preparation.mjs', import.meta.url), 'utf8');
  assert.match(source, /readCompilerModel/); assert.match(source, /bindCompilerSchedules/);
  assert.doesNotMatch(source, /execFile|puppeteer|source-locator|ecs-data|source-policy|buildScheduleObjects|buildComponentCatalog/);
});
