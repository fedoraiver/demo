import assert from 'node:assert/strict';
import test from 'node:test';
import { compileRoutedView, normalizeMermaidSvg, nativeLabelMismatches, routedMermaid } from '../src/mermaid-core.mjs';
import { svgElements } from '../src/svg-shape-geometry.mjs';

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

test('type center accessible name and full title use component details without changing projection registry records', () => {
  const { view, registry, native } = clearanceFixture('dagre', 'component');
  view.componentNodeId = 'a'; view.componentDetails = { name: 'A<f32>', description: '完整类型说明' };
  const output = native(view, true), elements = svgElements(output.svg), center = elements.find(element => element.attrs['data-id'] === 'a');
  assert.equal(center.attrs['aria-label'], 'A<f32> · 组件');
  assert.equal(center.children.find(element => element.tag === 'title').text, 'A<f32>');
  assert.equal(elements.find(element => element.attrs['data-id'] === 'b').attrs['aria-label'], 'B · 组件');
  assert.equal(registry.a.name, 'A');
});

test('native label validation detects entities split across rows and ignores title provenance', () => {
  const view = { nodes: [{ id: 'message', displayLabel: 'Messages<AssetEvent<AnimationGraph>>\n说明' }],
    svg: '<svg><g data-id="message"><title>其他来源</title><g class="label"><text><tspan class="row">Messages&lt;AssetEvent&lt;AnimationGraph&amp;</tspan><tspan class="row">gt;&gt;</tspan><tspan class="row">说明</tspan></text></g></g></svg>' };
  assert.deepEqual(nativeLabelMismatches(view), ['message']);
  assert.deepEqual(nativeLabelMismatches({ ...view, svg: view.svg.replace('AnimationGraph&amp;</tspan><tspan class="row">gt;&gt;', 'AnimationGraph&gt;&gt;') }), []);
});

test('native short-title checks reject a full visible name even when hidden provenance is correct', () => {
  const view = { nodes: [{ id: 'method', displayLabel: 'asset_events_condition\n用途' }],
    svg: '<svg><g data-id="method"><title>bevy_asset::Assets&lt;dep::T&gt;::asset_events_condition</title><g class="label"><text><tspan class="row">asset_events_condition</tspan><tspan class="row">用途</tspan></text></g></g></svg>' };
  assert.deepEqual(nativeLabelMismatches(view), []);
  assert.deepEqual(nativeLabelMismatches({ ...view, svg: view.svg.replace('>asset_events_condition<', '>bevy_asset::Assets&lt;dep::T&gt;::asset_events_condition<') }), ['method']);
  assert.deepEqual(nativeLabelMismatches({ ...view, svg: view.svg.replace('>用途<', '>错误用途<') }), ['method']);
});

test('native semantic label wrappers bind canonical edge identities without becoming geometry paths', () => {
  const { view, registry } = clearanceFixture('dagre', 'object');
  view.links = [{ id: 'canonical-read', mermaidId: 'e0', from: 'b', to: 'a', kind: 'read', edgeSemantic: 'read', nativeReverse: true }];
  view.scheduleLinks = [{ id: 'canonical-schedule', mermaidId: 'sc0', from: 'a', to: 'b', edgeSemantic: 'schedule' }];
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 150">'
    + '<g class="node" id="flowchart-n0-0"><rect x="10" y="50" width="40" height="40"/></g>'
    + '<g class="node" id="flowchart-n1-1"><rect x="200" y="50" width="40" height="40"/></g>'
    + '<path data-id="e0" d="M50 70H200"/><path data-id="sc0" d="M50 80H200"/>'
    + ['e0', 'sc0'].map(id => `<g class="edgeLabel"><rect class="outer-background"/><g class="label" data-id="${id}"><rect class="background"/><text>${id}</text></g></g>`).join('') + '</svg>';
  const normalized = normalizeMermaidSvg(view, source, registry), all = svgElements(normalized.svg);
  const wrappers = all.filter(item => (item.attrs.class || '').split(/\s+/).includes('edge-label'));
  assert.deepEqual(wrappers.map(item => [item.attrs['data-link-id'], item.attrs['data-schedule-link-id']]), [['canonical-read', undefined], [undefined, 'canonical-schedule']]);
  assert.ok(wrappers.every(item => !item.attrs.class.split(/\s+/).includes('edge') && item.children.some(child => child.tag === 'rect')));
  assert.equal(all.filter(item => item.attrs['data-native-reverse'] === 'true').length, 1);
  assert.match(normalized.svg, /\.edge\.dim,\.edge-label\.dim\{opacity:\.16\}/);
  assert.deepEqual(normalized.links, view.links);
});

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

