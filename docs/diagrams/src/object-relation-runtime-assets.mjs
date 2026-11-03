import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));
let assets;

function dependencyNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    let folder = path.dirname(path.resolve(directory, input));
    while (folder.includes(`${path.sep}node_modules${path.sep}`)) {
      const filename = path.join(folder, 'package.json');
      if (fs.existsSync(filename)) {
        const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!metadata.name) { folder = path.dirname(folder); continue; }
        const licenses = fs.readdirSync(folder).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name) && fs.statSync(path.join(folder, name)).isFile());
        packages.set(metadata.name + '@' + metadata.version, metadata.name + ' ' + metadata.version + '\nSource: ' + (metadata.repository?.url || metadata.repository || metadata.homepage || '')
          + '\nLicense: ' + JSON.stringify(metadata.license || '') + '\n' + licenses.map(name => fs.readFileSync(path.join(folder, name), 'utf8')).join('\n'));
        break;
      }
      folder = path.dirname(folder);
    }
  }
  return [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([, notice]) => notice).join('\n\n');
}

/** 将 Mermaid 与对象关系呈现打入一个本地模块；浏览器首次选择关系时才加载。 */
export function objectRelationRuntimeAssets() {
  return assets ??= (async () => {
    const result = await build({ absWorkingDir: directory, entryPoints: [path.join(directory, 'object-relation-runtime-browser.mjs')], bundle: true, write: false,
      format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline', splitting: false, metafile: true });
    if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length)) throw new Error('Object relation runtime must be one self-contained module');
    const notices = dependencyNotices(result.metafile.inputs);
    return { module: 'void ' + JSON.stringify(notices) + ';\n' + result.outputFiles[0].text };
  })().catch(error => { assets = undefined; throw error; });
}
