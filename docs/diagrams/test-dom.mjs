// 只模拟离线页面脚本实际使用的 DOM 契约；不提供浏览器渲染、布局或协议启动能力。
import assert from 'node:assert/strict';

const dataKey = attribute => attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const decode = value => value.replace(/&(amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi, (_, entity) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[entity]
  ?? String.fromCodePoint(entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))));

function inlineStyle(element) {
  const values = new Map();
  const update = () => element.attributes.set('style', [...values].map(([name, item]) => `${name}: ${item.value}${item.priority ? ' !important' : ''};`).join(' '));
  const api = {
    getPropertyValue: name => values.get(name)?.value ?? '',
    getPropertyPriority: name => values.get(name)?.priority ?? '',
    setProperty(name, value, priority = '') {
      if (value === '' || value === null) { this.removeProperty(name); return; }
      if (priority && priority.toLowerCase() !== 'important') return;
      values.set(name, { value: String(value), priority: priority.toLowerCase() }); update();
    },
    removeProperty(name) { const value = values.get(name)?.value ?? ''; values.delete(name); update(); return value; },
    read(text) {
      values.clear();
      for (const declaration of text.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const name = declaration.slice(0, colon).trim(), raw = declaration.slice(colon + 1).trim();
        const important = /\s*!important\s*$/i.test(raw);
        if (name && (!values.has(name) || important || values.get(name).priority !== 'important')) values.set(name, { value: raw.replace(/\s*!important\s*$/i, '').trim(), priority: important ? 'important' : '' });
      }
    },
  };
  return new Proxy(api, {
    get(target, name) { return name in target ? target[name] : values.get(name)?.value ?? ''; },
    set(target, name, value) { target.setProperty(name, value); return true; },
  });
}

