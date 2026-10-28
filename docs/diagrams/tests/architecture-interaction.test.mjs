import assert from 'node:assert/strict';
import test from 'node:test';
import { readArchitectureData } from '../src/architecture-artifacts.mjs';
import { repositoryRoot } from '../src/paths.mjs';
import { createArchitectureInteraction } from '../src/architecture-interaction.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, selectedFillColor } from '../src/architecture-style.mjs';
import { testDocument } from './test-dom.mjs';
import { svgElements } from '../src/svg-shape-geometry.mjs';

const properties = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray'];
const snapshot = part => properties.map(name => [name, part.style.getPropertyValue(name), part.style.getPropertyPriority(name)]);

test('Graphviz cards share semantic fill, stroke and screen-stable ring without selecting text or edges', () => {
  const document=testDocument('<svg id="schedule"><g class="graph"><g class="node"><title>system</title><path style="fill:#eff3f8;stroke:#3567a6;stroke-width:1.6px"/><text>system label</text></g><g class="edge dim focused"><title>original edge</title><path stroke="#334155"/></g></g></svg>');
  const diagram=document.getElementById('schedule'),node=diagram.querySelector('.node'),shape=node.querySelector('path'),text=node.querySelector('text'),edge=diagram.querySelector('.edge');
  const original=snapshot(shape),edgeClass=edge.getAttribute('class'),textStyle=text.getAttribute('style');
  const interaction=createArchitectureInteraction({diagram,nodeStyles:NODE_STYLES});
  interaction.paint({nativeOnly:true,selectedOutlines:[{target:shape,parts:[shape]}]});
  assert.equal(shape.style.getPropertyValue('stroke-width'),'3.6px');
  assert.equal(shape.style.getPropertyValue('fill'),selectedFillColor('#3567a6'));
  assert.match(shape.style.getPropertyValue('filter'),/^url\(#schedule-selection-/);
  assert.equal(node.style.getPropertyValue('filter'),'');assert.equal(text.getAttribute('style'),textStyle);
  for(const scale of [.2,.01,1.8]){
    interaction.setScale(scale);
    assert.ok(Math.abs((parseFloat(shape.style.getPropertyValue('stroke-width'))-1.6)*scale-2)<1e-9);
    const morphs=diagram.querySelectorAll('feMorphology');
    assert.ok(Math.abs(Number(morphs[1].getAttribute('radius'))*scale-1)<1e-9);
    assert.ok(Math.abs((Number(morphs[0].getAttribute('radius'))-Number(morphs[1].getAttribute('radius')))*scale-2)<1e-9);
    assert.equal(edge.getAttribute('class'),edgeClass);
  }
  interaction.paint({nativeOnly:true});assert.deepEqual(snapshot(shape),original);
  assert.equal(shape.style.getPropertyValue('filter'),'');assert.equal(edge.getAttribute('class'),edgeClass);
  assert.equal(diagram.querySelector('[data-selection-filter]'),null);
});

test('Graphviz cluster selection affects its complete border while title and nested systems remain untouched', () => {
  const document=testDocument('<svg id="schedule"><g class="cluster"><title>outer</title><polygon style="fill:#f5f7fa;stroke:#65758b;stroke-width:1px"/><text>set title</text><g class="cluster"><polygon style="fill:#f5f7fa;stroke:#65758b;stroke-width:1px"/><text>inner title</text><g class="node"><path style="fill:#eff3f8;stroke:#3567a6;stroke-width:1.6px"/><text>child system</text></g></g></g></svg>');
  const diagram=document.getElementById('schedule'),groups=diagram.querySelectorAll('.cluster'),outer=groups[0],border=outer.children[1],inner=groups[1].children[0],system=diagram.querySelector('.node').querySelector('path');
  const original=snapshot(border),innerOriginal=snapshot(inner),systemOriginal=snapshot(system);
  const interaction=createArchitectureInteraction({diagram,nodeStyles:NODE_STYLES});
  interaction.setScale(.5);interaction.paint({nativeOnly:true,selectedOutlines:[{target:border,parts:[border]}]});
  assert.equal(border.style.getPropertyValue('stroke-width'),'5px');
  assert.equal(border.style.getPropertyValue('fill'),selectedFillColor('#65758b'));
  assert.deepEqual(snapshot(inner),innerOriginal);assert.deepEqual(snapshot(system),systemOriginal);
  assert.ok(diagram.querySelectorAll('text').every(text=>!text.getAttribute('style')));
  assert.ok(groups.every(group=>group.style.getPropertyValue('filter')===''));
  assert.throws(()=>interaction.paint({nativeOnly:true,selectedOutlines:[{target:outer,parts:[border]}]}),/exclude labels and text/);
  interaction.paint({nativeOnly:true});assert.deepEqual(snapshot(border),original);
});

test('Graphviz title masks share only their border fill and restore original inline priorities after repeated selection and zoom', () => {
  for (const style of ['', 'fill:#FAFAFA', 'fill:#FAFAFA !important']) {
    const document = testDocument('<svg id="schedule"><g class="graph"><g class="cluster"><path id="border" fill="#f3f4f6" stroke="#6a778c" stroke-width="1.6"/></g>'
      + '<g class="schedule-cluster-title"><g><a><polygon id="mask" fill="#f3f4f6" stroke="none" style="' + style + '"/><text fill="#1f3340">TimeSystems</text></a></g></g>'
      + '<g class="cluster"><path id="other" fill="#f3f4f6" stroke="#6a778c"/></g><polygon id="other-mask" fill="#f3f4f6" stroke="none"/></g></svg>');
    const diagram = document.getElementById('schedule'), border = document.getElementById('border'), mask = document.getElementById('mask');
    const other = document.getElementById('other'), otherMask = document.getElementById('other-mask'), text = diagram.querySelector('text');
    const originals = [border, mask, other, otherMask].map(snapshot), textStyle = text.getAttribute('style');
    const originalAttributes = [...mask.attributes];
    const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
    const selection = { nativeOnly: true, selectedOutlines: [{ target: border, parts: [border], fillOnlyParts: [mask] }] };
    for (let repeat = 0; repeat < 3; repeat++) {
      interaction.paint(selection);
      for (const scale of [1, .1, 2]) {
        interaction.setScale(scale);
        assert.equal(mask.style.getPropertyValue('fill'), border.style.getPropertyValue('fill'));
        assert.equal(mask.style.getPropertyValue('fill'), selectedFillColor('#6a778c'));
        assert.equal(mask.style.getPropertyPriority('fill'), 'important');
        assert.deepEqual(snapshot(mask).filter(([name]) => name !== 'fill'), originals[1].filter(([name]) => name !== 'fill'));
        assert.equal(mask.style.getPropertyValue('filter'), '');
        assert.equal(text.getAttribute('style'), textStyle);
        assert.deepEqual(snapshot(other), originals[2]); assert.deepEqual(snapshot(otherMask), originals[3]);
        assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
      }
    }
    interaction.paint({ nativeOnly: true, selectedOutlines: [{ target: other, parts: [other], fillOnlyParts: [otherMask] }] });
    assert.deepEqual(snapshot(border), originals[0]); assert.deepEqual(snapshot(mask), originals[1]);
    interaction.paint({ nativeOnly: true });
    assert.deepEqual([border, mask, other, otherMask].map(snapshot), originals);
    assert.deepEqual([...mask.attributes].filter(([name]) => name !== 'style'), originalAttributes.filter(([name]) => name !== 'style'));
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
    interaction.paint(selection);
    diagram.innerHTML = '<svg id="replacement"/>';
    interaction.setScale(.5);
    assert.deepEqual(snapshot(border), originals[0]); assert.deepEqual(snapshot(mask), originals[1]);
  }
});

test('every native node type strengthens its semantic fill and gains two screen pixels before exact restoration', () => {
  const markup = Object.entries(NODE_STYLES).map(([type, style]) => ['normal', 'external'].map(variant =>
    `<g data-id="${type}-${variant}" data-visual-type="${type}"><path data-shape-part="${type}-${variant}" style="fill:${style.fill} !important;stroke:${style.stroke} !important;stroke-width:${style.width}px !important${variant === 'external' ? ';stroke-dasharray:6 4 !important' : ''}"/></g>`).join('')).join('');
  const document = testDocument(`<svg id="diagram">${markup}</svg>`), diagram = document.getElementById('diagram');
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  const originals = new Map(diagram.querySelectorAll('[data-shape-part]').map(part => [part, snapshot(part)]));
  for (const node of diagram.querySelectorAll('[data-id]')) {
    const part = node.querySelector('[data-shape-part]'), original = originals.get(part);
    for (let repeat = 0; repeat < 3; repeat++) interaction.paint({ selectedNodes: new Set([node.dataset.id]) });
    assert.equal(part.style.getPropertyValue('stroke-width'), `${NODE_STYLES[node.dataset.visualType].width + 2}px`);
    assert.equal(part.style.getPropertyPriority('stroke-width'), 'important');
    assert.equal(node.getAttribute('aria-pressed'), 'true');
    assert.equal(part.style.getPropertyValue('fill'), selectedFillColor(NODE_STYLES[node.dataset.visualType].stroke));
    assert.equal(part.style.getPropertyPriority('fill'), 'important');
    assert.deepEqual(snapshot(part).filter(([name]) => !['fill', 'stroke-width'].includes(name)), original.filter(([name]) => !['fill', 'stroke-width'].includes(name)));
    assert.match(part.style.getPropertyValue('filter'), /^url\(#diagram-selection-\d+\)$/);
    assert.equal(node.style.getPropertyValue('filter'), '');
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
    interaction.paint();
    assert.deepEqual(snapshot(part), original);
    assert.equal(node.classList.contains('selected'), false);
    assert.equal(node.getAttribute('aria-pressed'), 'false');
    assert.equal(part.style.getPropertyValue('filter'), '');
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
  }
});

test('multiple native primitives highlight together while unrelated children and keyboard focus remain independent', () => {
  const document = testDocument('<svg id="diagram"><g data-id="entity" data-visual-type="entity"><g class="basic label-container outer-path"><path data-shape-part="entity" style="stroke-width:2.2px !important;stroke:#2F7161"/><path data-shape-part="entity" style="stroke-width:2.2px !important;stroke:#2F7161"/></g><g class="label"><rect style="stroke-width:0px"/><text>实体名称</text></g></g></svg>');
  const diagram = document.getElementById('diagram'), node = diagram.querySelector('[data-id]');
  const parts = node.querySelectorAll('[data-shape-part]'), label = node.querySelector('.label').querySelector('rect');
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  node.focus();
  assert.equal(node.classList.contains('selected'), false);
  assert.ok(parts.every(part => part.style.getPropertyValue('stroke-width') === '2.2px'));
  interaction.paint({ selectedNodes: new Set(['entity']) });
  assert.ok(parts.every(part => part.style.getPropertyValue('stroke-width') === '4.2px'));
  assert.equal(label.style.getPropertyValue('stroke-width'), '0px');
  assert.match(parts[0].parentElement.style.getPropertyValue('filter'), /^url\(/);
  assert.equal(node.style.getPropertyValue('filter'), '');
  assert.equal(label.parentElement.style.getPropertyValue('filter'), '');
  interaction.paint();
  assert.equal(document.activeElement, node, 'Clearing selection does not need to remove keyboard focus');
  assert.ok(parts.every(part => part.style.getPropertyValue('stroke-width') === '2.2px'));
});

test('clearing accurately restores a normal priority or removes a previously absent inline width', () => {
  const document = testDocument('<svg id="diagram"><g data-id="normal" data-visual-type="component"><rect data-shape-part="normal" style="stroke-width:1.7px;fill:#fff"/></g><g data-id="attribute" data-visual-type="component"><rect data-shape-part="attribute" stroke-width="1.8" style="fill:#fff"/></g><g data-id="computed" data-visual-type="component"><rect data-shape-part="computed" style="fill:#fff"/></g></svg>');
  document.defaultView = { getComputedStyle: part => ({ strokeWidth: part.getAttribute('stroke-width') || '1.9px' }) };
  const diagram = document.getElementById('diagram'), interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  const normal = diagram.querySelector('[data-id="normal"]').querySelector('rect');
  const attribute = diagram.querySelector('[data-id="attribute"]').querySelector('rect');
  const computed = diagram.querySelector('[data-id="computed"]').querySelector('rect');
  interaction.paint({ selectedNodes: new Set(['normal', 'attribute', 'computed']) });
  assert.equal(normal.style.getPropertyValue('stroke-width'), '3.7px');
  assert.equal(attribute.style.getPropertyValue('stroke-width'), '3.8px');
  assert.equal(computed.style.getPropertyValue('stroke-width'), '3.9px');
  interaction.paint();
  assert.equal(normal.style.getPropertyValue('stroke-width'), '1.7px');
  assert.equal(normal.style.getPropertyPriority('stroke-width'), '');
  assert.equal(attribute.style.getPropertyValue('stroke-width'), '');
  assert.equal(attribute.getAttribute('stroke-width'), '1.8');
  assert.equal(computed.style.getPropertyValue('stroke-width'), '');
});

test('Schedule endpoint highlighting affects only each own container and restores nested groups', () => {
  const document = testDocument('<svg id="diagram"><g data-schedule-id="outer"><rect style="stroke-width:1px;stroke:#333"/><g data-schedule-id="inner"><rect style="stroke-width:1.4px !important;stroke:#555"/><g data-id="system" data-visual-type="system"><rect data-shape-part="system" style="stroke-width:1.6px !important"/></g></g></g></svg>');
  const diagram = document.getElementById('diagram'), outer = diagram.querySelector('[data-schedule-id="outer"]').children[0], inner = diagram.querySelector('[data-schedule-id="inner"]').children[0];
  const system = diagram.querySelector('[data-shape-part]'), interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  interaction.paint({ selectedSchedules: new Set(['outer']) });
  assert.equal(outer.style.getPropertyValue('stroke-width'), '3px');
  assert.equal(inner.style.getPropertyValue('stroke-width'), '1.4px');
  assert.equal(system.style.getPropertyValue('stroke-width'), '1.6px');
  interaction.paint({ selectedSchedules: new Set(['inner']) });
  assert.equal(outer.style.getPropertyValue('stroke-width'), '1px');
  assert.equal(inner.style.getPropertyValue('stroke-width'), '3.4px');
  interaction.paint();
  assert.equal(inner.style.getPropertyValue('stroke-width'), '1.4px');
  assert.equal(inner.style.getPropertyPriority('stroke-width'), 'important');
});

test('all semantic edges retain their native styling while interaction classes are reset together', () => {
  const markup = Object.entries(EDGE_STYLES).map(([semantic, style]) => `<path class="edge" data-link-id="${semantic}" style="stroke:${style.stroke};stroke-width:${style.width}px${style.dash ? ';stroke-dasharray:' + style.dash : ''}"/>`).join('');
  const document = testDocument(`<svg id="diagram">${markup}</svg>`), diagram = document.getElementById('diagram');
  const originals = new Map(diagram.querySelectorAll('.edge').map(edge => [edge, edge.getAttribute('style')]));
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  for (const edge of diagram.querySelectorAll('.edge')) {
    interaction.paint({ focusedEdges: new Set([edge.dataset.linkId]), dimEdges: new Set([...originals.keys()].filter(other => other !== edge).map(other => other.dataset.linkId)) });
    assert.equal(edge.classList.contains('focused'), true);
    assert.equal(diagram.querySelectorAll('.edge.focused').length, 1);
    assert.equal(diagram.querySelectorAll('.edge.dim').length, originals.size - 1);
  }
  interaction.paint();
  assert.equal(diagram.querySelectorAll('.focused').length, 0);
  assert.equal(diagram.querySelectorAll('.dim').length, 0);
  for (const [edge, original] of originals) assert.equal(edge.getAttribute('style'), original);
});

test('the blue ring is the difference of native SourceAlpha dilations with a one-pixel gap and two-pixel width', () => {
  const document = testDocument('<svg id="diagram"><defs><marker id="existing-arrow"/></defs><g data-id="entity" data-visual-type="entity"><g class="basic label-container outer-path"><path data-shape-part="entity" style="fill:#EEF4F2;stroke:#2F7161;stroke-width:2.2px !important"/><path data-shape-part="entity" style="fill:none;stroke:#2F7161;stroke-width:2.2px !important"/></g><g class="label"><text>实体名称</text></g></g></svg>');
  const diagram = document.getElementById('diagram'), node = diagram.querySelector('[data-id]');
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  const shapeCount = diagram.querySelectorAll('path').length, childCount = node.children.length;
  interaction.paint({ selectedNodes: new Set(['entity']) });
  const filter = diagram.querySelector('[data-selection-filter]'), morphs = filter.querySelectorAll('feMorphology'), composites = filter.querySelectorAll('feComposite');
  assert.equal(filter.getAttribute('filterUnits'), 'userSpaceOnUse');
  assert.equal(filter.getAttribute('primitiveUnits'), 'userSpaceOnUse');
  assert.deepEqual(morphs.map(item => [item.getAttribute('in'), item.getAttribute('operator'), item.getAttribute('radius'), item.getAttribute('result')]), [['SourceAlpha', 'dilate', '3', 'outer'], ['SourceAlpha', 'dilate', '1', 'inner']]);
  assert.deepEqual(composites.map(item => [item.getAttribute('in'), item.getAttribute('in2'), item.getAttribute('operator')]), [['outer', 'inner', 'out'], ['color', 'ring', 'in']]);
  assert.equal(filter.querySelector('feFlood').getAttribute('flood-color'), SELECTION_STYLE.ringColor);
  assert.equal(Number(filter.querySelector('feFlood').getAttribute('flood-opacity')), .85);
  assert.deepEqual(filter.querySelectorAll('feMergeNode').map(item => item.getAttribute('in')), ['colored-ring', 'SourceGraphic']);
  assert.equal(diagram.querySelectorAll('path').length, shapeCount, 'No native outline is cloned for selection');
  assert.equal(node.children.length, childCount);
  assert.equal(diagram.querySelectorAll('rect').length, 0, 'The ring has no proxy rectangle');
  assert.ok(diagram.querySelector('#existing-arrow'));
  interaction.paint();
  assert.equal(diagram.querySelector('[data-selection-filter]'), null);
  assert.ok(diagram.querySelector('#existing-arrow'), 'Clearing selection retains original marker definitions');
});

test('zoom keeps screen emphasis constant and expands local filter bounds even below the ordinary zoom floor', () => {
  const document = testDocument('<svg id="diagram"><g data-id="resource" data-visual-type="resource"><path data-shape-part="resource" style="fill:#FAF4E9;stroke:#A5792C;stroke-width:1.6px !important"/></g><g data-id="other" data-visual-type="component"><rect data-shape-part="other" style="fill:#fff;stroke:#4B8060;stroke-width:1.6px !important"/></g></svg>');
  const diagram = document.getElementById('diagram'), node = diagram.querySelector('[data-id="resource"]'), part = node.querySelector('path'), other = diagram.querySelector('[data-id="other"]').querySelector('rect');
  part.bbox = { x: -140, y: -50, width: 280, height: 100 };
  diagram.style.transform = 'translate(25px,15px) scale(.4)';
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  interaction.paint({ selectedNodes: new Set(['resource']) });
  const filter = diagram.querySelector('[data-selection-filter]'), id = filter.id, originalOther = snapshot(other);
  for (const scale of [.5, .08, .01, .001, 2.4, 1]) {
    interaction.setScale(scale);
    const width = parseFloat(part.style.getPropertyValue('stroke-width'));
    assert.ok(Math.abs((width - 1.6) * scale - 2) < 1e-10, String(scale));
    const morphs = filter.querySelectorAll('feMorphology');
    assert.ok(Math.abs(Number(morphs[1].getAttribute('radius')) * scale - 1) < 1e-10);
    assert.ok(Math.abs((Number(morphs[0].getAttribute('radius')) - Number(morphs[1].getAttribute('radius'))) * scale - 2) < 1e-10);
    const padding = width / 2 + 5 / scale;
    assert.equal(Number(filter.getAttribute('x')), part.bbox.x - padding);
    assert.equal(Number(filter.getAttribute('y')), part.bbox.y - padding);
    assert.equal(Number(filter.getAttribute('width')), part.bbox.width + 2 * padding);
    assert.equal(Number(filter.getAttribute('height')), part.bbox.height + 2 * padding);
    assert.equal(filter.id, id, 'Scaling reuses the current filter');
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
    assert.deepEqual(snapshot(other), originalOther);
    assert.equal(diagram.style.transform, 'translate(25px,15px) scale(.4)', 'Selection does not alter pan or zoom');
  }
  interaction.paint();
  assert.equal(part.style.getPropertyValue('stroke-width'), '1.6px');
  assert.equal(node.style.getPropertyValue('filter'), '');
  interaction.setScale(.005);
  assert.equal(part.style.getPropertyValue('stroke-width'), '1.6px');
  for (const scale of [0, -1, NaN, Infinity]) assert.throws(() => interaction.setScale(scale), /positive finite/);
});

test('transparent and unpainted primitives stay transparent while real inline fills override raw SVG hints', () => {
  const document = testDocument('<svg id="diagram"><g data-id="system" data-visual-type="system"><g class="basic label-container outer-path"><path data-shape-part="system" style="fill:none !important;stroke-width:1.6px"/><path data-shape-part="system" style="fill:transparent;stroke-width:1.6px"/><path data-shape-part="system" style="fill:rgba(2,3,4,0);stroke-width:1.6px"/><path data-shape-part="system" fill="#1230" stroke-width="1.6"/><path data-shape-part="system" fill="#12345600" stroke-width="1.6"/><path data-shape-part="system" style="fill:#EFF3F8;fill-opacity:0;stroke-width:1.6px"/><path data-shape-part="system" fill="none" style="fill:#EFF3F8 !important;stroke-width:1.6px"/></g><g class="label"><text>不可高亮文字</text></g></g></svg>');
  const diagram = document.getElementById('diagram'), parts = diagram.querySelectorAll('[data-shape-part]'), originals = parts.map(snapshot);
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  interaction.paint({ selectedNodes: new Set(['system']) });
  for (const [index, part] of parts.entries()) if (index < parts.length - 1) assert.deepEqual(snapshot(part).find(([name]) => name === 'fill'), originals[index].find(([name]) => name === 'fill'));
  assert.equal(parts.at(-1).style.getPropertyValue('fill'), selectedFillColor(NODE_STYLES.system.stroke));
  const node = diagram.querySelector('[data-id]'), outline = parts[0].parentElement, label = node.querySelector('.label');
  assert.match(outline.style.getPropertyValue('filter'), /^url\(/);
  assert.equal(outline.querySelector('text'), null);
  assert.equal(node.style.getPropertyValue('filter'), '');
  assert.equal(label.style.getPropertyValue('filter'), '');
  interaction.paint();
  assert.deepEqual(parts.map(snapshot), originals);
});

test('repeated activation and scale updates restore fill, width and existing filter priorities from one original snapshot', () => {
  const document = testDocument('<svg id="diagram"><g data-id="system" data-visual-type="system" style="filter:brightness(.9) !important"><g class="basic label-container outer-path" style="filter:contrast(.8)"><path data-shape-part="system" style="fill:#FAFAFA;stroke:#3567A6 !important;stroke-width:1.6px !important;stroke-dasharray:6 4 !important"/></g><g class="label"><text>名称</text></g></g></svg>');
  const diagram = document.getElementById('diagram'), node = diagram.querySelector('[data-id]'), part = node.querySelector('path'), outline = part.parentElement;
  const original = snapshot(part), interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  for (let repeat = 0; repeat < 3; repeat++) {
    interaction.paint({ selectedNodes: new Set(['system']) });
    interaction.setScale(.05);
    interaction.paint({ selectedNodes: new Set(['system']) });
    assert.equal(part.style.getPropertyValue('stroke-width'), '41.6px');
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 1);
    assert.match(outline.style.getPropertyValue('filter'), /^contrast\(\.8\) url\(#diagram-selection-\d+\)$/);
    assert.equal(outline.style.getPropertyPriority('filter'), 'important');
    assert.equal(node.style.getPropertyValue('filter'), 'brightness(.9)');
    assert.equal(node.style.getPropertyPriority('filter'), 'important');
    interaction.paint();
    assert.deepEqual(snapshot(part), original);
    assert.equal(node.style.getPropertyValue('filter'), 'brightness(.9)');
    assert.equal(node.style.getPropertyPriority('filter'), 'important');
    assert.equal(outline.style.getPropertyValue('filter'), 'contrast(.8)');
    assert.equal(outline.style.getPropertyPriority('filter'), '');
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length, 0);
  }
});

test('Schedule selection filters and strengthens only its own rect during zoom, leaving child systems untouched', () => {
  const document = testDocument('<svg id="diagram"><g data-schedule-id="outer"><rect style="fill:#F8FAFC;stroke:#DDE4ED;stroke-width:1px"/><g data-schedule-id="inner"><rect style="fill:#F8FAFC;stroke:#DDE4ED;stroke-width:1px"/><g data-id="system" data-visual-type="system"><rect data-shape-part="system" style="fill:#EFF3F8;stroke:#3567A6;stroke-width:1.6px"/></g></g></g></svg>');
  const diagram = document.getElementById('diagram'), outer = diagram.querySelector('[data-schedule-id="outer"]'), inner = diagram.querySelector('[data-schedule-id="inner"]'), node = diagram.querySelector('[data-id]');
  const rect = outer.children[0], childRect = inner.children[0], childSystem = node.querySelector('rect');
  const original = snapshot(rect), children = [snapshot(childRect), snapshot(childSystem)];
  const interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  interaction.setScale(.25);
  interaction.paint({ selectedSchedules: new Set(['outer']) });
  assert.equal(rect.style.getPropertyValue('fill'), selectedFillColor('#DDE4ED'));
  assert.equal(rect.style.getPropertyValue('stroke-width'), '9px');
  assert.match(rect.style.getPropertyValue('filter'), /url\(#diagram-selection-/);
  for (const group of [outer, inner, node]) assert.equal(group.style.getPropertyValue('filter'), '');
  assert.deepEqual([snapshot(childRect), snapshot(childSystem)], children);
  interaction.paint();
  assert.deepEqual(snapshot(rect), original);
  assert.equal(rect.style.getPropertyValue('filter'), '');
});

test('scale updates discard selections from replaced SVGs without modifying the new diagram', () => {
  const document = testDocument('<div id="diagram"><svg id="first"><g data-id="old" data-visual-type="system"><rect data-shape-part="old" style="fill:#EFF3F8;stroke-width:1.6px"/></g></svg></div>');
  const diagram = document.getElementById('diagram'), old = diagram.querySelector('[data-id]'), interaction = createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES });
  interaction.paint({ selectedNodes: new Set(['old']) });
  diagram.innerHTML = '<svg id="second"><g data-id="new" data-visual-type="system"><rect data-shape-part="new" style="fill:#EFF3F8;stroke-width:1.6px"/></g></svg>';
  interaction.setScale(.2);
  assert.equal(old.style.getPropertyValue('filter'), '');
  assert.equal(old.querySelector('rect').style.getPropertyValue('stroke-width'), '1.6px');
  assert.equal(diagram.querySelector('[data-id]').style.getPropertyValue('filter'), '');
  assert.equal(diagram.querySelector('rect').style.getPropertyValue('stroke-width'), '1.6px');
  assert.equal(diagram.querySelector('[data-selection-filter]'), null);
});

test('selection rejects split outline roots and geometry branches containing label text', () => {
  for (const [markup, error] of [
    ['<path data-shape-part="bad"/><path data-shape-part="bad"/><g class="label"><text>名称</text></g>', /one native outline root/],
    ['<g><path data-shape-part="bad"/><text>名称</text></g>', /exclude labels and text/],
    ['<g><path data-shape-part="bad"/><g class="label"/></g>', /exclude labels and text/],
  ]) {
    const document = testDocument(`<svg id="diagram"><g data-id="bad" data-visual-type="entity">${markup}</g></svg>`), diagram = document.getElementById('diagram');
    assert.throws(() => createArchitectureInteraction({ diagram, nodeStyles: NODE_STYLES }).paint({ selectedNodes: new Set(['bad']) }), error);
    assert.equal(diagram.querySelector('[data-selection-filter]'), null);
  }
});

test('delivered native nodes of every used visual type have one complete outline branch independent of their labels', () => {
  const data = readArchitectureData(repositoryRoot);
  const types = new Set(); let count = 0;
  for (const view of data.views.filter(view => view.svg)) {
    const elements = svgElements(view.svg);
    const nodes = elements.filter(element => element.attrs['data-id']);
    assert.equal(nodes.length, view.nodes.length, view.id);
    for (const node of nodes) {
      const inside = (element, ancestor) => { for (let current = element; current; current = current.parent) if (current === ancestor) return true; return false; };
      const parts = elements.filter(element => element.attrs['data-shape-part'] === node.attrs['data-instance']);
      const roots = new Set(parts.map(part => { while (part.parent !== node) part = part.parent; return part; }));
      assert.equal(roots.size, 1, `${view.id}/${node.attrs['data-id']}`);
      const root = [...roots][0], descendants = elements.filter(element => inside(element, root));
      assert.ok(parts.every(part => inside(part, root)));
      assert.ok(descendants.every(element => element.tag === 'g' || parts.includes(element)), 'Only native geometry belongs to the SourceAlpha outline');
      if (node.attrs['data-presentation'] === 'entity-container') {
        const headers = elements.filter(element => element.attrs['data-entity-header'] === node.attrs['data-instance']);
        assert.equal(headers.length, 1);
        assert.equal(headers[0].attrs['data-entity-owner'], node.attrs['data-id']);
        assert.equal(headers[0].attrs['aria-hidden'], 'true');
        assert.equal(inside(headers[0], root), false);
        for (const attribute of ['data-id', 'tabindex', 'role', 'data-shape-part']) assert.equal(headers[0].attrs[attribute], undefined);
      } else assert.ok(node.children.some(element => (element.attrs.class || '').split(/\s+/).includes('label') && element !== root));
      types.add(node.attrs['data-visual-type']); count++;
    }
  }
  assert.equal(count, data.views.reduce((sum, view) => sum + view.nodes.length, 0));
  const used = new Set(data.views.flatMap(view => view.nodes.map(node => node.visualType)));
  assert.deepEqual([...types].sort(), [...used].sort());
  for (const type of types) assert.ok(NODE_STYLES[type], 'Every delivered type must have an explicit style: ' + type);
});