test('Component fallback combines native card containers and increased spacing before unwrapped span retries', async () => {
  const { view, registry, native } = clearanceFixture('dagre', 'component'), candidates = [], before = view.mermaid;
  const result = await compileRoutedView(view, registry, async candidate => {
    const configuration = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(candidate.mermaid)[1]).config;
    const wrapped = candidate.mermaid.includes('subgraph layout_card_'), spacing = configuration.flowchart.nodeSpacing - 32;
    candidates.push({ wrapped, spacing });
    return native(candidate, wrapped && spacing >= 16);
  });
  assert.deepEqual(candidates, [{ wrapped: false, spacing: 0 }, { wrapped: true, spacing: 0 }, { wrapped: true, spacing: 16 }]);
  assert.match(result.mermaid, /subgraph layout_card_/);
  assert.equal(view.mermaid, before);
  assert.equal(JSON.parse(/^---\n([\s\S]*?)\n---/.exec(result.mermaid)[1]).config.flowchart.rankSpacing, 72);
});

test('object native retries preserve default success and try selective system containers after general clearance', async () => {
  const { view, registry, native } = clearanceFixture('dagre', 'object'), candidates = [];
  view.nodes[0].visualType = 'system'; view.nodes[1].visualType = 'resource';
  view.mermaid = view.mermaid.replace('class n0 node_component', 'class n0 node_system').replace('class n1 node_component', 'class n1 node_resource');
  const before = structuredClone(view);
  const result = await compileRoutedView(view, registry, async candidate => {
    const wrapped = ['n0', 'n1'].map(id => candidate.mermaid.includes('subgraph layout_card_' + id));
    candidates.push(wrapped);
    return native(candidate, wrapped[0] && !wrapped[1]);
  });
  assert.deepEqual(candidates, [[false, false], [true, true], [true, false]]);
  assert.match(result.mermaid, /subgraph layout_card_n0/);
  assert.doesNotMatch(result.mermaid, /subgraph layout_card_n1/);
  assert.deepEqual(view, before);
  let calls = 0;
  const direct = await compileRoutedView(view, registry, async candidate => { calls++; return native(candidate, true); });
  assert.equal(calls, 1);
  assert.doesNotMatch(direct.mermaid, /layout_card_/);
});

test('near-collinear resource edges try the exact source and target before repeating rank spans', async () => {
  const { view, registry } = clearanceFixture('dagre', 'object'), rejected = [];
  view.nodes[0].visualType = 'system'; view.nodes[1].visualType = 'resource';
  view.mermaid = view.mermaid.replace('class n0 node_component', 'class n0 node_system').replace('class n1 node_component', 'class n1 node_resource');
  view.links = [{ id: 'write', mermaidId: 'e0', from: 'a', to: 'b', kind: 'write', edgeSemantic: 'write' }];
  view.mermaid += '  n0 e0@--> n1\n  class e0 edge_write\n';
  const before = structuredClone(view);
  const result = await compileRoutedView(view, registry, async candidate => {
    const selected = !candidate.mermaid.includes('subgraph layout_card_n0') && candidate.mermaid.includes('subgraph layout_card_n1');
    const curve = selected ? 'M80,75 C110,45 140,45 170,75.8' : 'M80,75 C110,75.267 140,75.533 170,75.8';
    return normalizeMermaidSvg(candidate, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 150">'
      + '<g class="node" id="flowchart-n0-0"><rect x="20" y="60" width="60" height="30"/></g>'
      + '<g class="node" id="flowchart-n1-1"><rect x="170" y="60.8" width="60" height="30"/></g>'
      + `<path data-id="e0" d="${curve}"/></svg>`, registry);
  }, { onAttempt: attempt => rejected.push(attempt) });
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every(attempt => attempt.invalid[0].axis === null && !attempt.invalid[0].curved
    && attempt.invalid[0].curveCommands && !attempt.invalid[0].collisions.length && !attempt.invalid[0].arrowIssues.length));
  assert.deepEqual(result.links, view.links); assert.deepEqual(view, before);
});

