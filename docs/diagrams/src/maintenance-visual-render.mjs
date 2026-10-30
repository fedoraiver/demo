import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson, contained, hash, imageValid, loadPlan, locked } from './maintenance-visual.mjs';
import { validateArchitectureSvg } from './architecture-asset-loader.mjs';

const overviewBounds = { width: 2400, height: 1800 };
const tileBounds = { width: 2200, height: 1600 };

/** 仅编译静态 SVG；网络、页面脚本和外部引用均不可用。 */
export async function renderVisual({ planPath, from = 1, to, browser }) {
  const loaded = loadPlan(planPath), { plan, planSha256 } = loaded;
  to ??= plan.items.length;
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < 0 || to > plan.items.length || (plan.items.length && from > to)) throw new Error('Invalid inclusive render range');
  const output = path.dirname(loaded.planPath), recordsPath = path.join(output, 'render-records.json');
  return locked(recordsPath, async () => {
    const previous = fs.existsSync(recordsPath) ? JSON.parse(fs.readFileSync(recordsPath, 'utf8')) : { schemaVersion: 2, planSha256, records: [] };
    if (previous.schemaVersion !== 2 || previous.planSha256 !== planSha256 || !Array.isArray(previous.records)) throw new Error('Render manifest belongs to different frozen inputs');
    for (const row of previous.records) {
      const item = plan.items.find(item => item.path === row.path);
      if (!item || ['path', 'sha256', 'viewId', 'objectId', 'engine', 'kind'].some(field => item[field] !== row[field]) || !Array.isArray(row.images) || !row.images.length || !row.images.every(imageValid)) throw new Error('Existing render proof changed; create a new visual plan');
    }
    const selected = plan.items.filter(item => item.sampleIndex >= from && item.sampleIndex <= to && !previous.records.some(row => row.path === item.path));
    if (!selected.length) {
      atomicJson(recordsPath, previous);
      return { renderPath: recordsPath, renderedCount: 0, requiresInspection: false, records: previous.records };
    }
    const [{ default: puppeteer }, { DOMParser }] = await Promise.all([import('puppeteer'), import('@xmldom/xmldom')]);
    const candidates = browser ? [browser] : [process.env.MERMAID_CHROMIUM_PATH, puppeteer.executablePath()].filter(Boolean);
    const executablePath = candidates.find(filename => fs.existsSync(filename));
    if (!executablePath) throw new Error('A local compile Chromium executable is required; set MERMAID_CHROMIUM_PATH or browser');
    const pngDirectory = path.join(output, 'png');
    fs.mkdirSync(pngDirectory, { recursive: true });
    const profile = fs.mkdtempSync(path.join(output, 'chromium-profile-'));
    let chromium;
    const records = new Map(previous.records.map(row => [row.path, row]));
    try {
      chromium = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] });
      const page = await chromium.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', request => { void request.abort(); });
      for (const item of selected) {
        loadPlan(loaded.planPath);
        const source = contained(plan.generatedRoot, item.path), bytes = fs.readFileSync(source);
        if (hash(bytes) !== item.sha256) throw new Error('SVG changed before rendering: ' + item.path);
        const svg = validateArchitectureSvg(bytes.toString('utf8'), { DOMParser });
        const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        if (item.engine !== 'legend' && (element.getAttribute('id') !== item.viewId || element.getAttribute('data-diagram-engine') !== item.engine)) throw new Error('SVG semantic identity differs from manifest: ' + item.path);
        const [, , nativeWidth, nativeHeight] = element.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number);
        await page.setContent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'"><style>html,body{margin:0;padding:0;background:#F6F8FB;overflow:hidden}svg{display:block;max-width:none!important}</style>' + svg);
        const scale = Math.min(1, overviewBounds.width / nativeWidth, overviewBounds.height / nativeHeight);
        const size = { width: nativeWidth, height: nativeHeight }, width = Math.max(1, Math.ceil(nativeWidth * scale)), height = Math.max(1, Math.ceil(nativeHeight * scale));
        const base = String(item.sampleIndex).padStart(4, '0') + '-' + hash(item.path).slice(0, 12);
        const images = [];
        async function capture(filename, viewport, offset, fullSize) {
          await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
          await page.evaluate(({ offset, fullSize }) => {
            const svg = document.querySelector('svg');
            svg.setAttribute('width', fullSize.width); svg.setAttribute('height', fullSize.height);
            Object.assign(svg.style, { width: fullSize.width + 'px', height: fullSize.height + 'px', position: 'absolute', left: -offset.left + 'px', top: -offset.top + 'px' });
          }, { offset, fullSize });
          const imagePath = path.join(pngDirectory, filename), temporary = imagePath + '.' + crypto.randomUUID() + '.png';
          try { await page.screenshot({ path: temporary, type: 'png' }); fs.renameSync(temporary, imagePath); }
          finally { fs.rmSync(temporary, { force: true }); }
          const image = { path: imagePath, sha256: hash(fs.readFileSync(imagePath)) };
          images.push(image); return image;
        }
        const overview = await capture(base + '.png', { width, height }, { left: 0, top: 0 }, { width, height });
        const nativeTiles = [];
        if (scale < 1) {
          for (let row = 0; row < Math.ceil(nativeHeight / tileBounds.height); row++) for (let column = 0; column < Math.ceil(nativeWidth / tileBounds.width); column++) {
            const left = column * tileBounds.width, top = row * tileBounds.height;
            const viewport = { width: Math.min(tileBounds.width, Math.ceil(nativeWidth - left)), height: Math.min(tileBounds.height, Math.ceil(nativeHeight - top)) };
            nativeTiles.push({ row, column, left, top, ...viewport, ...await capture(`${base}-tile-${row}-${column}.png`, viewport, { left, top }, size) });
          }
        }
        if (hash(fs.readFileSync(source)) !== item.sha256) throw new Error('SVG changed while rendering: ' + item.path);
        records.set(item.path, { ...item, status: 'pending', nativeSize: size, overviewScale: scale, overview, nativeTiles, images, renderedAt: new Date().toISOString(), method: 'local Chromium static SVG compilation; pending child inspection' });
        loadPlan(loaded.planPath);
        atomicJson(recordsPath, { schemaVersion: 2, planPath: loaded.planPath, planSha256, manifestSha256: plan.manifestSha256, browserExecutable: executablePath, records: [...records.values()].sort((a, b) => a.sampleIndex - b.sampleIndex) });
      }
      return { renderPath: recordsPath, renderedCount: selected.length, requiresInspection: true, records: [...records.values()].sort((a, b) => a.sampleIndex - b.sampleIndex) };
    } finally {
      if (chromium) await chromium.close();
      // Windows may retain Chromium file handles briefly after its close promise.
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
