import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import puppeteer from 'puppeteer';
import { instance as graphvizInstance } from '@viz-js/viz';
import { compileScheduleGuideSamples } from './schedule-legend-compiler.mjs';
import { VIEWER_BACKGROUND } from './viewer-theme.mjs';
import { renderMermaid } from '@mermaid-js/mermaid-cli';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { svgElements, shapeBounds } from './svg-shape-geometry.mjs';
import { NODE_STYLES, EDGE_STYLES, mermaidStyleDefinitions } from './architecture-style.mjs';

import { mermaidConfiguration } from './architecture-renderer.mjs';
import { createMermaidCheckPool } from './mermaid-check-pool.mjs';
import { normalizeMermaidSvg, compileRoutedView as compileRoutedViewCore, measureNativeLabelBounds } from './mermaid-core.mjs';
import { repositoryRoot as root } from './paths.mjs';
import { createMermaidCache, mermaidDependencyIdentity, mermaidRenderIdentity, restoreMermaidGeometry } from './mermaid-cache.mjs';
export { normalizeMermaidSvg, routedMermaid } from './mermaid-core.mjs';

const elements = node => [...node.getElementsByTagName('*')];
const hasClass = (node, value) => (node.getAttribute('class') || '').split(/\s+/).includes(value);

// 默认预留两个核心；显式设置可使用更多核心，但最多同时运行 32 个编译任务。
export function mermaidJobCount({ environment = process.env, parallelism = availableParallelism() } = {}) {
  const configured = environment.MERMAID_JOBS;
  if (configured === undefined) return Math.min(12, Math.max(1, parallelism - 2));
  if (typeof configured !== 'string' || !/^[1-9]\d*$/.test(configured) || Number(configured) > 32)
    throw new Error('MERMAID_JOBS must be an integer from 1 to 32');
  return Number(configured);
}

// 每项仍自行管理独立编译页；只限制同时任务数，并按原清单位置收集结果。
export async function compileMermaidViews(views, compile, { jobs = mermaidJobCount() } = {}) {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 32) throw new Error('Mermaid job count must be an integer from 1 to 32');
  const batches = [...views], compiled = new Array(batches.length);
  let next = 0, failed = false, failure;
  // 首次失败后停止领新图，等待已开始的独立页收尾，再让调用者关闭浏览器。
  await Promise.allSettled(Array.from({ length: Math.min(jobs, batches.length) }, async () => {
    while (!failed && next < batches.length) {
      const index = next++;
      try { compiled[index] = await compile(batches[index]); }
      catch (error) { if (!failed) { failed = true; failure = error; } throw error; }
      await setImmediate();
    }
  }));
  if (failed) throw failure;
  return compiled;
}

// maxEdges 是 Mermaid 的安全配置，须在每次初始化时按当前候选的全部边设置。
export function mermaidInitializeConfig({ aspect, mermaid = '', links = [], scheduleLinks = [], layoutLinks = [] }) {
  return { startOnLoad: false, maxTextSize: Math.max(mermaidConfiguration(aspect).maxTextSize, mermaid.length),
    maxEdges: Math.max(500, links.length + scheduleLinks.length + layoutLinks.length) };
}

// 同一图的所有候选共享独立上下文，避免同源页面挤在同一 Chrome renderer 中。
export async function withMermaidContext(browser, compile) {
  const context = await browser.createBrowserContext();
  let failure;
  try { return await compile({ newPage: () => context.newPage() }); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await context.close(); }
    catch (error) { if (!failure) throw error; }
  }
}

function chromiumPath() {
  if (process.env.MERMAID_CHROMIUM_PATH) {
    if (!fs.existsSync(process.env.MERMAID_CHROMIUM_PATH)) throw new Error('MERMAID_CHROMIUM_PATH does not exist');
    return process.env.MERMAID_CHROMIUM_PATH;
  }
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Mermaid needs Chromium; set MERMAID_CHROMIUM_PATH to Chrome/Edge/Chromium');
  return found;
}

