// 只格式化已有名称的显示文本；类别、身份和完整名称仍由原模型提供。
const identifier = String.raw`(?:r#)?[\p{ID_Start}_][\p{ID_Continue}_]*`;
const pathsAndStrings = new RegExp(String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|${identifier}(?:::${identifier})+`, 'gu');
const callableKinds = new Set(['system', 'observer', 'registration helper', 'registration_helper', 'synchronization', 'sync']);
const roleKinds = new Set(['entity', 'local']);
const closureSuffix = /(?:^|::)\{\{?closure(?:[#:$][^{}]*)?\}?\}$/;

function rustDisplayText(value) {
  // 自然语言职责名可以包含路径引用；不把整段说明误当成 Rust 名称。
  const unquoted = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'/g, '').replace(/'[\p{ID_Start}_][\p{ID_Continue}_]*/gu, '');
  if (/[，。；：（）！？、↗·]/u.test(unquoted)) return false;
  const words = [...unquoted.matchAll(/(?<![\p{ID_Continue}_])(?=([\p{ID_Continue}_]+)\s+([\p{ID_Start}_][\p{ID_Continue}_]*))/gu)];
  const keywords = new Set(['as', 'mut', 'const', 'dyn', 'impl', 'fn', 'unsafe', 'extern', 'for']);
  return words.every(([, before, after]) => keywords.has(before) || keywords.has(after));
}

export function shortArchitecturePaths(value) {
  return String(value).replace(pathsAndStrings, token => token.startsWith('"') || token.startsWith("'") ? token : token.slice(token.lastIndexOf('::') + 2));
}

function callableName(value) {
  // 仅按已有显示字符串的定界符找末尾路径段，不解析源码或寻找声明。
  const segments = [], stack = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if ('<([{'.includes(char)) stack.push(char);
    else if (char === ({ '<': '>', '(': ')', '[': ']', '{': '}' })[stack.at(-1)] && value[index - 1] !== '-') stack.pop();
    else if (!stack.length && value.slice(index, index + 2) === '::') {
      segments.push(value.slice(start, index)); start = index + 2; index++;
    }
  }
  segments.push(value.slice(start));
  while (segments.at(-1)?.startsWith('<')) segments.pop();
  const closures = [];
  while (/^\{\{?closure(?:[#:$][^{}]*)?\}?\}$/.test(segments.at(-1) || '')) closures.unshift(segments.pop());
  const last = segments.at(-1) || value;
  const name = new RegExp(`^(${identifier})(?:<[\\s\\S]*>)?$`, 'u').exec(last)?.[1];
  return name ? [name, ...closures].join('::') : shortArchitecturePaths(value);
}

export function architectureDisplayName(value, { kind = '' } = {}) {
  const name = String(value ?? ''), category = kind.toLowerCase();
  if (roleKinds.has(category) || !rustDisplayText(name)) return name;
  if (name.startsWith('SystemTypeSet:')) return 'SystemTypeSet:' + callableName(name.slice('SystemTypeSet:'.length));
  if (callableKinds.has(category) || closureSuffix.test(name)) return callableName(name);
  return shortArchitecturePaths(name);
}