test('endpoint card containers select exact native IDs even when cards share names and visual types', () => {
  const { view } = clearanceFixture('dagre', 'object');
  view.nodes.forEach(node => { node.name = 'same'; });
  const before = structuredClone(view);
  const source = routedMermaid(view, { cardContainers: ['n1'] });
  assert.doesNotMatch(source, /subgraph layout_card_n0/);
  assert.match(source, /subgraph layout_card_n1/);
  assert.equal((source.match(/n[01]@\{/g) || []).length, 2);
  assert.deepEqual(view, before);
  assert.throws(() => routedMermaid(view, { cardContainers: ['missing'] }), /Missing native card container/);
});

function outputBranchFixture() {
  const { view, registry } = clearanceFixture('dagre', 'object');
  view.centerNodeId = 'a';
  for (const id of ['c', 'd']) {
    view.nodes.push({ ...view.nodes[1], id, instance: `clearance-${id}`, mermaidId: `n${view.nodes.length}` });
    registry[id] = { ...registry.b };
  }
  view.links = [
    { id: 'read-b', mermaidId: 'e0', from: 'a', to: 'b' },
    { id: 'read-c', mermaidId: 'e1', from: 'a', to: 'c' },
    { id: 'read-d', mermaidId: 'e2', from: 'a', to: 'd', nativeReverse: true },
    { id: 'write-d', mermaidId: 'e3', from: 'd', to: 'a' },
  ];
  return { view, registry };
}

test('a near-collinear output branch retries one native output context and leaves reversed neighbors outside it', async () => {
  const { view, registry } = outputBranchFixture(), before = structuredClone({ view, registry }), attempts = [];
  const result = await compileRoutedView(view, registry, async candidate => candidate, {
    onAttempt: attempt => attempts.push(attempt),
    checks: {
      labels: () => [], geometry: () => {},
      routes: candidate => ({ edges: view.links.map(link => ({ id: link.id, mermaidId: link.mermaidId, axis: link.id === 'read-b' ? null : 'horizontal',
        curved: link.id === 'read-b' && candidate.mermaid.includes('layout_output_'), collisions: [], arrowIssues: [] })) }),
    },
  });
  assert.equal(attempts.length, 1);
  assert.deepEqual(result.layoutLinks, [{ mermaidId: 'layout_output_0', from: 'n1', to: 'n2' }]);
  assert.match(result.mermaid, /n1 layout_output_0@~~~ n2/);
  assert.doesNotMatch(result.mermaid, /(?:n3 layout_output_|layout_output_\d+@~~~ n3)/);
  assert.deepEqual(result.links, view.links);
  assert.deepEqual({ view, registry }, before);
});

test('output context is bounded and never substitutes for failed labels, geometry, collisions or arrows', async () => {
  for (const failure of ['straight', 'label', 'geometry', 'collision', 'arrow']) {
    const { view, registry } = outputBranchFixture();
    let outputAttempts = 0, latest;
    await assert.rejects(compileRoutedView(view, registry, async candidate => { latest = candidate; return candidate; }, {
      onAttempt: () => { if (latest.mermaid.includes('layout_output_')) outputAttempts++; },
      checks: {
        labels: () => failure === 'label' ? ['a'] : [],
        geometry: () => { if (failure === 'geometry') throw new Error('overlap'); },
        routes: () => ({ edges: [{ id: 'read-b', mermaidId: 'e0', axis: null, curved: false,
          collisions: failure === 'collision' ? [{ id: 'unrelated', kind: 'node' }] : [], arrowIssues: failure === 'arrow' ? ['path-target'] : [] }] }),
      },
    }), /Mermaid routing failed/);
    assert.equal(outputAttempts, failure === 'straight' ? 1 : 0, failure);
  }
});

function inputBranchFixture() {
  const fixture = outputBranchFixture(), { view } = fixture;
  view.mermaid += view.nodes.slice(2).map(node => `  ${node.mermaidId}@{ shape: rect, label: "${node.id}" }\n  class ${node.mermaidId} node_component\n`).join('');
  const nodes = new Map(view.nodes.map(node => [node.id, node.mermaidId]));
  view.mermaid += view.links.map(link => `  ${nodes.get(link.nativeReverse ? link.to : link.from)} ${link.mermaidId}@${link.nativeReverse ? '---' : '-->'} ${nodes.get(link.nativeReverse ? link.from : link.to)}\n`).join('');
  return fixture;
}

test('a lone near-collinear input retries native output clearance without adding reversed neighbors', async () => {
  const { view, registry } = inputBranchFixture(), before = structuredClone({ view, registry }), profiles = [], attempts = [];
  let latest;
  const result = await compileRoutedView(view, registry, async candidate => { latest = candidate; return candidate; }, {
    onAttempt: attempt => attempts.push({ ...attempt, output: latest.mermaid.includes('layout_output_') }),
    checks: {
      labels: () => [],
      geometry: candidate => {
        if (!candidate.mermaid.includes('layout_output_')) return;
        const configuration = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(candidate.mermaid)[1]).config;
        profiles.push({ spacing: configuration.flowchart.nodeSpacing - 32, wrapped: candidate.mermaid.includes('layout_card_') });
        assert.match(candidate.mermaid, /n3 e3@--> n0/);
      },
      routes: candidate => {
        const configuration = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(candidate.mermaid)[1]).config;
        const cleared = candidate.mermaid.includes('layout_output_') && candidate.mermaid.includes('layout_card_') && configuration.flowchart.nodeSpacing >= 48;
        return { edges: view.links.map(link => ({ id: link.id, mermaidId: link.mermaidId, axis: link.id === 'write-d' ? null : 'horizontal',
          curved: link.id === 'write-d' && cleared, collisions: [], arrowIssues: [] })) };
      },
    },
  });
  assert.deepEqual(profiles, [{ spacing: 0, wrapped: false }, { spacing: 16, wrapped: true }]);
  assert.ok(attempts.length > 2);
  assert.ok(attempts.slice(0, -1).every(attempt => !attempt.output));
  assert.equal(attempts.at(-1).output, true);
  assert.deepEqual(result.layoutLinks, [{ mermaidId: 'layout_output_0', from: 'n1', to: 'n2' }]);
  assert.doesNotMatch(result.mermaid, /(?:n3 layout_output_|layout_output_\d+@~~~ n3)/);
  assert.deepEqual(result.links, view.links);
  assert.deepEqual({ view, registry }, before);

  let calls = 0;
  const direct = await compileRoutedView(view, registry, async candidate => { calls++; return candidate; }, {
    checks: { labels: () => [], geometry: () => {}, routes: () => ({ edges: view.links.map(link => ({ id: link.id, mermaidId: link.mermaidId,
      axis: 'horizontal', curved: false, collisions: [], arrowIssues: [] })) }) },
  });
  assert.equal(calls, 1);
  assert.deepEqual(direct.layoutLinks, []);
  assert.equal(direct.mermaid, routedMermaid(view));
});

