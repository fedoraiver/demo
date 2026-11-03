import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { compileNativeView } from '../src/mermaid-compiler.mjs';
import { checkMermaidAccessibility } from '../src/check-ecs.mjs';

const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));

test('native SVG retains complete accessible title and description with Mermaid-sensitive characters', { skip: !chromium, timeout: 60000 }, async () => {
  const label = 'Foo<&mut Vec<T>> & "quote" #35; `code` _ *';
  const summary = '调用 Vec<Item> & 保留 #96; 与 "说明"。';
  const registry = { object: { id: 'object', kind: 'System', feature: 'fixture', name: 'test_system', description: '测试用途。' } };
  const graph = { centerNodeId: 'object', nodes: [{ id: 'object', role: 'internal' }], links: [] };
  const view = renderGraphView({ id: 'accessibility-literals', aspect: 'object', objectId: 'object', centerNodeId: 'object', feature: 'fixture', label, summary }, graph, registry, [{ id: 'fixture', label: '示例' }]);
  const temporary = fileURLToPath(new URL('../../../tmp/mermaid-accessibility-tests/', import.meta.url));
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'profile-')) });
  try {
    const render = mermaid => compileNativeView(browser, { ...view, mermaid }, registry);
    const compiled = await render(view.mermaid);
    assert.doesNotThrow(() => checkMermaidAccessibility(compiled));
    const raw = await render(view.mermaid.replace(/  accTitle: .*/, `  accTitle: ${label}`));
    assert.throws(() => checkMermaidAccessibility(raw), /accessibility title mismatch/);
    const double = await render(view.mermaid.replace(/  accDescr: .*/, '  accDescr: Vec#amp;lt;Item#amp;gt;'));
    assert.throws(() => checkMermaidAccessibility(double), /accessibility desc mismatch/);
  } finally { await browser.close(); }
});
