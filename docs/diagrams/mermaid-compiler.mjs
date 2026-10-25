import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { renderMermaid } from '@mermaid-js/mermaid-cli';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { svgElements, shapeBounds } from './svg-shape-geometry.mjs';
import { NODE_STYLES, EDGE_STYLES, mermaidStyleDefinitions } from './architecture-style.mjs';

import { mermaidConfiguration } from './architecture-renderer.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';
import { inspectViewRoutes } from './architecture-routing.mjs';
import { normalizeMermaidSvg, compileRoutedView as compileRoutedViewCore, measureNativeLabelBounds } from './mermaid-core.mjs';
export { normalizeMermaidSvg, routedMermaid } from './mermaid-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const elements = node => [...node.getElementsByTagName('*')];
const hasClass = (node, value) => (node.getAttribute('class') || '').split(/\s+/).includes(value);

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
async function compileGuideSamples(browser) {
  const samples = { nodes: {}, edges: {} };
  async function sample(kind, type) {
    const id = `guide-${kind}-${type}`;
    const lines = ['---', JSON.stringify({ config: mermaidConfiguration('systems') }), '---', 'flowchart LR'];
    lines.push(...mermaidStyleDefinitions(kind === 'node' ? [type] : [], kind === 'edge' ? [type] : []));
    if (kind === 'node') {
      // 占位文字只参与原生形状的尺寸计算，样例的含义由旁边的 HTML 标签表达。
      lines.push(`g_node@{ shape: ${NODE_STYLES[type].shape}, label: "MMMMMM" }`, `class g_node node_${type}`);
    } else lines.push('g_from@{ shape: anchor, label: " " }', 'g_to@{ shape: anchor, label: " " }', 'g_from g_edge@--> g_to', `class g_edge edge_${type}`);
    const { data } = await renderMermaid(browser, lines.join('\n'), 'svg', { fontEmbed: false, svgId: id, backgroundColor: 'transparent', mermaidConfig: { startOnLoad: false, maxTextSize: mermaidConfiguration('systems').maxTextSize } });
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

// CLI 仍负责全部绘图；在它关闭编译页之前读取原生标题 bbox。
export async function compileNativeView(browser, view, registry) {
  let clusterLabelBounds = {};
  const measuredBrowser = { newPage: async () => {
    const page = await browser.newPage(), close = page.close.bind(page);
    page.close = async () => {
      clusterLabelBounds = await page.evaluate(measureNativeLabelBounds);
      await close();
    };
    return page;
  } };
  const { data } = await renderMermaid(measuredBrowser, view.mermaid, 'svg', {
    fontEmbed: false, svgId: view.id, backgroundColor: '#F6F8FB', mermaidConfig: { startOnLoad: false, maxTextSize: mermaidConfiguration(view.aspect).maxTextSize },
  });
  return normalizeMermaidSvg(view, Buffer.from(data).toString('utf8'), registry, { clusterLabelBounds });
}

async function compileRoutedView(browser, view, registry) {
  return compileRoutedViewCore(view, registry, (candidate, records) => compileNativeView(browser, candidate, records), {
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
  const temporary = path.join(root, 'tmp/ecs-architecture/mermaid-build');
  fs.mkdirSync(temporary, { recursive: true });
  const cacheDirectory = path.join(temporary, 'geometry-cache');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const dependencies = fs.readFileSync(path.join(root, 'docs/diagrams/package-lock.json'), 'utf8');
  const profile = fs.mkdtempSync(path.join(temporary, 'profile-'));
  const browser = await puppeteer.launch({ executablePath: chromiumPath(), headless: true, userDataDir: profile });
  try {
    const compiled = [];
    async function compile(view) {
      if (!view.mermaid) return view;
      // 归一化或 SVG 注解规则变化时递增版本；原生源码、依赖及完整标题变化会自动失效。
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ version: 2, id: view.id, definition: view.mermaid, dependencies,
        categories: view.nodes.map(node => [node.id, node.visualType, NODE_STYLES[node.visualType].label]),
        titles: view.nodes.map(node => [node.id, registry[node.id].name, registry[node.id].description, registry[node.id].feature]), componentDetails: view.componentDetails,
      })).digest('hex');
      const cachePath = path.join(cacheDirectory, fingerprint + '.json');
      if (fs.existsSync(cachePath)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const result = { ...view, ...cached.geometry, nodes: view.nodes.map(node => ({ ...node, position: cached.positions[node.id] })),
            scheduleGroups: view.scheduleGroups.map(group => ({ ...group, ...cached.scheduleBounds[group.id] })),
          };
          checkMermaidGeometry(result.svg, result);
          const inspection = inspectViewRoutes(result);
          if (inspection.edges.some(edge => edge.collisions.length || edge.arrowIssues.length || (edge.axis ? edge.curved : !edge.curved))) throw new Error('Cached native routing is stale');
          console.log(`Mermaid cached: ${view.id}`);
          return result;
        } catch { /* 几何规则更新后重新编译；缓存不代替本次严格检查。 */ }
      }
      const result = await compileRoutedView(browser, view, registry);
      const geometry = Object.fromEntries(['svg', 'mermaid', 'width', 'height', 'bounds', 'routing', 'sections', 'entityGroups'].map(key => [key, result[key]]));
      fs.writeFileSync(cachePath, JSON.stringify({ geometry, positions: Object.fromEntries(result.nodes.map(node => [node.id, node.position])),
        scheduleBounds: Object.fromEntries(result.scheduleGroups.map(group => [group.id, group.labelBounds ? { labelBounds: group.labelBounds } : {}])),
      }));
      console.log(`Mermaid: ${view.id}`);
      return result;
    }
    // 各图使用独立页面；有界并行缩短逐对象图的编译时间，清单顺序仍与输入一致。
    const batches = [...views];
    let next = 0;
    compiled.length = batches.length;
    await Promise.all(Array.from({ length: Math.min(6, batches.length) }, async () => {
      while (next < batches.length) {
        const index = next++;
        compiled[index] = await compile(batches[index]);
      }
    }));
    const guideSamples = await compileGuideSamples(browser);
    return { views: compiled, guideSamples };
  } finally { await browser.close(); }
}