export class Element {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = inlineStyle(this);
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.value = '';
    this.scrollTop = 0;
    this.clientHeight = 200;
    this.clientWidth = 1000;
    this.offsetHeight = 24;
    if (tagName === '#document') this.ownerDocument = this;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : !!force;
        this.classList[enabled ? 'add' : 'remove'](name);
        return enabled;
      },
    };
  }

  get offsetTop() { return (this.parentElement?.children.indexOf(this) ?? 0) * this.offsetHeight; }
  get href() { return this.getAttribute('href') ?? ''; }
  set href(value) { this.setAttribute('href', value); }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get innerHTML() { return this.markup ?? ''; }
  set innerHTML(value) { this.replaceChildren(); this.markup = value; parseMarkup(value, this); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value);
    else if (name === 'id') this.id = String(value);
    else if (name === 'class') this.className = String(value);
    else if (name === 'hidden') this.hidden = true;
    else if (name === 'disabled') this.disabled = true;
    else if (name === 'value') this.value = String(value);
    else if (name === 'style') this.style.read(String(value));
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
    if (name === 'hidden') return this.hidden ? '' : null;
    if (name === 'disabled') return this.disabled ? '' : null;
    if (name === 'id') return this.id ?? null;
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'hidden') this.hidden = false;
    else if (name === 'disabled') this.disabled = false;
    else if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
    else if (name === 'style') this.style.read('');
  }
  append(...elements) {
    for (const element of elements) {
      if (element.tagName === '#fragment') this.append(...[...element.children]);
      else {
        element.remove();
        element.parentElement = this;
        const adopt = child => { child.ownerDocument = this.ownerDocument; child.children.forEach(adopt); };
        adopt(element);
        this.children.push(element);
      }
    }
  }
  appendChild(element) { this.append(element); return element; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceChildren(...elements) {
    this.children.forEach(child => { child.parentElement = null; });
    this.children = [];
    this.text = '';
    this.append(...elements);
  }
  insertAdjacentElement(position, element) {
    assert.equal(position, 'afterend');
    const siblings = this.parentElement.children;
    element.parentElement = this.parentElement;
    element.ownerDocument = this.ownerDocument;
    siblings.splice(siblings.indexOf(this) + 1, 0, element);
  }
  matches(selector) {
    const compound = /^(?:([A-Za-z][\w-]*|\*))?((?:[.#][\w-]+)*)(.*)$/.exec(selector);
    assert.ok(compound, 'Unsupported test DOM selector: ' + selector);
    const [, tag, identifiers, rest] = compound;
    if (tag && tag !== '*' && this.tagName !== tag.toLowerCase()) return false;
    for (const token of identifiers.match(/[.#][\w-]+/g) ?? []) {
      if (token[0] === '#' ? this.id !== token.slice(1) : !this.classList.contains(token.slice(1))) return false;
    }
    const attributes = [...rest.matchAll(/\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)];
    assert.equal(attributes.map(match => match[0]).join(''), rest, 'Unsupported test DOM selector: ' + selector);
    return attributes.every(([, name, double, single, plain]) => {
      const value = double ?? single ?? plain;
      return value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const matches = node => {
      if (!node.matches(parts.at(-1))) return false;
      let ancestor = node.parentElement;
      for (let index = parts.length - 2; index >= 0; index--) {
        while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    };
    const walk = node => node.children.flatMap(child => [...(matches(child) ? [child] : []), ...walk(child)]);
    return walk(this);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name, event = {}) {
    const value = { target: this, defaultPrevented: false, ...event };
    value.preventDefault ??= () => { value.defaultPrevented = true; };
    value.stopPropagation ??= () => { value.propagationStopped = true; };
    let current = this;
    while (current) {
      value.currentTarget = current;
      current['on' + name]?.(value);
      for (const callback of current.listeners.get(name) ?? []) callback(value);
      if (event.bubbles === false || value.propagationStopped) break;
      current = current.parentElement;
    }
    return value;
  }
  click() {
    if (this.disabled) return;
    this.ownerDocument?.clickedElements?.push(this);
    this.dispatch('click');
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  select() { this.selection = [0, this.value.length]; }
  getBoundingClientRect() { return { left: 0, top: 0, x: 0, y: 0, width: this.clientWidth, height: this.clientHeight }; }
  // 仅供交互滤镜计算使用的可覆盖 fixture，不代表浏览器测得的 SVG 几何。
  getBBox() { return this.bbox ?? { x: 0, y: 0, width: 180, height: 80 }; }
  setPointerCapture(id) { (this.capturedPointers ??= new Set()).add(id); }
  hasPointerCapture(id) { return this.capturedPointers?.has(id) ?? false; }
  releasePointerCapture(id) { this.capturedPointers?.delete(id); }
}

export function parseMarkup(markup, parent) {
  const stack = [parent];
  for (const token of markup.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1).text = (stack.at(-1).text ?? '') + decode(token); continue; }
    const [, tagName, attributes] = /^<([\w:-]+)\b([\s\S]*?)\/?\s*>$/.exec(token) ?? [];
    assert.ok(tagName, 'Unsupported test DOM markup: ' + token);
    const element = new Element(tagName);
    for (const attribute of attributes.matchAll(/([\w:-]+)(?:="([^"]*)"|'([^']*)')?/g)) element.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? ''));
    stack.at(-1).append(element);
    if (!['meta', 'input', 'br', 'link', 'hr'].includes(element.tagName) && !token.endsWith('/>')) stack.push(element);
  }
}

export function scriptsIn(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(([, attributes, script]) => ({ attributes, script }));
}

export function testDocument(html) {
  const document = new Element('#document');
  document.clickedElements = [];
  parseMarkup(html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, '$1</style>'), document);
  document.createElement = name => { const element = new Element(name); element.ownerDocument = document; return element; };
  document.createElementNS = (_, name) => document.createElement(name);
  document.createDocumentFragment = () => document.createElement('#fragment');
  document.getElementById = id => document.querySelector('#' + id);
  return document;
}
