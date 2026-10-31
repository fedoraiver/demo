import path from 'node:path';

function text(node) {
  if (node.type === 'html') return node.value.replace(/<[^>]*>/g, '');
  if (node.type === 'image') return node.alt || '';
  return node.value || (node.children || []).map(text).join('');
}
export function parseDocument(file, source, deps) {
  const links = [], anchors = new Set(), problems = [];
  const html = (value, startLine = 1) => {
    const fragment = deps.html.parseFragment(value, { sourceCodeLocationInfo: true });
    const visit = node => {
      for (const attr of node.attrs || []) {
        if (['id', 'name'].includes(attr.name)) anchors.add(attr.value);
        if (['href', 'src'].includes(attr.name)) links.push({ url: attr.value, line: node.sourceCodeLocation ? node.sourceCodeLocation.startLine + startLine - 1 : startLine, kind: 'html' });
      }
      for (const child of node.childNodes || []) visit(child);
      if (node.content) visit(node.content);
    };
    visit(fragment);
  };
  if (/\.(html?|svg)$/i.test(file)) { html(source); return { links, anchors, problems }; }
  if (!/\.(md|markdown|mdx)$/i.test(file)) return { links, anchors, problems };
  let body = source;
  let lineOffset = 0;
  if (source.startsWith('---\n') || source.startsWith('---\r\n')) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) problems.push({ code: 'frontmatter', message: 'frontmatter 缺少结束分隔符' });
    else {
      try {
        const document = deps.yaml.parseDocument(match[1]);
        if (document.errors.length) throw document.errors[0];
        const data = document.toJS();
        if (path.posix.basename(file) === 'SKILL.md') for (const field of ['name', 'description']) if (typeof data?.[field] !== 'string' || !data[field].trim() || /^(?:TODO|TBD)(?:\s*[:：].*)?$|^<[^>]+>$/i.test(data[field].trim())) problems.push({ code: 'skill_field', message: `Skill ${field} 必须为已填写字符串` });
      } catch (error) { problems.push({ code: 'frontmatter', message: error.message }); }
      body = source.slice(match[0].length);
      lineOffset = match[0].split('\n').length - 1;
    }
  } else if (path.posix.basename(file) === 'SKILL.md') problems.push({ code: 'skill_field', message: 'SKILL.md 缺少 YAML frontmatter' });
  const tree = deps.unified().use(deps.remarkParse).use(deps.remarkGfm).parse(body);
  const definitions = new Map(), slugger = new deps.Slugger();
  const collect = node => {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node.url);
    for (const child of node.children || []) collect(child);
  };
  collect(tree);
  const walk = node => {
    if (node.type === 'heading') anchors.add(slugger.slug(text(node)));
    if (node.type === 'html') html(node.value, (node.position?.start.line || 1) + lineOffset);
    if (node.type === 'link' || node.type === 'image') links.push({ url: node.url, line: (node.position?.start.line || 1) + lineOffset, kind: node.type });
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const url = definitions.get(node.identifier.toUpperCase());
      if (url) links.push({ url, line: (node.position?.start.line || 1) + lineOffset, kind: node.type });
    }
    if (node.type !== 'code' && node.type !== 'inlineCode') for (const child of node.children || []) walk(child);
  };
  walk(tree);
  if (path.posix.basename(file) === 'SKILL.md') {
    const skeleton = node => {
      if (['heading', 'paragraph'].includes(node.type) && /^(?:TODO|TBD)(?:\s*[:：].*)?$|\[insert[^\]]*\]|<your[- ][^>]*>/i.test(text(node).trim())) return true;
      return node.type !== 'code' && (node.children || []).some(skeleton);
    };
    if (skeleton(tree)) problems.push({ code: 'skill_skeleton', message: 'Skill 含未填充骨架标记，需人工确认' });
  }
  return { links, anchors, problems };
}
