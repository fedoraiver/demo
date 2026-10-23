import assert from 'node:assert/strict';
import test from 'node:test';
import { compileRoutedView, normalizeMermaidSvg } from './mermaid-core.mjs';

function clearanceFixture(layout, aspect) {
  const view = {
    id: 'clearance-fixture', aspect,
    mermaid: `---\n${JSON.stringify({ config: { layout, flowchart: { nodeSpacing: 32, rankSpacing: 56 } } })}\n---\nflowchart LR\n  n0@{ shape: rect, label: "A" }\n  class n0 node_component\n  n1@{ shape: rect, label: "B" }\n  class n1 node_component\n`,
    nodes: ['a', 'b'].map((id, index) => ({ id, instance: `clearance-${id}`, mermaidId: `n${index}`, visualType: 'component', shape: 'rect', role: 'internal' })),
    links: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [], entityGroups: [],
  };
  const registry = { a: { name: 'A', feature: 'test' }, b: { name: 'B', feature: 'test' } };
  function native(candidate, separate) {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 150">'
      + ['a', 'b'].map((id, index) => `<g class="node" id="flowchart-n${index}-0" transform="translate(${separate ? 50 + index * 150 : 50},75)"><rect x="-30" y="-15" width="60" height="30"/></g>`).join('') + '</svg>';
    return normalizeMermaidSvg(candidate, source, registry);
  }
  return { view, registry, native };
}

test('shared native compiler rejects residual overlap after every permitted layout profile', async () => {
  const view = {
    id: 'overlap-fixture', aspect: 'data',
    mermaid: '---\n{"config":{"flowchart":{"nodeSpacing":32,"rankSpacing":24}}}\n---\nflowchart TB\n',
    nodes: ['a', 'b'].map((id, index) => ({ id, instance: `overlap-${id}`, mermaidId: `n${index}`, visualType: 'component', shape: 'rect', role: 'internal' })),
    links: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [], entityGroups: [],
  };
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150">'
    + ['a', 'b'].map((id, index) => `<g class="node" id="flowchart-n${index}-0" transform="translate(100,75)"><rect x="-30" y="-15" width="60" height="30"/></g>`).join('') + '</svg>';
  const registry = { a: { name: 'A', feature: 'test' }, b: { name: 'B', feature: 'test' } }, attempts = [], failures = [];
  let compilations = 0;
  await assert.rejects(compileRoutedView(view, registry, async candidate => {
    compilations++;
    return normalizeMermaidSvg(candidate, source, registry);
  }, { onAttempt: value => attempts.push(value), onFailure: value => failures.push(value) }), /Mermaid routing failed: overlap-fixture: .*overlap/i);
  assert.equal(compilations, 28);
  assert.equal(attempts.length, 28);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].view.id, view.id);
  assert.ok(attempts.every(attempt => /overlap/i.test(attempt.layoutError)));
});

test('Dagre overview retries native card clearance before spacing and returns only the accepted source', async () => {
  const { view, registry, native } = clearanceFixture('dagre', 'overview'), before = view.mermaid, candidates = [];
  const result = await compileRoutedView(view, registry, async candidate => {
    candidates.push(candidate.mermaid);
    return native(candidate, candidate.mermaid.includes('subgraph layout_card_'));
  });
  assert.equal(candidates.length, 2);
  assert.doesNotMatch(candidates[0], /layout_card_/);
  assert.match(candidates[1], /layout_card_/);
  assert.equal(result.mermaid, candidates[1]);
  assert.equal(result.routing.rule, 'axis-or-curve');
  assert.equal(view.mermaid, before);
  assert.deepEqual(view.nodes.map(node => node.id), ['a', 'b']);
});

test('native retry eligibility follows the configured layout rather than the data aspect', async () => {
  const { view, registry, native } = clearanceFixture('elk', 'data');
  let compilations = 0;
  await assert.rejects(compileRoutedView(view, registry, async candidate => { compilations++; return native(candidate, false); }), /Mermaid routing failed/);
  assert.equal(compilations, 1);
});

