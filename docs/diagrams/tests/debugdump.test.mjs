import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { DEBUGDUMP_MANIFEST, sha256, scheduleId, sourceFingerprint, readDebugdump, compileDebugdump, checkDebugdumpViews, normalizeScheduleSvg, obsoleteArchitectureArtifacts } from '../src/debugdump.mjs';
import { renderGraphView } from '../src/architecture-renderer.mjs';
import { compileArchitectureArtifacts } from '../src/mermaid-compiler.mjs';
import { renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { INFRASTRUCTURE_FEATURES } from '../src/architecture-infrastructure.mjs';
import { checkArchitecture, checkScheduleGuideSamples } from '../src/check-ecs.mjs';
import { compileScheduleGuideSamples } from '../src/schedule-legend-compiler.mjs';
import { artifactFile, pathsForRepository } from '../src/paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = path.join(root, 'tmp/debugdump-node-tests');
function fixture() {
  fs.mkdirSync(temporary, { recursive: true });
  const repository = fs.mkdtempSync(path.join(temporary, 'case-'));
  fs.mkdirSync(path.join(repository, 'src'));
  fs.writeFileSync(path.join(repository, 'src/main.rs'), 'fn main() {}\r\n');
  fs.writeFileSync(path.join(repository, 'Cargo.toml'), '[package]\nname="example"\n');
  fs.writeFileSync(path.join(repository, 'Cargo.lock'), '[[package]]\nname = "bevy"\nversion = "0.20.0"\n[[package]]\nname = "bevy_mod_debugdump"\nversion = "0.17.0"\n');
  const schedules = ['main', 'RenderApp'].map(app => {
    const label = 'Update<状态 / "Ready">', id = scheduleId(app, label);
    const dot = 'digraph { subgraph cluster_set { label="ExampleSet"; a [label="first", tooltip="example::first"]; b [label="second", tooltip="example::second"]; a -> b; } }\n';
    const entry = { id, app, label, filename: `schedule-${id}.dot`, sha256: sha256(dot), systemCount: 2 };
    fs.writeFileSync(path.join(repository, entry.filename), dot);
    return entry;
  });
  const manifest = { schemaVersion: 1, bevyVersion: '0.20.0', debugdumpVersion: '0.17.0', exportedAt: 100, target: 'test', features: ['debugdump'], sourceFingerprint: sourceFingerprint(repository), schedules };
  const save = () => fs.writeFileSync(path.join(repository, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { repository, manifest, save };
}

test('Schedule guide validation checks actual Graphviz colors, arrows, identities and safe SVG', async () => {
  const samples = compileScheduleGuideSamples(await instance(), { DOMParser, XMLSerializer });
  assert.doesNotThrow(() => checkScheduleGuideSamples(samples));
  const changed = edit => { const copy = structuredClone(samples); edit(copy); return copy; };
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { delete copy.nodes.context; })), /catalog mismatch/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.nodes.system = copy.nodes.system.replace('stroke="#3567a6"', 'stroke="#ff0000"'); })), /appearance mismatch/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.edges.order = copy.edges.set_membership; })), /identity mismatch/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.nodes.context = copy.nodes.context.replace('id="guide-schedule-context-graph"', 'id="guide-schedule-system-graph"'); })), /Duplicate read guide SVG ID/);
  assert.throws(() => checkScheduleGuideSamples(changed(copy => { copy.nodes.system = copy.nodes.system.replace('</svg>', '<script/></svg>'); })), /Unexpected Graphviz SVG element/);
});