test('lone input output-context retries are bounded and retain all failure gates', async () => {
  for (const failure of ['straight', 'label', 'geometry', 'collision', 'arrow', 'axis-curve', 'multiple-inputs', 'no-output-chain', 'elk', 'data']) {
    const { view, registry } = inputBranchFixture();
    if (failure === 'multiple-inputs') view.links.push({ id: 'write-c', mermaidId: 'e4', from: 'c', to: 'a' });
    if (failure === 'no-output-chain') view.links.find(link => link.id === 'read-c').nativeReverse = true;
    if (failure === 'elk') view.mermaid = view.mermaid.replace('"layout":"dagre"', '"layout":"elk"');
    if (failure === 'data') view.aspect = 'data';
    const before = structuredClone({ view, registry }), profiles = [], order = [];
    let latest;
    await assert.rejects(compileRoutedView(view, registry, async candidate => { latest = candidate; return candidate; }, {
      onAttempt: () => {
        order.push(latest.mermaid.includes('layout_output_'));
        if (!latest.mermaid.includes('layout_output_')) return;
        const configuration = JSON.parse(/^---\n([\s\S]*?)\n---/.exec(latest.mermaid)[1]).config;
        profiles.push({ spacing: configuration.flowchart.nodeSpacing - 32, wrapped: latest.mermaid.includes('layout_card_') });
        assert.match(latest.mermaid, /n3 e3@--> n0/);
      },
      checks: {
        labels: () => failure === 'label' ? ['a'] : [],
        geometry: () => { if (failure === 'geometry') throw new Error('overlap'); },
        routes: () => ({ edges: [{ id: 'write-d', mermaidId: 'e3', axis: failure === 'axis-curve' ? 'horizontal' : null,
          curved: failure === 'axis-curve', collisions: failure === 'collision' ? [{ id: 'unrelated', kind: 'node' }] : [],
          arrowIssues: failure === 'arrow' ? ['path-target'] : [] }] }),
      },
    }), /Mermaid routing failed/);
    assert.deepEqual(profiles, failure === 'straight' ? [
      { spacing: 0, wrapped: false }, ...[16, 32, 64].map(spacing => ({ spacing, wrapped: true })),
    ] : [], failure);
    if (failure === 'straight') {
      const firstOutput = order.indexOf(true);
      assert.ok(firstOutput > 0);
      assert.deepEqual(order.slice(firstOutput), [true, true, true, true]);
    }
    assert.deepEqual({ view, registry }, before);
  }
});