// 指南样例只内嵌到 HTML，轮廓与箭头仍由同一 Mermaid 编译器生成。
export async function compileGuideSamples(browser) {
  const samples = { nodes: {}, edges: {} };
  async function sample(kind, type) {
    const id = `guide-${kind}-${type}`;
    // Classic 的部分形状仍经 Rough.js 生成；非零种子使内嵌指南可重复构建。
    const lines = ['---', JSON.stringify({ config: { ...mermaidConfiguration('systems'), handDrawnSeed: 1 } }), '---', 'flowchart LR'];
    lines.push(...mermaidStyleDefinitions(kind === 'node' ? [type] : [], kind === 'edge' ? [type] : []));
    if (kind === 'node') {
      // 占位文字只参与原生形状的尺寸计算，样例的含义由旁边的 HTML 标签表达。
      lines.push(`g_node@{ shape: ${NODE_STYLES[type].shape}, label: "MMMMMM" }`, `class g_node node_${type}`);
    } else lines.push('g_from@{ shape: anchor, label: " " }', 'g_to@{ shape: anchor, label: " " }', 'g_from g_edge@--> g_to', `class g_edge edge_${type}`);
    const source = lines.join('\n');
    const { data } = await renderMermaid(browser, source, 'svg', { fontEmbed: false, svgId: id, backgroundColor: 'transparent',
      mermaidConfig: mermaidInitializeConfig({ aspect: 'systems', mermaid: source, links: kind === 'edge' ? [{ id: 'g_edge' }] : [] }) });
    const document = new DOMParser().parseFromString(Buffer.from(data).toString('utf8'), 'image/svg+xml');
    const svg = document.documentElement, all = elements(svg);
    if (kind === 'node') {
      const node = all.find(item => hasClass(item, 'node'));
      for (const label of elements(node).filter(item => hasClass(item, 'label'))) label.parentNode.removeChild(label);
      for (const part of elements(node).filter(item => ['rect', 'path', 'polygon', 'polyline', 'circle', 'ellipse', 'line'].includes(item.localName))) part.setAttribute('data-guide-shape-part', 'true');
      svg.setAttribute('data-visual-type', type); svg.setAttribute('data-shape', NODE_STYLES[type].shape);
    } else {
      const edge = all.find(item => item.localName === 'path' && item.getAttribute('data-id') === 'g_edge');
      if (!edge) throw new Error(`Missing guide edge: ${type}`);
      edge.setAttribute('data-guide-edge', 'true');
      svg.setAttribute('data-edge-semantic', type);
      for (const node of all.filter(item => hasClass(item, 'node'))) node.parentNode.removeChild(node);
    }
    for (const element of all) element.removeAttribute('data-id');
    if (kind === 'node') {
      const boxes = svgElements(new XMLSerializer().serializeToString(svg)).filter(item => item.attrs['data-guide-shape-part']).map(shapeBounds);
      const x = Math.min(...boxes.map(box => box.x)) - 5, y = Math.min(...boxes.map(box => box.y)) - 5;
      const width = Math.max(...boxes.map(box => box.x + box.width)) - x + 5, height = Math.max(...boxes.map(box => box.y + box.height)) - y + 5;
      svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    }
    const bounds = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    svg.setAttribute('width', String(bounds[2])); svg.setAttribute('height', String(bounds[3]));
    svg.setAttribute('style', 'background:transparent'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', (kind === 'node' ? NODE_STYLES[type] : EDGE_STYLES[type]).legendLabel);
    svg.setAttribute('data-diagram-engine', 'mermaid'); svg.setAttribute('data-guide-kind', kind);
    return new XMLSerializer().serializeToString(svg);
  }
  for (const type of Object.keys(NODE_STYLES)) samples.nodes[type] = await sample('node', type);
  for (const type of Object.keys(EDGE_STYLES)) samples.edges[type] = await sample('edge', type);
  console.log('Mermaid: guide samples');
  return samples;
}

// 延后 CLI 的页面关闭，仅在绘图成功后测量标题，再统一回收，保留原始绘图异常。
export async function withMeasuredMermaidPage(browser, viewId, render) {
  let page, close, failure, stage = 'render';
  const measuredBrowser = { newPage: async () => {
    page = await browser.newPage();
    close = page.close.bind(page);
    page.close = async () => {};
    return page;
  } };
  try {
    const result = await render(measuredBrowser);
    stage = 'measure';
    const bounds = await page.evaluate(measureNativeLabelBounds);
    return { result, bounds };
  } catch (error) {
    failure = error;
    throw new Error(`Mermaid ${stage} failed: ${viewId}: ${error.message}`, { cause: error });
  } finally {
    if (close) {
      try { await close(); }
      catch (error) {
        if (!failure) throw new Error(`Mermaid page close failed: ${viewId}: ${error.message}`, { cause: error });
      }
    }
  }
}

export async function compileNativeView(browser, view, registry) {
  const { result, bounds } = await withMeasuredMermaidPage(browser, view.id, measuredBrowser =>
    renderMermaid(measuredBrowser, view.mermaid, 'svg', {
      fontEmbed: false, svgId: view.id, backgroundColor: VIEWER_BACKGROUND, mermaidConfig: mermaidInitializeConfig(view),
    }));
  return normalizeMermaidSvg(view, Buffer.from(result.data).toString('utf8'), registry, { clusterLabelBounds: bounds });
}

async function compileRoutedView(browser, view, registry, checks) {
  return compileRoutedViewCore(view, registry, (candidate, records) => compileNativeView(browser, candidate, records), {
    checks,
    onAttempt({ attempt, layoutError, invalid }) {
      console.log(`Mermaid routing: ${view.id}, attempt ${attempt}, ${[layoutError, ...invalid.map(edge => `${edge.id}[${edge.collisions.map(item => item.id).concat(edge.arrowIssues).join(',')}]`)].filter(Boolean).join('; ')}`);
    },
    onFailure(failure) {
      const diagnostics = path.join(root, 'tmp/ecs-architecture/routing');
      fs.mkdirSync(diagnostics, { recursive: true });
      fs.writeFileSync(path.join(diagnostics, `${view.id}-failed.json`), JSON.stringify(failure));
      fs.writeFileSync(path.join(diagnostics, `${view.id}-failed.svg`), failure.view.svg);
    },
  });
}

export async function compileArchitectureArtifacts(views, registry) {
  const jobs = mermaidJobCount();
  const temporary = path.join(root, 'tmp/ecs-architecture/mermaid-build');
  fs.mkdirSync(temporary, { recursive: true });
  const dependencies = mermaidDependencyIdentity(root);
  const cache = createMermaidCache(root);
  const identities = new Map(views.filter(view => view.mermaid).map(view => [view.id, mermaidRenderIdentity(view, registry, dependencies)]));
  const cacheSummary = { local: 0, shared: 0, published: 0, compiled: 0, rejected: 0 };
  console.log('Mermaid cache candidates: ' + JSON.stringify(cache.plan(views, identities)));
  const profile = fs.mkdtempSync(path.join(temporary, 'profile-'));
  const browser = await puppeteer.launch({ executablePath: chromiumPath(), headless: true, userDataDir: profile });
  const checks = createMermaidCheckPool({ jobs });
  let failure;
  try {
    async function compile(view) {
      if (!view.mermaid) return view;
      const { fingerprint, inputs } = identities.get(view.id);
      const identified = result => ({ ...result, renderFingerprint: fingerprint, renderInputs: inputs });
      for (const candidate of cache.candidates(view, fingerprint)) {
        if (candidate.error) { cacheSummary.rejected++; continue; }
        let result;
        try {
          result = restoreMermaidGeometry(view, candidate.cached);
          await checks.geometry(result);
          if ((await checks.labels(result)).length) throw new Error('Cached native labels are incomplete');
          const inspection = await checks.routes(result);
          if (inspection.edges.some(edge => edge.collisions.length || edge.arrowIssues.length || (edge.axis ? edge.curved : !edge.curved))) throw new Error('Cached native routing is stale');
        } catch (error) {
          if (checks.isFatalError(error)) throw error;
          cacheSummary.rejected++;
          // 几何规则更新后重新编译；缓存不代替本次严格检查。
          continue;
        }
        cacheSummary[candidate.source]++;
        if (candidate.source === 'published' || (candidate.source === 'local' && cache.localDirectory !== cache.sharedDirectory))
          cache.store(fingerprint, inputs, result);
        console.log(`Mermaid cached: ${view.id} (${candidate.source})`);
        return identified(result);
      }
      let result;
      try { result = await withMermaidContext(browser, scopedBrowser => compileRoutedView(scopedBrowser, view, registry, checks)); }
      catch (error) { throw new Error(`Mermaid view failed: ${view.id}: ${error.message}`, { cause: error }); }
      cache.store(fingerprint, inputs, result);
      cacheSummary.compiled++;
      console.log(`Mermaid: ${view.id}`);
      return identified(result);
    }
    const compiled = await compileMermaidViews(views, compile, { jobs });
    const guideSamples = await compileGuideSamples(browser);
    guideSamples.schedule = await compileScheduleGuideSamples(await graphvizInstance(), { DOMParser, XMLSerializer });
    console.log('Mermaid cache: ' + JSON.stringify(cacheSummary));
    return { views: compiled, guideSamples, cacheSummary };
  } catch (error) { failure = error; throw error; }
  finally {
    const closed = await Promise.allSettled([checks.close(), browser.close()]);
    if (!failure) for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}
