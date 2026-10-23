import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenPath, flattenShape, measureMermaidNodes, pathAxis, pathCurveDeviation, pointSegmentDistance, shapeBounds, svgElements } from './svg-shape-geometry.mjs';

const node = (contents, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(100 50)"><g class="node" data-id="resource" data-instance="v--n0" data-visual-type="resource" ${extra}>${contents}</g></g></svg>`;
const near = (actual, expected) => {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < .01, `${key}: ${actual[key]} != ${expected[key]}`);
};

test('measures a native cylinder composed of a curved outline and its cap', () => {
  const svg = node('<path data-shape-part="v--n0" d="M-30,-20 C-30,-30 30,-30 30,-20 L30,20 C30,30 -30,30 -30,20 Z"/><path data-shape-part="v--n0" d="M-30,-20 C-30,-10 30,-10 30,-20"/>');
  near(measureMermaidNodes(svg).get('resource'), { x: 70, y: 22.5, width: 60, height: 55 });
});

test('unions the real pieces of stacked and framed nodes instead of taking their first rectangle', () => {
  const svg = node('<rect data-shape-part="v--n0" x="-20" y="-20" width="40" height="40"/><path data-shape-part="v--n0" d="M-15,-25 H25 V15 M-10,-30 H30 V10"/><rect x="-200" y="-100" width="400" height="200" class="label"/>');
  near(measureMermaidNodes(svg).get('resource'), { x: 80, y: 20, width: 50, height: 50 });
});

test('handles polygon, ellipse and native curves under ancestor transforms', () => {
  const svg = node('<polygon data-shape-part="v--n0" points="-20,0 0,-10 20,0 0,10"/><ellipse data-shape-part="v--n0" cx="0" cy="0" rx="10" ry="20"/>', 'transform="scale(2 1.5)"');
  near(measureMermaidNodes(svg).get('resource'), { x: 60, y: 20, width: 80, height: 60 });
  const rotated = svgElements('<svg><g transform="translate(10 20) rotate(90)"><rect x="0" y="0" width="40" height="10"/></g></svg>').find(element => element.tag === 'rect');
  near(shapeBounds(rotated), { x: 0, y: 20, width: 10, height: 40 });
});

test('a curved node uses path extrema rather than control point or replacement bounds', () => {
  const svg = node('<path data-shape-part="v--n0" d="M0,0 Q100,100 200,0 L200,100 L0,100 Z"/>');
  near(measureMermaidNodes(svg).get('resource'), { x: 100, y: 50, width: 200, height: 100 });
  const bounds = shapeBounds(svgElements('<svg><path d="M5 10c3 0 3 3 0 3z"/></svg>').find(element => element.tag === 'path'));
  near(bounds, { x: 5, y: 10, width: 2.25, height: 3 });
});

test('near-degenerate native cubic segments stay stable on large translated canvases', () => {
  const svg = '<svg><g transform="translate(1672.5501861572266 894.9595101848672)"><path d="M-110.61403953794401,-34.89999961853027 C-110.61403953794401,-34.89999961853027 -110.61403953794401,-34.89999961853027 -110.614039537944,-34.89999961853027"/></g></svg>';
  const element = svgElements(svg).find(item => item.tag === 'path');
  near(shapeBounds(element), { x: 1561.9361466192825, y: 860.0595105663369, width: 0, height: 0 });
});

test('modern nodes require marked native parts and cannot silently use old rectangle metadata', () => {
  assert.throws(() => measureMermaidNodes(node('<rect data-box-id="v--n0" width="20" height="20"/>')), /Missing Mermaid node shape/);
  assert.throws(() => measureMermaidNodes(node('<path data-shape-part="other" d="M0,0H20V20Z"/>')), /Missing Mermaid node shape/);
  assert.throws(() => measureMermaidNodes(node('<text data-shape-part="v--n0">proxy</text>')), /Unsupported Mermaid shape primitive/);
  assert.throws(() => measureMermaidNodes(node('<path data-shape-part="v--n0" d="M0,0Lbad"/>')), /Invalid Mermaid shape path/);
});

test('old rectangle fixtures remain measurable without visual type metadata', () => {
  const svg = node('<rect data-box-id="v--n0" x="-20" y="-10" width="40" height="20"/>').replace(' data-visual-type="resource"', '');
  near(measureMermaidNodes(svg).get('resource'), { x: 80, y: 40, width: 40, height: 20 });
});

test('adaptive quadratic and cubic subdivisions bound geometric error without losing Move boundaries', () => {
  const cubic = [[0, 0], [400, 900], [-400, 900], [0, 0]], quadratic = [[0, 0], [300, 700], [100, 0]];
  for (const [points, source] of [[cubic, 'M0 0C400 900 -400 900 0 0'], [quadratic, 'M0 0Q300 700 100 0']]) {
    const flattened = flattenPath(source)[0].points;
    for (let index = 0; index <= 2000; index++) {
      const t = index / 2000, u = 1 - t;
      const p = points.length === 4 ? [0, 1].map(axis => u ** 3 * points[0][axis] + 3 * u * u * t * points[1][axis] + 3 * u * t * t * points[2][axis] + t ** 3 * points[3][axis])
        : [0, 1].map(axis => u * u * points[0][axis] + 2 * u * t * points[1][axis] + t * t * points[2][axis]);
      assert.ok(Math.min(...flattened.slice(1).map((last, at) => pointSegmentDistance(p, flattened[at], last))) <= .250001);
    }
  }
  const separated = flattenPath('M0 0L10 0M30 0L40 0Z');
  assert.equal(separated.length, 2); assert.equal(separated[0].closed, false); assert.equal(separated[1].closed, true);
  assert.deepEqual(separated[1].points.at(-1), [30, 0]);
  assert.throws(() => flattenPath('M0 0L10 0', { tolerance: 0 }), /Invalid Mermaid flattening tolerance/);
});