test('Schedule guide validation rejects opaque backgrounds, visible labels and narrow or unevenly framed samples', async () => {
  const samples = compileScheduleGuideSamples(await instance(), { DOMParser, XMLSerializer });
  const changed = (section, kind, edit) => {
    const copy = structuredClone(samples), document = new DOMParser().parseFromString(copy[section][kind], 'image/svg+xml');
    edit(document, document.documentElement);
    copy[section][kind] = new XMLSerializer().serializeToString(document.documentElement);
    return copy;
  };
  const classOf = (document, name) => [...document.getElementsByTagName('g')].find(element => (element.getAttribute('class') || '').split(/\s+/).includes(name));
  const addBackground = (document, fill, stroke = 'transparent') => {
    const graph = classOf(document, 'graph');
    const polygon = [...graph.childNodes].find(element => element.localName === 'polygon') || document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '0,0 1,0 1,1 0,1'); polygon.setAttribute('fill', fill); polygon.setAttribute('stroke', stroke);
    if (!polygon.parentNode) graph.insertBefore(polygon, graph.firstChild);
  };
  for (const section of ['nodes', 'edges']) for (const kind of Object.keys(samples[section])) {
    assert.doesNotThrow(() => checkScheduleGuideSamples(changed(section, kind, document => addBackground(document, 'transparent'))));
    for (const [fill, stroke] of [['#FFFFFF', 'transparent'], ['transparent', '#F6F8FB']]) {
      assert.throws(() => checkScheduleGuideSamples(changed(section, kind, document => addBackground(document, fill, stroke))), /background is not transparent/);
    }
    for (const tag of ['text', 'tspan']) assert.throws(() => checkScheduleGuideSamples(changed(section, kind, (document, root) => {
      const label = document.createElementNS('http://www.w3.org/2000/svg', tag); label.textContent = 'System'; root.appendChild(label);
    })), /Unexpected visible text/);
    assert.throws(() => checkScheduleGuideSamples(changed(section, kind, (_, root) => {
      const [x, y, width, height] = root.getAttribute('viewBox').split(/\s+/).map(Number);
      root.setAttribute('viewBox', [x - 1, y, width + 2, height].join(' ')); root.setAttribute('width', String(width + 2));
    })), /padding mismatch/);
  }
  for (const kind of Object.keys(samples.nodes)) assert.throws(() => checkScheduleGuideSamples(changed('nodes', kind, document => {
    classOf(document, kind === 'system_set' ? 'cluster' : 'node').setAttribute('transform', 'scale(0.2 1)');
  })), /node is not horizontal/);
  assert.throws(() => checkScheduleGuideSamples(changed('nodes', 'system', (document, root) => {
    const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rectangle.setAttribute('width', '10'); rectangle.setAttribute('height', '10'); rectangle.setAttribute('fill', '#FFFFFF'); root.appendChild(rectangle);
  })), /background is not transparent/);
});

test('source fingerprints ignore CRLF differences but include source and lock changes', t => {
  const { repository } = fixture(t);
  const before = sourceFingerprint(repository);
  fs.writeFileSync(path.join(repository, 'src/main.rs'), 'fn main() {}\n');
  assert.equal(sourceFingerprint(repository), before);
  fs.appendFileSync(path.join(repository, 'Cargo.lock'), '# changed\n');
  assert.notEqual(sourceFingerprint(repository), before);
});

test('real Graphviz renders DOT for identically named schedules in separate applications', async t => {
  const { repository } = fixture(t);
  const result = await compileDebugdump(readDebugdump(repository, repository));
  assert.equal(result.views.length, 2);
  assert.notEqual(result.views[0].id, result.views[1].id);
  for (const view of result.views) {
    assert.equal(view.engine, 'graphviz');
    assert.match(view.svg, /<text[^>]*>first<\/text>/);
    assert.match(view.svg, /<path /);
    assert.match(view.svg, /<polygon /);
    assert.ok(view.width > 0 && view.height > 0);
    assert.deepEqual(view.nodes, []);
    assert.deepEqual(view.legendKinds, ['system', 'system_set', 'order']);
    fs.writeFileSync(path.join(repository, view.filename), view.svg);
    fs.writeFileSync(path.join(repository, view.dotFilename), view.dot);
  }
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  assert.deepEqual(checkDebugdumpViews(repository, repository, result.views), result.manifest);
  const legendKinds = result.views[0].legendKinds;
  result.views[0].legendKinds = ['system'];
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /legend categories mismatch/);
  result.views[0].legendKinds = legendKinds;
  const node = result.views[0].scheduleGraph.nodes[0], tooltip = node.attributes.tooltip;
  node.attributes.tooltip = 'invented::system';
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /model hash mismatch/);
  node.attributes.tooltip = tooltip;
  const theme = result.manifest.renderer.themeSha256;
  result.manifest.renderer.themeSha256 = 'altered';
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /theme or model/);
  result.manifest.renderer.themeSha256 = theme;
  fs.writeFileSync(path.join(repository, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  result.views[0].svg += '\n';
  assert.throws(() => checkDebugdumpViews(repository, repository, result.views), /SVG hash mismatch/);
});

test('missing, stale, duplicate and altered exports fail before compilation', t => {
  const { repository, manifest, save } = fixture(t);
  const filename = path.join(repository, 'manifest.json');
  fs.renameSync(filename, filename + '.saved');
  assert.throws(() => readDebugdump(repository, repository), /Missing debugdump manifest/);
  save();
  manifest.schedules.push(manifest.schedules[0]); save();
  assert.throws(() => readDebugdump(repository, repository), /duplicate/);
  manifest.schedules.pop(); save();
  fs.appendFileSync(path.join(repository, manifest.schedules[0].filename), ' ');
  assert.throws(() => readDebugdump(repository, repository), /hash mismatch/);
  fs.appendFileSync(path.join(repository, 'src/main.rs'), '// changed');
  assert.throws(() => readDebugdump(repository, repository), /fingerprint is stale/);
});

