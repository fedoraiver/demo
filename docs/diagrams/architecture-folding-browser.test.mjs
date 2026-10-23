import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer';

const directory = fileURLToPath(new URL('.', import.meta.url));
const chromium = process.env.MERMAID_CHROMIUM_PATH || [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
  .find(candidate => fs.existsSync(candidate));

test('generated offline viewer preserves independent Entity folding, focus, history and asynchronous layout ownership', { skip: !chromium, timeout: 240000 }, async t => {
  const temporary = path.resolve(directory, '../../tmp/ecs-architecture/multi-entity-browser');
  fs.mkdirSync(temporary, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, userDataDir: fs.mkdtempSync(path.join(temporary, 'profile-')) });
  try {
    async function scenario(name, run) {
      let failure;
      await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } });
      if (failure) throw failure;
    }
    const page = await browser.newPage(), requests = [], errors = [];
    await page.setViewport({ width: 1500, height: 1000 });
    await page.setOfflineMode(true);
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (/^https?:/i.test(request.url())) { requests.push(request.url()); request.abort(); }
      else request.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    const url = pathToFileURL(path.join(directory, 'ecs-architecture.html'));
    url.search = '?feature=avian&tab=data&workspace=D%3A%2Fdemo&keep=folding-test';
    url.hash = '#entity-browser-test';
    await page.goto(url.href, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof baseView !== 'undefined' && baseView.feature === 'avian' && baseView.aspect === 'data' && canvas.getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => typeof architectureEntityRuntime?.compile), 'function');
    const [A, B, C, D] = await page.evaluate(() => baseView.entityGroups.map(group => group.entity));
    assert.ok(A && B && C && D);
    const button = id => `#diagram button[data-entity-toggle="${id}"]`;
    const expanded = () => page.evaluate(() => [...diagram.querySelectorAll('button[data-entity-toggle][aria-expanded="true"]')].map(button => button.dataset.entityToggle));
    const waitExpanded = async ids => {
      await page.waitForFunction(ids => {
        const actual = [...document.querySelectorAll('#diagram button[data-entity-toggle][aria-expanded="true"]')].map(button => button.dataset.entityToggle);
        return canvas.getAttribute('aria-busy') === 'false' && JSON.stringify(actual) === JSON.stringify(ids);
      }, { timeout: 60000 }, ids);
      assert.deepEqual(await expanded(), ids);
    };
    const toggle = async (id, expected) => { await page.$eval(button(id), button => button.click()); await waitExpanded(expected); };
    const anchor = id => page.evaluate(id => {
      const node = [...diagram.querySelectorAll('[data-id]')].find(node => node.dataset.id === id);
      const part = [...node.querySelectorAll('[data-shape-part]')].find(part => part.dataset.shapePart === node.dataset.instance);
      const box = part.getBoundingClientRect();
      return { x: box.x, y: box.y, scale };
    }, id);

    await scenario('corner buttons are native, accessible and independent while preserving scale and screen anchor', async () => {
      await waitExpanded([]);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(button => ['展开全部', '全部缩略', '全部展开'].includes(button.textContent.trim()))), false);
      const geometry = await page.evaluate(id => {
        const button = [...diagram.querySelectorAll('button[data-entity-toggle]')].find(button => button.dataset.entityToggle === id), node = view.nodes.find(node => node.id === id);
        const style = getComputedStyle(button);
        return { text: button.textContent, aria: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded'), tag: button.tagName,
          width: parseFloat(style.width), height: parseFloat(style.height), right: node.position.x - (view.bounds?.x || 0) + node.position.width - parseFloat(style.left) - parseFloat(style.width), top: parseFloat(style.top) - node.position.y + (view.bounds?.y || 0), color: style.color };
      }, A);
      assert.equal(geometry.tag, 'BUTTON'); assert.equal(geometry.text, '+'); assert.equal(geometry.expanded, 'false');
      assert.match(geometry.aria, /展开组件（\d+）/);
      assert.equal(geometry.width, 24); assert.equal(geometry.height, 24);
      assert.ok(Math.abs(geometry.right - 8) < .01 && Math.abs(geometry.top - 8) < .01);
      assert.equal(geometry.color, 'rgb(166, 83, 59)');
      await page.$eval(button(A), button => button.focus({ preventScroll: true }));
      const before = await anchor(A);
      await page.keyboard.press('Enter'); await waitExpanded([A]);
      const after = await anchor(A);
      assert.ok(Math.abs(before.x - after.x) < .1 && Math.abs(before.y - after.y) < .1);
      assert.equal(after.scale, before.scale);
      assert.equal(await page.$eval(button(A), button => button.textContent), '−');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.entityToggle), A);
      assert.equal(await page.$$eval('#diagram [data-selection-filter]', filters => filters.length), 0);
      await toggle(B, [A, B]); await toggle(C, [A, B, C]);
      const evidence = path.resolve(directory, '../../tmp/ecs-architecture/multi-entity');
      fs.mkdirSync(evidence, { recursive: true });
      await page.click('#fit');
      await page.screenshot({ path: path.join(evidence, 'browser-three-entities.png') });
      await page.evaluate(id => { focusNode(id); select(null); }, D);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const detailBox = await page.evaluate(id => {
        const node = [...diagram.querySelectorAll('[data-id]')].find(node => node.dataset.id === id), part = [...node.querySelectorAll('[data-shape-part]')].find(part => part.dataset.shapePart === node.dataset.instance);
        const box = part.getBoundingClientRect();
        return { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
      }, D);
      assert.equal(await page.evaluate(() => scale), 1);
      await page.screenshot({ path: path.join(evidence, 'browser-corner-context.png') });
      await page.screenshot({ path: path.join(evidence, 'browser-entity-corner-detail.png'), clip: detailBox, captureBeyondViewport: false });
      await toggle(A, [B, C]);
      assert.equal(await page.evaluate(() => view.nodes.some(node => node.id === 'character.Friction')), false);
      const endpoints = await page.evaluate(() => view.links.map(link => ({ from: link.from, to: link.to, displayFrom: link.displayFrom, displayTo: link.displayTo })));
      for (const edge of endpoints) {
        const expectedFrom = await page.evaluate(id => baseView.entityGroups.find(group => !entityMode.includes(group.entity) && group.components.includes(id))?.entity || id, edge.from);
        const expectedTo = await page.evaluate(id => baseView.entityGroups.find(group => !entityMode.includes(group.entity) && group.components.includes(id))?.entity || id, edge.to);
        assert.equal(edge.displayFrom, expectedFrom); assert.equal(edge.displayTo, expectedTo);
      }
    });

    await scenario('search temporarily opens hidden components and history restores array state after navigation and reload', async () => {
      const query = await page.evaluate(id => baseView.entityGroups.find(group => group.entity === id).components[0], D);
      await page.$eval('#search', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, query);
      await waitExpanded([B, C, D]);
      assert.match(await page.$eval('#details h2', node => node.textContent), /匹配节点/);
      await page.$eval('#search', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await waitExpanded([B, C]);
      assert.deepEqual(await page.evaluate(() => history.state.architectureEntityModes[baseView.id]), [B, C]);
      await page.click('[data-aspect="events"]');
      await page.waitForFunction(() => baseView.aspect === 'events');
      await page.goBack({ waitUntil: 'load' });
      await page.waitForFunction(() => baseView.feature === 'avian' && baseView.aspect === 'data');
      await waitExpanded([B, C]);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => typeof baseView !== 'undefined' && baseView.feature === 'avian' && baseView.aspect === 'data');
      await waitExpanded([B, C]);
      const state = await page.evaluate(() => ({ expanded: history.state.architectureEntityModes[baseView.id], workspace: new URL(location.href).searchParams.get('workspace'), keep: new URL(location.href).searchParams.get('keep'), hash: location.hash }));
      assert.deepEqual(state, { expanded: [B, C], workspace: 'D:/demo', keep: 'folding-test', hash: '#entity-browser-test' });
    });

    await scenario('failed layout keeps the previous view and successful retry commits the target set', async () => {
      await toggle(B, [C]); await toggle(C, []); await toggle(A, [A]);
      const previous = await page.evaluate(() => ({ id: view.id, svg: diagram.querySelector('svg').outerHTML }));
      await page.evaluate(() => { globalThis.__entityOriginalRuntime = architectureEntityRuntime; globalThis.architectureEntityRuntime = { compile: async () => { throw new Error('Injected native layout failure'); } }; });
      await page.$eval(button(C), button => button.click());
      await page.waitForFunction(() => !document.getElementById('retry-entity-layout').hidden);
      assert.deepEqual(await expanded(), [A]);
      assert.deepEqual(await page.evaluate(() => ({ id: view.id, svg: diagram.querySelector('svg').outerHTML })), previous);
      assert.deepEqual(await page.evaluate(() => history.state.architectureEntityModes[baseView.id]), [A]);
      assert.equal(await page.$eval('#canvas', canvas => canvas.getAttribute('aria-busy')), 'false');
      await page.evaluate(() => { globalThis.architectureEntityRuntime = __entityOriginalRuntime; });
      await page.click('#retry-entity-layout'); await waitExpanded([A, C]);
      assert.equal(await page.$eval('#entity-layout-status', status => status.hidden), true);
      assert.deepEqual(await page.evaluate(() => history.state.architectureEntityModes[baseView.id]), [A, C]);
    });

    await scenario('keyboard selection has one contour ring, clearing restores styles and dependency source remains available', async () => {
      const selector = '#diagram [data-id="character.Friction"]';
      const original = await page.$eval(selector, node => [...node.querySelectorAll('[data-shape-part]')].map(part => {
        const computed = getComputedStyle(part);
        return { fill: computed.fill, stroke: computed.stroke, width: computed.strokeWidth, filter: computed.filter,
          priorities: ['fill', 'stroke', 'stroke-width', 'filter'].map(name => part.style.getPropertyPriority(name)),
          attributes: ['fill', 'stroke', 'stroke-width', 'filter'].map(name => part.getAttribute(name)) };
      }));
      await page.$eval(selector, node => node.focus({ preventScroll: true })); await page.keyboard.press('Enter');
      assert.equal(await page.$$eval('#diagram [data-selection-filter]', filters => filters.length), 1);
      assert.equal(await page.$eval(selector, node => node.classList.contains('selected')), true);
      assert.equal(await page.$eval(selector, node => getComputedStyle(node).outlineStyle), 'none');
      const source = await page.$eval('#details a[data-vscode-path]', link => ({ href: link.href, path: link.dataset.vscodePath }));
      assert.match(source.href, /^vscode:\/\/file\//); assert.match(source.path, /dynamics\/rigid_body\/physics_material\.rs$/);
      await page.focus('#clear-selection'); await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'canvas');
      assert.equal(await page.$$eval('#diagram [data-selection-filter]', filters => filters.length), 0);
      assert.equal(await page.$$eval('#diagram .selected', selected => selected.length), 0);
      assert.deepEqual(await page.$eval(selector, node => [...node.querySelectorAll('[data-shape-part]')].map(part => {
        const computed = getComputedStyle(part);
        return { fill: computed.fill, stroke: computed.stroke, width: computed.strokeWidth, filter: computed.filter,
          priorities: ['fill', 'stroke', 'stroke-width', 'filter'].map(name => part.style.getPropertyPriority(name)),
          attributes: ['fill', 'stroke', 'stroke-width', 'filter'].map(name => part.getAttribute(name)) };
      })), original);
    });

    await scenario('rapid targets accumulate independently and obsolete asynchronous results cannot replace another tab', async () => {
      await page.evaluate(([first, second]) => {
        for (const id of [first, second]) [...diagram.querySelectorAll('button[data-entity-toggle]')].find(button => button.dataset.entityToggle === id).click();
      }, [B, D]);
      await waitExpanded([A, B, C, D]);
      await toggle(A, [B, C, D]);
      await page.evaluate(() => {
        globalThis.__entityOriginalRuntime = architectureEntityRuntime;
        globalThis.architectureEntityRuntime = { compile: async (...args) => { await new Promise(resolve => { globalThis.__releaseEntityLayout = resolve; }); return __entityOriginalRuntime.compile(...args); } };
      });
      await page.$eval(button(B), button => button.click());
      await page.waitForFunction(() => typeof __releaseEntityLayout === 'function');
      await page.click('[data-aspect="systems"]'); await page.waitForFunction(() => baseView.aspect === 'systems');
      const displayed = await page.evaluate(() => ({ id: view.id, svg: diagram.querySelector('svg').outerHTML }));
      await page.evaluate(async () => { __releaseEntityLayout(); await entityLayouts.resolve(DATA.views.find(view => view.feature === 'avian' && view.aspect === 'data'), ['entity-world', 'entity-held_proxy']); globalThis.architectureEntityRuntime = __entityOriginalRuntime; });
      assert.deepEqual(await page.evaluate(() => ({ id: view.id, svg: diagram.querySelector('svg').outerHTML })), displayed);
      assert.equal(await page.$eval('#entity-layout-status', status => status.hidden), true);
      await page.click('[data-aspect="data"]'); await waitExpanded([C, D]);
    });

    await scenario('UI Entity folding exposes the complete five-component backdrop with canonical ownership and definition sources', async () => {
      await page.click('.navigation [data-feature="ui"]');
      await page.waitForFunction(() => baseView.feature === 'ui' && baseView.aspect === 'systems');
      await page.click('[data-aspect="data"]');
      await page.waitForFunction(() => baseView.feature === 'ui' && baseView.aspect === 'data');
      await waitExpanded([]);
      const entity = 'entity-menu_backdrop';
      const components = [
        ['menu_backdrop.MenuBackdrop', 'ui', null, 'src/ui/backdrop.rs'],
        ['menu_backdrop.DespawnOnExit', 'infrastructure', 'bevy_state', 'src/state_scoped.rs'],
        ['menu_backdrop.Children', 'infrastructure', 'bevy_ecs', 'src/hierarchy.rs'],
        ['menu_backdrop.Transform', 'infrastructure', 'bevy_transform', 'src/components/transform.rs'],
        ['menu_backdrop.Visibility', 'infrastructure', 'bevy_camera', 'src/visibility/mod.rs'],
      ];
      assert.deepEqual(await page.evaluate(id => baseView.entityGroups.find(group => group.entity === id).components, entity), components.map(([id]) => id));
      assert.match(await page.$eval(button(entity), button => button.getAttribute('aria-label')), /展开组件（5）/);
      assert.equal(await page.$$eval('#diagram [data-id^="menu_backdrop."]', nodes => nodes.length), 0);
      await toggle(entity, [entity]);
      assert.match(await page.$eval(button(entity), button => button.getAttribute('aria-label')), /收起组件（5）/);
      assert.equal(await page.$$eval('#diagram [data-id^="menu_backdrop."]', nodes => nodes.length), 5);
      for (const [id, owner, dependency, sourcePath] of components) {
        const selector = `#diagram [data-id="${id}"]`;
        assert.equal(await page.$$eval(selector, nodes => nodes.length), 1, id);
        const identity = await page.evaluate(id => {
          const node = view.nodes.find(node => node.id === id), group = view.entityGroups.find(group => group.components.includes(id)), record = DATA.registry[id];
          const box = node.position, outer = group.bounds;
          return { entity: group.entity, feature: record.feature, definedIn: record.defined_in, role: node.role,
            inside: box.x >= outer.x && box.y >= outer.y && box.x + box.width <= outer.x + outer.width && box.y + box.height <= outer.y + outer.height };
        }, id);
        assert.deepEqual(identity, { entity, feature: owner, definedIn: owner, role: owner === 'ui' ? 'internal' : 'external', inside: true });
        await page.$eval(selector, node => node.focus({ preventScroll: true })); await page.keyboard.press('Enter');
        const source = await page.$eval('#details a[data-vscode-path]', link => ({ href: link.href, path: link.dataset.vscodePath, dependency: link.dataset.vscodeDependencyName || null, line: Number(link.dataset.vscodeLine) }));
        assert.equal(source.path, sourcePath, id); assert.equal(source.dependency, dependency, id);
        assert.match(source.href, /^vscode:\/\/file\//); assert.ok(source.line > 0, id);
        if (dependency) assert.ok(source.href.includes(`/${dependency}-`), id);
      }
      await toggle(entity, []);
      assert.equal(await page.$$eval('#diagram [data-id^="menu_backdrop."]', nodes => nodes.length), 0);
      await page.$eval('#search', input => { input.value = 'menu_backdrop.DespawnOnExit'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await waitExpanded([entity]);
      assert.equal(await page.$eval('#diagram [data-id="menu_backdrop.DespawnOnExit"]', node => node.classList.contains('selected')), true);
      assert.deepEqual(await page.evaluate(() => history.state.architectureEntityModes[baseView.id]), []);
      await page.$eval('#search', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await waitExpanded([]);
      assert.equal(await page.$$eval('#diagram [data-id^="menu_backdrop."]', nodes => nodes.length), 0);
      assert.equal(await page.$$eval('#diagram [data-selection-filter]', filters => filters.length), 0);
    });

    await scenario('brick Entity containers match the legend and restore their own styles without changing nested Components', async () => {
      const entity = 'entity-menu_backdrop';
      const legend = () => page.$$eval('#details [data-guide-node-type="entity"] [data-guide-shape-part]', parts => parts.map(part => ({ fill: getComputedStyle(part).fill, stroke: getComputedStyle(part).stroke })));
      const expected = { fill: 'rgb(248, 241, 239)', stroke: 'rgb(166, 83, 59)' };
      const sample = await legend();
      assert.ok(sample.length > 0); assert.ok(sample.every(style => JSON.stringify(style) === JSON.stringify(expected)));
      await toggle(entity, [entity]);
      const ownStyle = id => page.evaluate(id => {
        const node = [...diagram.querySelectorAll('[data-id]')].find(node => node.dataset.id === id);
        return [...node.querySelectorAll('[data-shape-part]')].filter(part => part.dataset.shapePart === node.dataset.instance).map(part => ({ fill: getComputedStyle(part).fill, stroke: getComputedStyle(part).stroke, filter: getComputedStyle(part).filter,
          priorities: ['fill', 'stroke-width', 'filter'].map(name => part.style.getPropertyPriority(name)), attributes: ['fill', 'stroke-width', 'filter'].map(name => part.getAttribute(name)) }));
      }, id);
      const original = await ownStyle(entity), component = await ownStyle('menu_backdrop.Transform');
      assert.equal(original.length, 1); assert.equal(original[0].fill, expected.fill); assert.equal(original[0].stroke, expected.stroke);
      assert.equal(component[0].fill, 'rgb(241, 245, 242)'); assert.equal(component[0].stroke, 'rgb(75, 128, 96)');
      await page.$eval('#diagram [data-id="entity-menu_backdrop"]', node => node.focus({ preventScroll: true })); await page.keyboard.press('Enter');
      assert.equal((await ownStyle(entity))[0].fill, 'rgb(235, 217, 212)');
      assert.equal((await ownStyle(entity))[0].stroke, expected.stroke);
      assert.deepEqual(await ownStyle('menu_backdrop.Transform'), component);
      assert.equal(await page.$$eval('#diagram [data-selection-filter]', filters => filters.length), 1);
      await page.focus('#clear-selection'); await page.keyboard.press('Space');
      assert.deepEqual(await ownStyle(entity), original);
      assert.deepEqual(await ownStyle('menu_backdrop.Transform'), component);
      assert.equal(await page.$$eval('#diagram [data-selection-filter]', filters => filters.length), 0);
      assert.deepEqual(await legend(), sample);
      await toggle(entity, []);
    });
    assert.deepEqual(requests, [], 'The file viewer must work without HTTP or CDN access');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
