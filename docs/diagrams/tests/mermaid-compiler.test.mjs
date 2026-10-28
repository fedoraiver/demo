import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { normalizeMermaidSvg, routedMermaid } from '../src/mermaid-compiler.mjs';

test('native routing exports edge curves and rank spans without changing semantic endpoints or IDs', () => {
  const original = { mermaid: '---\n{"config":{"layout":"dagre","flowchart":{"nodeSpacing":32,"rankSpacing":24,"curve":"linear"}}}\n---\nflowchart TB\nn0 e0@--> n1\nn1 e1@--> n2\n' };
  const source = routedMermaid(original, { curves: new Map([['e1', 'basis']]), spacing: 16, spans: new Map([['e1', 2]]) });
  assert.match(source, /"nodeSpacing": 48/);
  assert.match(source, /"rankSpacing": 40/);
  assert.match(source, /^n0 e0@--> n1$/m);
  assert.match(source, /^n1 e1@----> n2$/m);
  assert.match(source, /^\s*e1@\{ curve: basis \}$/m);
  assert.doesNotMatch(source, /e0@\{ curve:/);
  assert.match(original.mermaid, /n1 e1@--> n2/);
});

test('native card clearance containers preserve semantic declarations and do not affect the original candidate', () => {
  const original = { mermaid: '---\n{"config":{"layout":"dagre","flowchart":{"nodeSpacing":32,"rankSpacing":56}}}\n---\nflowchart LR\n  n0@{ shape: rect, label: "A" }\n  class n0 node_plugin\n  n1@{ shape: rect, label: "B" }\n  class n1 node_plugin\n  class n1 external_node\n  n0 e0@--> n1\n  class e0 edge_dependency\n' };
  const before = original.mermaid, source = routedMermaid(original, { cardContainers: true });
  assert.equal(original.mermaid, before);
  assert.equal((source.match(/subgraph layout_card_n\d+\[" "\]/g) || []).length, 2);
  assert.match(source, /class n1 external_node\n  end\n  style layout_card_n1 fill:none,stroke:none/);
  assert.equal((source.match(/^  n\d+@\{/gm) || []).length, 2);
  assert.match(source, /^  n0 e0@--> n1$/m);
  assert.doesNotMatch(source, /layout_card_n\d+@\{|layout_card_n\d+ e\d+@|e0@\{ curve:/);
  assert.doesNotMatch(routedMermaid(original), /layout_card_/);
});

test('related native clearance contains only linked Components and outside system cards', () => {
  const view = {
    nodes: [
      { id: 'owner', mermaidId: 'n0', visualType: 'entity' },
      { id: 'linked', mermaidId: 'n1', visualType: 'component' },
      { id: 'unlinked', mermaidId: 'n2', visualType: 'component' },
      { id: 'system', mermaidId: 'n3', visualType: 'system' },
      { id: 'resource', mermaidId: 'n4', visualType: 'resource' },
    ],
    entityGroups: [{ entity: 'owner', components: ['linked', 'unlinked'] }],
    links: [{ from: 'linked', to: 'system' }],
    mermaid: '---\n{"config":{"flowchart":{"nodeSpacing":32,"rankSpacing":8}}}\n---\nflowchart TB\n'
      + [['n1', 'component'], ['n2', 'component'], ['n3', 'system'], ['n4', 'resource']].map(([id, type]) => `  ${id}@{ shape: rect, label: "${id}" }\n  class ${id} node_${type}\n`).join(''),
  };
  const source = routedMermaid(view, { cardContainers: 'related' });
  assert.deepEqual([...source.matchAll(/subgraph layout_card_(n\d+)/g)].map(match => match[1]), ['n1', 'n3']);
  assert.doesNotMatch(source, /layout_card_n[024]/);
  assert.equal((source.match(/^  n\d+@\{/gm) || []).length, 4);
});

test('native Entity clearance wraps the complete container without changing its children or business edge', () => {
  const source = '---\n{"config":{"flowchart":{"nodeSpacing":32,"rankSpacing":8}}}\n---\nflowchart TB\n'
    + '  subgraph n0[" "]\n  direction TB\n  eh0@{ shape: text, label: "Entity" }\n'
    + '  n1@{ shape: rect, label: "Component" }\n  class n1 node_component\n  end\n  class n0 node_entity\n'
    + '  n0 e0@-->|"Ownership"| n2\n  class e0 edge_reference\n';
  const view = { id: 'entity-clearance', mermaid: source }, result = routedMermaid(view, { entityContainers: ['n0'] });
  assert.match(result, /subgraph layout_entity_n0\[" "\]\n  direction TB\n  subgraph n0\[" "\]/);
  assert.match(result, /class n1 node_component\n  end\n  end\n  style layout_entity_n0 fill:none,stroke:none\n  class n0 node_entity/);
  assert.match(result, /^  n0 e0@-->\|"Ownership"\| n2$/m);
  assert.equal((result.match(/n1@\{/g) || []).length, 1);
  assert.equal(view.mermaid, source);
  assert.throws(() => routedMermaid(view, { entityContainers: ['n9'] }), /Missing native Entity container/);
});

test('bounded native Entity declaration order moves complete units within their original parent', () => {
  const unit = index => `  subgraph n${index}[" "]\n  direction TB\n  eh${index}@{ shape: text, label: "Entity ${index}" }\n  n${index + 10}@{ shape: rect, label: "Component ${index}" }\n  class n${index + 10} node_component\n  eh${index} layout_${index}@~~~ n${index + 10}\n  end\n  class n${index} node_entity\n  style n${index} fill:#F8F1EF,stroke:#A6533B\n`;
  const mermaid = '---\n{"config":{"flowchart":{"nodeSpacing":32,"rankSpacing":8}}}\n---\nflowchart TB\n'
    + '  subgraph relation_0[" "]\n' + unit(0) + unit(1) + unit(2) + '  n0 e0@--> n1\n  class e0 edge_reference\n  end\n'
    + '  subgraph column_0[" "]\n' + unit(3) + '  end\n';
  const view = { id: 'entity-order', mermaid };
  for (const [entityOrder, expected] of [['reverse', ['n2', 'n1', 'n0']], ['rotate', ['n1', 'n2', 'n0']], ['reverse-rest', ['n0', 'n2', 'n1']]]) {
    const source = routedMermaid(view, { entityContainers: ['n0', 'n1', 'n2', 'n3'], entityOrder });
    assert.deepEqual([...source.matchAll(/subgraph layout_entity_(n\d+)/g)].map(match => match[1]), [...expected, 'n3']);
    for (let index = 0; index < 4; index++) assert.ok(source.includes(unit(index).replace('  end\n  class', '  end\n  end\n  style layout_entity_n' + index + ' fill:none,stroke:none\n  class')), `Whole Entity ${index} retains its original member sequence`);
    assert.match(source, /^  n0 e0@--> n1$/m);
    assert.equal((source.match(/subgraph n\d+\[" "\]/g) || []).length, 4);
    assert.equal(view.mermaid, mermaid);
  }
});

test('partial Entity clearance orders native collapsed cards with complete expanded containers', () => {
  const leaf = id => `  ${id}@{ shape: rect, label: "${id}" }\n  class ${id} node_entity\n  class ${id} external_node\n`;
  const expanded = '  subgraph n1[" "]\n  direction TB\n  eh1@{ shape: text, label: "Entity" }\n'
    + '  n11@{ shape: rect, label: "Component" }\n  class n11 node_component\n  eh1 layout_0@~~~ n11\n  end\n  class n1 node_entity\n';
  const mermaid = '---\n{"config":{"flowchart":{"nodeSpacing":32,"rankSpacing":8}}}\n---\nflowchart TB\n'
    + '  subgraph relation_0[" "]\n' + expanded + leaf('n0') + leaf('n2') + '  n1 e0@--> n2\n  class e0 edge_reference\n  end\n';
  const view = { id: 'partial-entity-order', mermaid };
  const result = routedMermaid(view, { entityContainers: ['n0', 'n1', 'n2'], entityOrder: 'rotate' });
  assert.deepEqual([...result.matchAll(/subgraph layout_entity_(n\d+)/g)].map(match => match[1]), ['n0', 'n2', 'n1']);
  for (const id of ['n0', 'n2']) {
    assert.ok(result.includes(`subgraph layout_entity_${id}[" "]\n  direction TB\n` + leaf(id).trimEnd() + '\n  end'));
    assert.equal((result.match(new RegExp(`${id}@\\{`, 'g')) || []).length, 1);
  }
  assert.equal((result.match(/n11@\{/g) || []).length, 1);
  assert.equal((result.match(/subgraph n1\[" "\]/g) || []).length, 1);
  assert.match(result, /^  n1 e0@--> n2$/m);
  assert.equal(view.mermaid, mermaid);
  assert.equal(routedMermaid({ ...view, mermaid: result }, { entityContainers: ['n0', 'n1', 'n2'] }), result, 'Already compiled native wrappers never nest again');
});

test('compound routing fallback reverses only business declarations within each native relation network', () => {
  const front = '---\n{"config":{"flowchart":{"nodeSpacing":32,"rankSpacing":24}}}\n---\nflowchart TB\n';
  const source = front + '  subgraph relation_0[" "]\n  direction TB\n  n0@{ shape: rect, label: "Entity" }\n  n0 layout_0@~~~ n1\n  n0 e0@-->|"A"| n1\n  class e0 edge_reference\n  n1 e1@-->|"B"| n2\n  class e1 edge_read\n  end\n  style relation_0 fill:none,stroke:none\n  subgraph relation_1[" "]\n  direction TB\n  n3 e2@--> n4\n  class e2 edge_write\n  n4 e3@--> n5\n  class e3 edge_reference\n  end\n  style relation_1 fill:none,stroke:none\n  sg0 sc0@--> sg1\n';
  const view = { mermaid: source }, reversed = routedMermaid(view, { reverseRelationEdges: true });
  assert.ok(reversed.indexOf('n1 e1@') < reversed.indexOf('n0 e0@'));
  assert.ok(reversed.indexOf('n4 e3@') < reversed.indexOf('n3 e2@'));
  assert.ok(reversed.indexOf('n0 e0@') < reversed.indexOf('subgraph relation_1'));
  assert.ok(reversed.indexOf('n4 e3@') > reversed.indexOf('subgraph relation_1'));
  for (const line of source.slice(front.length).trim().split('\n')) assert.equal(reversed.split('\n').filter(value => value === line).length, source.split('\n').filter(value => value === line).length, line);
  assert.equal(view.mermaid, source);
  assert.ok(reversed.includes('  n0@{ shape: rect, label: "Entity" }\n  n0 layout_0@~~~ n1\n'));
  assert.ok(reversed.endsWith('  sg0 sc0@--> sg1\n'));
});

test('normalized SVG keeps keyboard focus visible only on unselected nodes without changing native graphics', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 160">
    <style>.node rect{fill:#fff;stroke:#3567A6}</style>
    <g class="node default" id="flowchart-n0-0" transform="translate(80,70)">
      <rect id="system-shape" x="-60" y="-25" width="120" height="50" rx="8" style="fill:#EFF3F8;stroke:#3567A6;stroke-width:1.6px !important"/>
      <g class="label"><text id="system-label">log_policy</text></g>
    </g>
    <g class="node default" id="flowchart-n1-1" transform="translate(270,70)">
      <rect id="component-shape" x="-60" y="-25" width="120" height="50" style="fill:#F1F5F2;stroke:#4B8060;stroke-width:1.6px !important;stroke-dasharray:6 4 !important"/>
      <g class="label"><text id="component-label">LogSettings</text></g>
    </g>
    <path id="native-edge" data-id="e0" d="M140,70 L210,70" style="stroke:#3567A6;stroke-width:1.6px;stroke-dasharray:6 4"/>
  </svg>`;
  const view = {
    id: 'focus-fixture', aspect: 'systems',
    nodes: [
      { id: 'log_policy', instance: 'focus--n0', mermaidId: 'n0', visualType: 'system', shape: 'rounded', role: 'internal' },
      { id: 'log-settings', instance: 'focus--n1', mermaidId: 'n1', visualType: 'component', shape: 'rect', role: 'external' },
    ],
    links: [{ id: 'settings-read', mermaidId: 'e0', from: 'log-settings', to: 'log_policy', kind: 'read', edgeSemantic: 'read', displayLabel: '' }],
    scheduleLinks: [], layoutLinks: [], scheduleGroups: [],
  };
  const registry = {
    log_policy: { name: 'log_policy', feature: 'session_log' },
    'log-settings': { name: 'LogSettings', feature: 'settings' },
  };
  const parse = svg => new DOMParser().parseFromString(svg, 'image/svg+xml');
  const original = parse(source), normalized = parse(normalizeMermaidSvg(view, source, registry).svg);
  const styles = [...normalized.getElementsByTagName('style')];
  assert.equal(styles[0].textContent, original.getElementsByTagName('style')[0].textContent);
  const rules = [...styles.at(-1).textContent.matchAll(/([^{}]+)\{([^{}]+)\}/g)].map(([, selector, declarations]) => ({ selector, declarations }));
  const outlineRules = rules.filter(rule => /(?:^|;)outline:/.test(rule.declarations));
  assert.deepEqual(outlineRules, [
    { selector: '[data-id]:focus', declarations: 'outline:none' },
    { selector: '[data-id]:focus-visible:not(.selected):not(.entity-container),.entity-container:focus-visible:not(.selected)>[data-shape-part]', declarations: 'outline:2px solid #2563EB;outline-offset:4px' },
  ], 'Only an unselected keyboard focus target receives the additional CSS outline');
  assert.ok(!rules.some(rule => /selected/.test(rule.selector) && /(?:^|;)(?:filter|fill|stroke-width):/.test(rule.declarations)), 'Selected native contours remain controlled by the shared interaction module');
  assert.ok(rules.some(rule => rule.selector === '.edge.focused' && rule.declarations === 'stroke-width:calc(var(--edge-width) + 1.2px)!important'));
  for (const id of ['system-shape', 'component-shape', 'system-label', 'component-label']) {
    const before = original.getElementById(id), after = normalized.getElementById(id);
    for (const attribute of before.attributes) assert.equal(after.getAttribute(attribute.name), attribute.value, `${id}/${attribute.name}`);
    assert.equal(after.textContent, before.textContent);
  }
  const originalEdge = original.getElementById('native-edge'), normalizedEdge = normalized.getElementById('native-edge');
  assert.equal(normalizedEdge.getAttribute('d'), originalEdge.getAttribute('d'));
  assert.equal(normalizedEdge.getAttribute('style'), originalEdge.getAttribute('style') + ';--edge-width:1.6px');
  assert.equal(normalized.getElementsByTagName('filter').length, 0, 'Static business SVGs do not acquire selection filters');
});

test('Entity containers keep one semantic identity and annotate only their own native outline and header', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260">
    <g transform="translate(10,20)">
      <g class="cluster node_entity external_node" id="entity-fixture-n0">
        <rect id="entity-outline" x="0" y="0" width="300" height="200" style="fill:#F8F1EF;stroke:#A6533B;stroke-width:2.2px !important;stroke-dasharray:6 4 !important"/>
        <g class="cluster-label"/>
        <g class="node" id="flowchart-n1-1" transform="translate(100,100)">
          <rect id="nested-component-outline" x="-70" y="-25" width="140" height="50" style="fill:#F1F5F2;stroke:#4B8060;stroke-width:1.6px !important"/>
          <g class="label"><text id="nested-component-label">Transform</text></g>
        </g>
      </g>
      <g class="node" id="flowchart-eh0-2"><g class="label"><text id="entity-header">相机实体：保存观察方向。</text></g></g>
    </g>
  </svg>`;
  const view = {
    id: 'entity-fixture', aspect: 'data',
    nodes: [
      { id: 'entity-camera', instance: 'entity-fixture--n0', mermaidId: 'n0', visualType: 'entity', shape: 'rect', presentation: 'entity-container', role: 'external' },
      { id: 'camera.Transform', instance: 'entity-fixture--n1', mermaidId: 'n1', visualType: 'component', shape: 'rect', role: 'internal' },
    ],
    links: [], scheduleLinks: [], layoutLinks: [], scheduleGroups: [],
    entityGroups: [{ id: 'entity-group-camera', entity: 'entity-camera', components: ['camera.Transform'], mermaidId: 'n0', headerMermaidId: 'eh0' }],
  };
  const registry = {
    'entity-camera': { name: '相机实体', feature: 'scene_assembly' },
    'camera.Transform': { name: 'Transform', feature: 'infrastructure' },
  };
  const headerBounds = { x: 75, y: 32, width: 170, height: 36 };
  const result = normalizeMermaidSvg(view, source, registry, { clusterLabelBounds: { eh0: headerBounds } });
  const parsed = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
  const entity = parsed.getElementById('entity-fixture-n0'), outline = parsed.getElementById('entity-outline');
  const component = parsed.getElementById('flowchart-n1-1'), componentOutline = parsed.getElementById('nested-component-outline');
  assert.equal(entity.getAttribute('data-id'), 'entity-camera');
  assert.equal(entity.getAttribute('data-presentation'), 'entity-container');
  assert.equal(entity.getAttribute('data-entity-group'), 'entity-group-camera');
  assert.equal(entity.getAttribute('tabindex'), '0');
  assert.equal(entity.getAttribute('role'), 'button');
  assert.equal(outline.getAttribute('data-shape-part'), 'entity-fixture--n0');
  assert.equal(component.getAttribute('data-id'), 'camera.Transform');
  assert.equal(componentOutline.getAttribute('data-shape-part'), 'entity-fixture--n1');
  const header = parsed.getElementById('flowchart-eh0-2');
  assert.equal(header.getAttribute('data-entity-header'), 'entity-fixture--n0');
  assert.equal(header.getAttribute('data-entity-owner'), 'entity-camera');
  assert.equal(header.getAttribute('aria-hidden'), 'true');
  for (const name of ['data-id', 'role', 'tabindex', 'data-shape-part']) assert.equal(header.hasAttribute(name), false);
  assert.deepEqual(JSON.parse(header.getAttribute('data-label-bounds')), headerBounds);
  assert.deepEqual(result.entityGroups[0].headerBounds, headerBounds);
  assert.deepEqual(result.entityGroups[0].bounds, { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(result.nodes.map(node => [node.id, node.position]), [
    ['entity-camera', { x: 10, y: 20, width: 300, height: 200 }],
    ['camera.Transform', { x: 40, y: 95, width: 140, height: 50 }],
  ]);
  const style = [...parsed.getElementsByTagName('style')].at(-1).textContent;
  assert.ok(style.includes('.node.dim:not(.entity-container),[data-entity-header].dim{opacity:.22}'));
  assert.ok(style.includes('.entity-container.dim>[data-shape-part]{opacity:.22}'));
  assert.equal(parsed.getElementsByTagName('filter').length, 0);
  for (const id of ['entity-outline', 'entity-header', 'nested-component-outline', 'nested-component-label']) {
    const original = new DOMParser().parseFromString(source, 'image/svg+xml').getElementById(id), actual = parsed.getElementById(id);
    for (const attribute of original.attributes) assert.equal(actual.getAttribute(attribute.name), attribute.value);
    assert.equal(actual.textContent, original.textContent);
  }
  assert.throws(() => normalizeMermaidSvg(view, source, registry, { clusterLabelBounds: { eh0: { ...headerBounds, width: 0 } } }), /Invalid Mermaid Entity header bounds/);
});

test('folded Entity metadata uses its real rectangle and projected edges retain canonical endpoints', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 200">
    <g class="node node_entity external_node" id="flowchart-n0-0" transform="translate(100,80)">
      <rect id="entity-outline" x="-80" y="-40" width="160" height="80" style="fill:#F8F1EF;stroke:#A6533B;stroke-dasharray:6 4 !important"/>
      <g class="label"><text><tspan>相机实体</tspan></text></g>
    </g>
    <g class="node" id="flowchart-n2-2" transform="translate(330,80)"><rect x="-60" y="-25" width="120" height="50"/><g class="label"><text>consumer</text></g></g>
    <path data-id="e0" id="native-edge" d="M180,80 L270,80"/>
  </svg>`;
  const view = { id: 'folded-fixture', aspect: 'data', entityExpansion: 'collapsed', parentViewId: 'base',
    nodes: [
      { id: 'entity-camera', instance: 'folded-fixture--n0', mermaidId: 'n0', visualType: 'entity', shape: 'rect', presentation: 'entity-collapsed', role: 'external', entityToggle: { entity: 'entity-camera', expanded: false, count: 1, label: '展开组件（1）' } },
      { id: 'consumer', instance: 'folded-fixture--n2', mermaidId: 'n2', visualType: 'system', shape: 'rounded', role: 'internal' },
    ], links: [{ id: 'read-transform', mermaidId: 'e0', from: 'camera.Transform', to: 'consumer', displayFrom: 'entity-camera', displayTo: 'consumer', kind: 'read', edgeSemantic: 'read', displayLabel: '' }],
    entityGroups: [{ id: 'entity-group-camera', entity: 'entity-camera', components: ['camera.Transform'], mermaidId: 'n0', expanded: false }], scheduleLinks: [], layoutLinks: [], scheduleGroups: [] };
  const registry = { 'entity-camera': { name: '相机实体', feature: 'scene_assembly' }, 'camera.Transform': { name: 'Transform', feature: 'first_person' }, consumer: { name: 'consumer', feature: 'first_person' } };
  const result = normalizeMermaidSvg(view, source, registry), parsed = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
  const entity = [...parsed.getElementsByTagName('g')].find(node => node.getAttribute('data-id') === 'entity-camera');
  assert.equal(entity.getAttribute('data-entity-group'), 'entity-group-camera');
  assert.equal(entity.getAttribute('data-presentation'), 'entity-collapsed');
  assert.equal(parsed.getElementById('entity-outline').getAttribute('data-shape-part'), 'folded-fixture--n0');
  assert.doesNotMatch(result.svg, /data-entity-toggle-label|展开组件/);
  assert.equal(parsed.getElementById('native-edge').getAttribute('data-connect'), 'entity-camera|consumer');
  assert.equal(parsed.getElementById('native-edge').getAttribute('data-canonical-connect'), 'camera.Transform|consumer');
  assert.match(parsed.getElementById('native-edge').getAttribute('aria-label'), /camera\.Transform → consumer/);
  assert.deepEqual(result.entityGroups[0].bounds, { x: 20, y: 40, width: 160, height: 80 });
  assert.equal(result.entityGroups[0].headerBounds, undefined);
  assert.equal(result.entityGroups[0].headerMermaidId, undefined);
  assert.deepEqual(result.sections.find(section => section.entityGroup === 'entity-group-camera'), { label: '相机实体', x: 20, y: 40, width: 160, height: 80, entityGroup: 'entity-group-camera' });
  assert.equal(result.nodes.some(node => node.id === 'camera.Transform'), false);
  assert.equal(result.links[0].from, 'camera.Transform');
  assert.equal(parsed.getElementById('entity-outline').getAttribute('style'), new DOMParser().parseFromString(source, 'image/svg+xml').getElementById('entity-outline').getAttribute('style'));
  assert.doesNotThrow(() => normalizeMermaidSvg({ ...view, nodes: view.nodes.map(node => node.entityToggle ? { ...node, entityToggle: { ...node.entityToggle, label: '展开组件（1）' } } : node) }, source, registry));
});

test('expanded Entity corner toggle needs no text anchor or extra SVG outline', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260">
    <g class="cluster" id="toggle-fixture-n0"><rect x="10" y="20" width="300" height="200"/><g class="cluster-label"/>
      <g class="node" id="flowchart-n1-1" transform="translate(140,150)"><rect x="-60" y="-25" width="120" height="50"/><g class="label"><text>Transform</text></g></g>
    </g>
    <g class="node" id="flowchart-eh0-2"><g class="label"><text><tspan>相机实体</tspan></text></g></g>
  </svg>`;
  const view = { id: 'toggle-fixture', aspect: 'data', nodes: [
    { id: 'entity-camera', instance: 'toggle-fixture--n0', mermaidId: 'n0', visualType: 'entity', shape: 'rect', presentation: 'entity-container', role: 'internal', entityToggle: { entity: 'entity-camera', expanded: true, count: 1, label: '收起组件（1）' } },
    { id: 'camera.Transform', instance: 'toggle-fixture--n1', mermaidId: 'n1', visualType: 'component', shape: 'rect', role: 'internal' },
  ], links: [], layoutLinks: [], scheduleLinks: [], scheduleGroups: [], entityGroups: [{ id: 'entity-group-camera', entity: 'entity-camera', components: ['camera.Transform'], expanded: true, mermaidId: 'n0', headerMermaidId: 'eh0' }] };
  const result = normalizeMermaidSvg(view, source, { 'entity-camera': { name: '相机实体' }, 'camera.Transform': { name: 'Transform' } }), doc = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
  assert.doesNotMatch(result.svg, /data-entity-toggle-label|收起组件/);
  const header = [...doc.getElementsByTagName('g')].find(element => element.getAttribute('data-entity-header'));
  assert.equal(header.getAttribute('aria-hidden'), 'true');
  for (const attribute of ['data-id', 'data-shape-part', 'tabindex', 'role']) assert.equal(header.hasAttribute(attribute), false);
  assert.equal(doc.getElementsByTagName('rect').length, 2, 'No button proxy or additional outline is drawn into the SVG');
});

test('native Schedule title measurements remain available independently of node outline bounds', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260">
    <g class="cluster" id="schedule-fixture-sg0">
      <rect x="10" y="20" width="300" height="200"/>
      <g class="cluster-label"><text>OnTransition</text></g>
      <g class="node" id="flowchart-n0-0" transform="translate(150,120)">
        <rect x="-70" y="-25" width="140" height="50"/>
        <g class="label"><text>apply_transition</text></g>
      </g>
    </g>
  </svg>`;
  const view = {
    id: 'schedule-fixture', aspect: 'systems',
    nodes: [{ id: 'apply_transition', instance: 'schedule-fixture--n0', mermaidId: 'n0', visualType: 'system', shape: 'rounded', role: 'internal' }],
    links: [], scheduleLinks: [], layoutLinks: [],
    scheduleGroups: [{ id: 'StateTransition', mermaidId: 'sg0', label: 'OnTransition', nodes: ['apply_transition'] }],
  };
  const registry = { apply_transition: { name: 'apply_transition', feature: 'game_flow' } };
  const labelBounds = { x: 100, y: 32, width: 120, height: 20 };
  const measured = normalizeMermaidSvg(view, source, registry, { clusterLabelBounds: { 'schedule-fixture-sg0': labelBounds } });
  assert.deepEqual(measured.scheduleGroups[0].labelBounds, labelBounds);
  const doc = new DOMParser().parseFromString(measured.svg, 'image/svg+xml');
  const label = [...doc.getElementById('schedule-fixture-sg0').childNodes].find(child => child.nodeType === 1 && child.getAttribute('class') === 'cluster-label');
  assert.deepEqual(JSON.parse(label.getAttribute('data-label-bounds')), labelBounds);
  assert.equal(normalizeMermaidSvg(view, source, registry).scheduleGroups[0].labelBounds, undefined, 'Old fixtures without native browser measurements remain readable');
});
