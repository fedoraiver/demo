import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { availableParallelism } from 'node:os';
import { atomicJson, contained, hash, imageValid, loadPlan, locked } from './maintenance-visual.mjs';
import { validateArchitectureSvg } from './architecture-asset-loader.mjs';
import { importDiagramDependency } from './maintenance-paths.mjs';

const overviewBounds = { width: 2400, height: 1800 };
const tileBounds = { width: 2200, height: 1600 };
const checkpointSize = 24;

// 默认保留两个可用核心；显式配置仍限制为最多 32 个独立截图页。
export function visualRenderJobCount({ environment = process.env, parallelism = availableParallelism() } = {}) {
  const configured = environment.MAINTENANCE_VISUAL_JOBS;
  if (configured === undefined) return Math.min(12, Math.max(1, parallelism - 2));
  if (typeof configured !== 'string' || !/^[1-9]\d*$/.test(configured) || Number(configured) > 32)
    throw new Error('MAINTENANCE_VISUAL_JOBS must be an integer from 1 to 32');
  return Number(configured);
}

/** 仅编译静态 SVG；网络、页面脚本和外部引用均不可用。 */
export async function renderVisual({ planPath, from = 1, to, browser }) {
  const loaded = loadPlan(planPath), { plan, planSha256 } = loaded;
  // 批次起止核验全部引用；逐图只核验冻结计划、清单和当前 SVG，避免重复扫描完整调用图。
  const verifyFrozenManifest = () => {
    if (hash(fs.readFileSync(loaded.planPath)) !== planSha256
      || hash(fs.readFileSync(contained(plan.generatedRoot, 'data/manifest.json'))) !== plan.manifestSha256) {
      throw new Error('Frozen visual plan or manifest changed during rendering');
    }
  };
  to ??= plan.items.length;
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < 0 || to > plan.items.length || (plan.items.length && from > to)) throw new Error('Invalid inclusive render range');
  const output = path.dirname(loaded.planPath), recordsPath = path.join(output, 'render-records.json');
  return locked(recordsPath, async () => {
    const previous = fs.existsSync(recordsPath) ? JSON.parse(fs.readFileSync(recordsPath, 'utf8')) : { schemaVersion: 2, planSha256, records: [] };
    if (previous.schemaVersion !== 2 || previous.planSha256 !== planSha256 || !Array.isArray(previous.records)) throw new Error('Render manifest belongs to different frozen inputs');
    const planned = new Map(plan.items.map(item => [item.path, item]));
    for (const row of previous.records) {
      const item = planned.get(row.path);
      if (!item || ['path', 'sha256', 'viewId', 'objectId', 'engine', 'kind'].some(field => item[field] !== row[field]) || !Array.isArray(row.images) || !row.images.length || !row.images.every(imageValid)) throw new Error('Existing render proof changed; create a new visual plan');
    }
    const records = new Map(previous.records.map(row => [row.path, row]));
    const selected = plan.items.filter(item => item.sampleIndex >= from && item.sampleIndex <= to && !records.has(item.path));
    if (!selected.length) {
      atomicJson(recordsPath, previous);
      return { renderPath: recordsPath, renderedCount: 0, requiresInspection: false, records: previous.records };
    }
    const jobs = visualRenderJobCount();
    const [{ default: puppeteer }, { DOMParser }] = await Promise.all([importDiagramDependency('puppeteer'), importDiagramDependency('@xmldom/xmldom')]);
    const candidates = browser ? [browser] : [process.env.MERMAID_CHROMIUM_PATH, await puppeteer.executablePath()].filter(Boolean);
    const executablePath = candidates.find(filename => fs.existsSync(filename));
    if (!executablePath) throw new Error('A local compile Chromium executable is required; set MERMAID_CHROMIUM_PATH or browser');
    const pngDirectory = path.join(output, 'png');
    fs.mkdirSync(pngDirectory, { recursive: true });
    const profile = fs.mkdtempSync(path.join(output, 'chromium-profile-'));
    let chromium;
    try {
      chromium = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] });
      async function renderItem(page, item) {
        verifyFrozenManifest();
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
        verifyFrozenManifest();
        return { ...item, status: 'pending', nativeSize: size, overviewScale: scale, overview, nativeTiles, images, renderedAt: new Date().toISOString(), method: 'local Chromium static SVG compilation; pending inspection' };
      }
      let next = 0, failure, unflushed = 0;
      const orderedRecords = () => [...records.values()].sort((a, b) => a.sampleIndex - b.sampleIndex);
      // 全局锁内仅此协调点写记录；批次中断最多丢失尚未落盘的一小批截图缓存。
      const checkpoint = () => {
        verifyFrozenManifest();
        atomicJson(recordsPath, { schemaVersion: 2, planPath: loaded.planPath, planSha256, manifestSha256: plan.manifestSha256,
          browserExecutable: executablePath, records: orderedRecords() });
        unflushed = 0;
      };
      const completed = record => {
        records.set(record.path, record); unflushed++;
        if (unflushed >= checkpointSize) checkpoint();
      };
      const worker = async () => {
        let context, page;
        try {
          context = await chromium.createBrowserContext();
          page = await context.newPage();
          await page.setJavaScriptEnabled(false);
          await page.setRequestInterception(true);
          page.on('request', request => { void request.abort(); });
          // 同一页的预览和原尺寸分块串行截图，页面只由所属 worker 使用。
          while (!failure && next < selected.length) completed(await renderItem(page, selected[next++]));
        } catch (error) { failure ||= error; throw error; }
        finally {
          let closeError;
          for (const resource of [page, context]) if (resource) {
            try { await resource.close(); }
            catch (error) { failure ||= error; closeError ||= error; }
          }
          if (closeError) throw closeError;
        }
      };
      // 等待失败任务和仍在截图的任务全部收尾，再关闭唯一浏览器。
      await Promise.allSettled(Array.from({ length: Math.min(jobs, selected.length) }, worker));
      loadPlan(loaded.planPath);
      verifyFrozenManifest();
      if (failure) throw failure;
      if (unflushed) checkpoint();
      return { renderPath: recordsPath, renderedCount: selected.length, requiresInspection: true, records: orderedRecords() };
    } finally {
      if (chromium) await chromium.close();
      // Windows may retain Chromium file handles briefly after its close promise.
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