test('existing endpoint clearance succeeds before lone-input output fallback is attempted', async () => {
  const { view, registry } = inputBranchFixture(), before = structuredClone({ view, registry }), sources = [];
  const result = await compileRoutedView(view, registry, async candidate => candidate, {
    checks: {
      labels: () => [], geometry: candidate => sources.push(candidate.mermaid),
      routes: candidate => ({ edges: [{ id: 'write-d', mermaidId: 'e3', axis: null,
        curved: candidate.mermaid.includes('layout_card_n0') && !candidate.mermaid.includes('layout_card_n3'), collisions: [], arrowIssues: [] }] }),
    },
  });
  assert.ok(sources.every(source => !source.includes('layout_output_')));
  assert.deepEqual(result.layoutLinks, []);
  assert.deepEqual([...result.mermaid.matchAll(/subgraph layout_card_(n\d+)/g)].map(match => match[1]), ['n0']);
  assert.deepEqual({ view, registry }, before);
});

test('a pending lone-input fallback does not consume the original immediate output context', async () => {
  const { view, registry } = inputBranchFixture(), rejected = [];
  const result = await compileRoutedView(view, registry, async candidate => candidate, {
    onAttempt: attempt => rejected.push(attempt.invalid[0].id),
    checks: {
      labels: () => [], geometry: () => {},
      routes: candidate => {
        const output = candidate.mermaid.includes('layout_card_n3');
        return { edges: [{ id: output ? 'read-b' : 'write-d', mermaidId: output ? 'e0' : 'e3', axis: null,
          curved: candidate.mermaid.includes('layout_output_'), collisions: [], arrowIssues: [] }] };
      },
    },
  });
  assert.deepEqual(rejected, ['write-d', 'read-b']);
  assert.equal(result.layoutLinks.length, 1);
  assert.doesNotMatch(result.mermaid, /layout_card_/);
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
