import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const directory = fileURLToPath(new URL('.', import.meta.url));

function dependencyLicenseNotices(inputs) {
  const packages = new Set();
  for (const input of inputs) {
    const parts = path.resolve(directory, input).split(path.sep), index = parts.lastIndexOf('node_modules');
    if (index < 0) continue;
    packages.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join(path.sep));
  }
  const notices = [...packages].sort().map(directory => {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const files = fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice)(?:\.[^.]+)?$/i.test(name));
    return `${metadata.name}@${metadata.version}\n${files.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n') || metadata.license}`;
  });
  return `/*! Offline architecture runtime dependency licenses\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/\n`;
}

export async function buildArchitectureRuntimeAssets() {
  const result = await build({
    absWorkingDir: directory,
    entryPoints: [fileURLToPath(new URL('./architecture-runtime.mjs', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    legalComments: 'inline',
    metafile: true,
    logLevel: 'silent',
  });
  // Live Server also scans closing document tags inside JavaScript strings when injecting its reload script.
  return (dependencyLicenseNotices(Object.keys(result.metafile.inputs)) + result.outputFiles[0].text).replace(/<\/(script|body|head|html)(?=[\s>])/gi, '<\\/$1');
}