test('export provenance, filenames and file presence are verified', t => {
  const { repository, manifest, save } = fixture(t);
  manifest.debugdumpVersion = '0.16.0'; save();
  assert.throws(() => readDebugdump(repository, repository), /dependency version mismatch/);
  manifest.debugdumpVersion = '0.17.0';
  const entry = manifest.schedules[0], filename = entry.filename;
  entry.filename = '../outside.dot'; save();
  assert.throws(() => readDebugdump(repository, repository), /Unsafe/);
  entry.filename = filename; save();
  fs.unlinkSync(path.join(repository, filename));
  assert.throws(() => readDebugdump(repository, repository), /Missing debugdump DOT/);
});

test('SVG normalization keeps native geometry and rejects executable or external content', () => {
  const contents = '<svg xmlns="http://www.w3.org/2000/svg" width="20pt" height="10pt" viewBox="0 0 20 10"><path d="M1,2 L3,4"/></svg>';
  const normalized = normalizeScheduleSvg(contents, 'schedule-example');
  assert.match(normalized.svg, /width="20"/);
  assert.match(normalized.svg, /d="M1,2 L3,4"/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<script/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<a href="https:\/\/example.com"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<image href="data:image/svg+xml,invalid"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<path fill="url(https://example.com)"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('<path', '<path style="fill:red"/><path'), 'bad'), /Unexpected/);
  assert.throws(() => normalizeScheduleSvg(contents.replace('0 0 20 10', '0 0 NaN 10'), 'bad'), /viewBox/);
});

test('artifact cleanup removes old overviews and systems while retaining exact object and schedule outputs', t => {
  const { repository } = fixture(t);
  const files = ['ecs-overview.svg', 'ecs-overview.mmd', 'ecs-plugin-ui-systems.svg', 'ecs-infrastructure-systems.mmd', 'ecs-third-party-kira-systems.svg', 'ecs-object-kept.svg', 'ecs-object-kept.mmd', 'ecs-schedule-kept.dot', 'ecs-schedule-kept.svg'];
  files.forEach(file => fs.writeFileSync(path.join(repository, file), ''));
  const views = [{ filename: 'ecs-object-kept.svg', mermaidFilename: 'ecs-object-kept.mmd' }, { filename: 'ecs-schedule-kept.svg', dotFilename: 'ecs-schedule-kept.dot' }];
  assert.deepEqual(obsoleteArchitectureArtifacts(repository, views).sort(), files.slice(0, 5).sort());
});

test('classified cleanup removes only unlisted managed graph artifacts and preserves data, legends and unrelated files', t => {
  const { repository } = fixture(t), paths = pathsForRepository(repository);
  const views = [{ aspect: 'object', filename: 'ecs-object-kept.svg', mermaidFilename: 'ecs-object-kept.mmd' }, { aspect: 'schedule', filename: 'ecs-schedule-kept.svg', dotFilename: 'ecs-schedule-kept.dot' }];
  for (const directory of [paths.objectSvgDirectory, paths.scheduleSvgDirectory, paths.mermaidDirectory, paths.dotDirectory, paths.dataDirectory, paths.legendSvgDirectory]) fs.mkdirSync(directory, { recursive: true });
  for (const view of views) for (const kind of ['svg', ...(view.mermaidFilename ? ['mermaid'] : []), ...(view.dotFilename ? ['dot'] : [])]) fs.writeFileSync(artifactFile(paths, view, kind), '');
  const stale = ['svg/object/ecs-object-old.svg', 'svg/schedule/ecs-schedule-old.svg', 'mermaid/ecs-object-old.mmd', 'dot/ecs-schedule-old.dot'];
  for (const filename of [...stale, 'data/ecs-object-old.svg', 'svg/legend/ecs-legend.svg', 'svg/object/README.md', 'dot/debugdump-manifest.json']) fs.writeFileSync(path.join(paths.generatedDirectory, filename), '');
  fs.mkdirSync(path.join(paths.objectSvgDirectory, 'ecs-directory.svg'));
  assert.deepEqual(obsoleteArchitectureArtifacts(paths, views).sort(), [...stale].sort());
});

test('classified Schedule validation reads DOT and manifest separately from SVG without accepting a flat fallback', async t => {
  const { repository } = fixture(t), paths = pathsForRepository(repository);
  const result = await compileDebugdump(readDebugdump(repository, repository));
  fs.mkdirSync(paths.dotDirectory, { recursive: true }); fs.mkdirSync(paths.scheduleSvgDirectory, { recursive: true });
  fs.writeFileSync(path.join(paths.dotDirectory, DEBUGDUMP_MANIFEST), JSON.stringify(result.manifest));
  for (const view of result.views) {
    fs.writeFileSync(artifactFile(paths, view, 'dot'), view.dot); fs.writeFileSync(artifactFile(paths, view), view.svg);
  }
  assert.deepEqual(checkDebugdumpViews(paths.dotDirectory, repository, result.views), result.manifest);
  const first = result.views[0];fs.writeFileSync(path.join(paths.dotDirectory, first.filename), first.svg);fs.unlinkSync(artifactFile(paths, first));
  assert.throws(() => checkDebugdumpViews(paths.dotDirectory, repository, result.views), /ENOENT/);
});