test('a native source clipping gap retries padding without changing the canonical input or bypassing geometry', async () => {
  const { view, registry } = clearanceFixture('dagre', 'data'), candidates = [], attempts = [];
  view.links = [{ id: 'write', mermaidId: 'e0', from: 'a', to: 'b', kind: 'write', edgeSemantic: 'write' }];
  const before = JSON.stringify(view);
  const result = await compileRoutedView(view, registry, async candidate => {
    const configuration = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(candidate.mermaid)[1]).config;
    candidates.push(configuration.flowchart.padding);
    const start = configuration.flowchart.padding === 4 ? 20 : 49;
    return normalizeMermaidSvg(candidate, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 100">'
      + '<g class="node" id="flowchart-n0-0"><rect x="0" y="40" width="20" height="20"/></g>'
      + '<g class="node" id="flowchart-n1-1"><rect x="180" y="40" width="20" height="20"/></g>'
      + `<path data-id="e0" d="M${start} 50H180"/></svg>`, registry);
  }, { onAttempt: attempt => attempts.push(attempt) });
  assert.deepEqual(candidates, [undefined, 4]);
  assert.deepEqual(attempts[0].invalid[0].arrowIssues, ['path-source-gap']);
  assert.equal(JSON.stringify(view), before);
  assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(result.mermaid)[1]).config.flowchart.padding, 4);
});

test('a degenerate native arrow rejects its layout candidate while compiler failures still propagate', async () => {
  const { view, registry, native } = clearanceFixture('dagre', 'data'), attempts = [];
  let compilations = 0;
  const result = await compileRoutedView(view, registry, async candidate => {
    if (!compilations++) throw new Error('Native Mermaid arrow has no terminal tangent');
    return native(candidate, true);
  }, { onAttempt: value => attempts.push(value) });
  assert.equal(compilations, 2);
  assert.equal(result.routing.rule, 'axis-or-curve');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].layoutError, 'Native Mermaid arrow has no terminal tangent');
  await assert.rejects(compileRoutedView(view, registry, async () => { throw new Error('Browser disconnected'); }), /Browser disconnected/);
  await assert.rejects(compileRoutedView(view, registry, async () => { throw new Error('Native Mermaid arrow has no terminal tangent'); }), /Mermaid routing failed: clearance-fixture: Native Mermaid arrow has no terminal tangent/);
});

test('failed native Entity layouts retry header context once and preserve only the accepted layout metadata', async () => {
  const view = {
    id: 'context-fixture', aspect: 'data',
    mermaid: '---\n{"config":{"layout":"dagre","flowchart":{"nodeSpacing":32,"rankSpacing":8}}}\n---\nflowchart TB\n',
    nodes: [
      { id: 'entity', instance: 'entity-instance', mermaidId: 'n0', visualType: 'entity', shape: 'rect', role: 'internal', presentation: 'entity-container' },
      { id: 'member', instance: 'member-instance', mermaidId: 'n1', visualType: 'component', shape: 'rect', role: 'internal' },
      { id: 'producer', instance: 'producer-instance', mermaidId: 'n2', visualType: 'system', shape: 'rect', role: 'internal' },
    ],
    links: [{ id: 'write-member', mermaidId: 'e0', from: 'producer', to: 'member', kind: 'write', edgeSemantic: 'write' }],
    entityGroups: [{ id: 'entity-group', entity: 'entity', components: ['member'], mermaidId: 'n0', headerMermaidId: 'eh0' }],
    layoutLinks: [], scheduleLinks: [], scheduleGroups: [],
  };
  const registry = Object.fromEntries(view.nodes.map(node => [node.id, { name: node.id, feature: 'test' }])), candidates = [];
  const native = async candidate => {
    candidates.push(candidate);
    const context = candidate.layoutLinks.length > 0;
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 220">'
      + '<g class="cluster" id="context-fixture-n0"><rect x="100" y="10" width="220" height="200"/><g class="cluster-label"/></g>'
      + '<g class="node" id="flowchart-n1-1" transform="translate(190,140)"><rect x="-30" y="-15" width="60" height="30"/></g>'
      + `<g class="node" id="flowchart-n2-2" transform="translate(${context ? 30 : 190},140)"><rect x="-20" y="-15" width="40" height="30"/></g>`
      + '<g class="node" id="flowchart-eh0-3"><g class="label"><text>Entity</text></g></g>'
      + '<path data-id="e0" d="M50,140 L160,140"/>'
      + candidate.layoutLinks.map(link => `<path data-id="${link.mermaidId}" d="M30,100 L140,30"/>`).join('') + '</svg>';
    return normalizeMermaidSvg(candidate, source, registry, { clusterLabelBounds: { eh0: { x: 140, y: 30, width: 100, height: 30 } } });
  };
  const result = await compileRoutedView(view, registry, native);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].layoutLinks.length, 0);
  assert.deepEqual(result.layoutLinks, [{ mermaidId: 'layout_context_0', from: 'n2', to: 'eh0' }]);
  assert.match(result.mermaid, /^  n2 layout_context_0@~~~ eh0$/m);
  assert.deepEqual(result.links, view.links);
  assert.equal(view.layoutLinks.length, 0);
  assert.doesNotMatch(view.mermaid, /layout_context_/);
  assert.equal(result.svg.match(/data-layout-link=/g).length, 1);
});