test('large native ellipse arcs retain the requested error after ancestor transforms', () => {
  const element = svgElements('<svg><g transform="translate(12 30) rotate(20) scale(2 1)"><ellipse cx="0" cy="0" rx="10000" ry="2000"/></g></svg>').find(item => item.tag === 'ellipse');
  const path = flattenShape(element)[0].points, angle = 20 * Math.PI / 180;
  for (let index = 0; index < 2000; index++) {
    const t = index * Math.PI / 1000, x = 20000 * Math.cos(t), y = 2000 * Math.sin(t), point = [12 + Math.cos(angle) * x - Math.sin(angle) * y, 30 + Math.sin(angle) * x + Math.cos(angle) * y];
    assert.ok(Math.min(...path.slice(1).map((last, at) => pointSegmentDistance(point, path[at], last))) <= .25001);
  }
});

test('axis classification rejects orthogonal bends, diagonal lines and visible curves', () => {
  const element = d => svgElements(`<svg><path d="${d}"/></svg>`).find(item => item.tag === 'path');
  assert.equal(pathAxis(element('M10 20H100')), 'horizontal');
  assert.equal(pathAxis(element('M10 20V100')), 'vertical');
  for (const d of ['M0 0L10 10', 'M0 0H10V10', 'M0 0Q50 20 100 0', 'M0 0H10M30 0H40']) assert.equal(pathAxis(element(d)), null);
  assert.equal(pathAxis(element('M0 0L100 .4')), 'horizontal');
});

test('curve classification measures actual Bezier and arc extrema rather than command letters', () => {
  const element = (d, transform = '') => svgElements(`<svg><g transform="${transform}"><path d="${d}"/></g></svg>`).find(item => item.tag === 'path');
  for (const d of ['M0 0L100 100', 'M0 0Q50 50 100 100', 'M0 0C20 20 80 80 100 100', 'M0 0C10 10 20 20 30 30L40 20Q50 10 60 0', 'M0 0C20 20 -20 -20 0 0', 'M0 0A0 10 0 0 0 100 100']) {
    assert.ok(pathCurveDeviation(element(d)) < 1e-8, d);
  }
  assert.ok(Math.abs(pathCurveDeviation(element('M0 0Q50 20 100 0')) - 10) < 1e-8);
  assert.ok(Math.abs(pathCurveDeviation(element('M0 0C0 20 100 20 100 0')) - 15) < 1e-8);
  assert.ok(Math.abs(pathCurveDeviation(element('M0 0Q50 20 100 0', 'translate(12000 8000) rotate(40) scale(2)')) - 20) < 1e-8);
  assert.ok(Math.abs(pathCurveDeviation(element('M0 0A50 50 0 0 1 100 0')) - 50) < 1e-8);
  for (const d of ['M0 0C50 100 -50 100 0 0', 'M0 0C20 100 80 -100 100 0', 'M0 0Q50 20 100 0T200 0', 'M0 0A80 30 35 1 0 100 60']) assert.ok(pathCurveDeviation(element(d)) > 1, d);
});

test('native rounded rectangles preserve their curved corners for routing', () => {
  const element = svgElements('<svg><rect x="10" y="20" width="100" height="80" rx="20"/></svg>').find(item => item.tag === 'rect');
  const contour = flattenShape(element)[0];
  assert.equal(contour.closed, true); assert.ok(contour.points.length > 12);
  assert.ok(contour.points.every(point => Math.hypot(point[0] - 10, point[1] - 20) > 5));
});

test('Entity native containers measure their own outline without absorbing nested Component shapes', () => {
  const svg = '<svg><g class="cluster" data-presentation="entity-container" data-id="entity" data-instance="e" data-visual-type="entity"><rect data-shape-part="e" x="10" y="20" width="100" height="100"/><g class="node" data-id="component" data-instance="c" data-visual-type="component"><rect data-shape-part="c" x="30" y="60" width="60" height="30"/></g></g></svg>';
  const measured = measureMermaidNodes(svg);
  near(measured.get('entity'), { x: 10, y: 20, width: 100, height: 100 }); near(measured.get('component'), { x: 30, y: 60, width: 60, height: 30 });
  assert.throws(() => measureMermaidNodes(svg.replace(' data-presentation="entity-container"', '')), /Invalid or duplicate Mermaid semantic node/);
  assert.throws(() => measureMermaidNodes(svg.replace('<g class="node" data-id="component"', '<g class="node" data-id="component"').replace('data-shape-part="c"', 'data-shape-part="foreign"')), /Mermaid node shape instance mismatch/);
  assert.throws(() => measureMermaidNodes(svg.replace('data-shape-part="c"', 'data-shape-part="e"')), /Mermaid node shape instance mismatch/);
});
