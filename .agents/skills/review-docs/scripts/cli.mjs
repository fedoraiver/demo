import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencies, defaultWorkspace } from './dependencies.mjs';
import { identity, fail } from './workspace.mjs';
import { init, withLock, append } from './session.mjs';
import { check } from './check.mjs';
import { record } from './records.mjs';
import { report } from './report.mjs';

export async function main(argv) {
  const [command, ...args] = argv;
  if (!['init', 'check', 'record', 'report'].includes(command)) fail('命令必须为 init/check/record/report');
  const opts = { scope: [] };
  const allowed = { init: ['workspace', 'scope', 'base'], check: ['workspace', 'session', 'record'], record: ['workspace', 'session', 'input'], report: ['workspace', 'session', 'require-complete'] }[command];
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(key)) fail(`未知参数: ${args[i]}`);
    if (['record', 'require-complete'].includes(key)) { if (opts[key]) fail(`参数重复: ${key}`); opts[key] = true; }
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`参数缺值: --${key}`);
      if (key === 'scope') opts.scope.push(value);
      else { if (opts[key]) fail(`参数重复: ${key}`); opts[key] = value; }
    }
  }
  const root = identity(path.resolve(opts.workspace || defaultWorkspace)).root;
  const deps = await dependencies();
  if (command === 'init') return { code: 0, output: { schemaVersion: 1, command, ...init(root, opts.scope, opts.base) } };
  return withLock(root, opts.session, async session => {
    const common = { schemaVersion: 1, command, session: session.baseline.id, sessionPath: session.directory };
    if (command === 'check') {
      const result = await check(root, session.baseline, deps);
      const event = opts.record ? append(session, { schemaVersion: 1, type: 'mechanical', actor: 'deterministic-checker', result }) : null;
      return { code: result.status === 'pass' ? 0 : 1, output: { ...common, ...result, recorded: Boolean(event), eventId: event?.id } };
    }
    if (command === 'record') {
      if (!opts.input) fail('--input JSON 文件必填');
      const input = JSON.parse(fs.readFileSync(path.resolve(opts.input), 'utf8').replace(/^\uFEFF/, ''));
      const event = record(root, session, input);
      return { code: 0, output: { ...common, event } };
    }
    const result = report(root, session);
    return { code: opts['require-complete'] && !result.complete ? 1 : 0, output: { ...common, ...result } };
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result.output) + '\n');
    process.stderr.write(`review-docs ${result.output.command}: ${result.output.status || (result.output.complete === undefined ? 'ok' : result.output.complete ? 'complete' : 'incomplete')}\n`);
    process.exitCode = result.code;
  } catch (error) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, error: error.message }) + '\n');
    process.stderr.write(`review-docs: ${error.message}\n`);
    process.exitCode = 2;
  }
}
