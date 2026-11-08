import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './maintenance-paths.mjs';

const help = `ECS architecture maintenance
  plan | preflight | run [--resume RUN_ID] | status | report
  pack-pages [--out PATH] | check-pages [--directory PATH]
  verify-pages --url URL --expected PATH [--commit SHA --evidence PATH]
  visual plan | render | record | bind | report

Common: --workspace PATH
Preflight/run: --debugdump PATH
Status/report: --run-id RUN_ID
Report: --format json|markdown
Visual: --index PATH --plan PATH
Visual plan: --batch NAME --outdir PATH [--sample N --seed SEED --scope TEXT]
             [--force-object ID] [--force-view ID]
Visual render: [--from N --to N --browser PATH]
Visual record: --input OBSERVATIONS_JSON
Visual bind: --commit COMMIT
`;

const commands = new Set(['plan', 'preflight', 'run', 'status', 'report', 'pack-pages', 'check-pages', 'verify-pages']);
const visualCommands = new Set(['plan', 'render', 'record', 'bind', 'report']);
const allowed = {
  'pack-pages': ['workspace', 'out'], 'check-pages': ['workspace', 'directory'],
  'verify-pages': ['workspace', 'url', 'expected', 'commit', 'evidence'],
  plan: ['workspace'], preflight: ['workspace', 'debugdump'], run: ['workspace', 'debugdump', 'resume'],
  status: ['workspace', 'run-id'], report: ['workspace', 'run-id', 'format'],
  'visual plan': ['workspace', 'index', 'batch', 'outdir', 'sample', 'seed', 'scope', 'force-object', 'force-view'],
  'visual render': ['workspace', 'plan', 'from', 'to', 'browser'],
  'visual record': ['workspace', 'plan', 'input', 'index'],
  'visual bind': ['workspace', 'index', 'commit'],
  'visual report': ['workspace', 'index', 'plan'],
};

/** 命令参数按角色限制；修正目录和记录观察都需要独立的显式命令。 */
export function parseMaintenanceArgs(argv, defaultWorkspace = repositoryRoot) {
  if (!argv.length) return { command: 'help', options: {} };
  if (['help', '--help'].includes(argv[0])) {
    if (argv.length !== 1) throw new Error('Unexpected arguments after help');
    return { command: 'help', options: {} };
  }
  const args = [...argv];
  let command = args.shift();
  if (command === 'visual') {
    const action = args.shift();
    if (!visualCommands.has(action)) throw new Error('Unknown visual command');
    command += ' ' + action;
  } else if (!commands.has(command)) throw new Error('Unknown maintenance command: ' + command);
  const values = {};
  let wantsHelp = false;
  while (args.length) {
    const argument = args.shift();
    if (argument === '--help') { wantsHelp = true; continue; }
    if (!argument.startsWith('--') || !allowed[command].includes(argument.slice(2))) throw new Error('Unsupported option: ' + argument);
    const key = argument.slice(2);
    if (key === 'apply') {
      if (values.apply) throw new Error('Repeated option: --apply');
      values.apply = true;
      continue;
    }
    const value = args.shift();
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error('Missing value: ' + argument);
    if (key === 'force-object' || key === 'force-view') (values[key] ??= []).push(value);
    else {
      if (Object.hasOwn(values, key)) throw new Error('Repeated option: ' + argument);
      values[key] = value;
    }
  }
  for (const key of ['sample', 'from', 'to']) if (values[key] !== undefined) {
    if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1) throw new Error('Invalid count: --' + key);
    values[key] = Number(values[key]);
  }
  if (wantsHelp) return { command: 'help', options: {} };
  if (values.from && values.to && values.from > values.to) throw new Error('--from exceeds --to');
  if (values.sample !== undefined && (!values.seed || !values.scope)) throw new Error('Sampling requires explicit --seed and --scope');
  if (values.sample === undefined && (values.seed || values.scope)) throw new Error('--seed and --scope require explicit --sample');
  if (values.format && !['json', 'markdown'].includes(values.format)) throw new Error('Invalid report format');
  if (['visual render', 'visual record'].includes(command) && !values.plan) throw new Error('--plan is required');
  if (command === 'visual record' && !values.input) throw new Error('--input is required');
  if (command === 'visual bind' && !values.commit) throw new Error('--commit is required');
  if (command === 'verify-pages' && (!values.url || !values.expected)) throw new Error('verify-pages requires --url and --expected');
  const names = { expected: 'expectedFile', evidence: 'evidenceDirectory', ...(command === 'verify-pages' ? { commit: 'expectedCommit' } : {}),
    out: 'outdir', debugdump: 'debugdumpDirectory', 'run-id': 'runId', index: 'indexPath', plan: 'planPath', input: 'observationFile',
    'force-object': 'forcedObjectIds', 'force-view': 'forcedViewIds' };
  const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [names[key] || key, value]));
  options.workspace = path.resolve(values.workspace || defaultWorkspace);
  for (const key of ['debugdumpDirectory', 'indexPath', 'outdir', 'planPath', 'observationFile', 'browser', 'directory', 'expectedFile', 'evidenceDirectory']) {
    if (options[key]) options[key] = path.resolve(options.workspace, options[key]);
  }
  return { command, options };
}

export async function dispatchMaintenance({ command, options }) {
  if (command === 'help') return help;
  if (command === 'preflight') return (await import('./maintenance-preflight.mjs')).preflightArchitecture(options);
  if (command.startsWith('visual ')) {
    const module = await import('./maintenance-visual.mjs');
    const name = { plan: 'planVisual', render: 'renderVisual', record: 'recordVisual', bind: 'bindVisual', report: 'visualReport' }[command.split(' ')[1]];
    return module[name](options);
  }
  if (command === 'pack-pages' || command === 'check-pages') {
    const module = await import('./pages-package.mjs');
    return module[command === 'pack-pages' ? 'packPages' : 'checkPages'](options);
  }
  if (command === 'verify-pages') return (await import('./maintenance-deployment.mjs')).verifyDeployedPages(options);
  const runner = await import('./maintenance-runner.mjs');
  const name = { plan: 'planMaintenance', run: 'runMaintenance', status: 'maintenanceStatus', report: 'maintenanceReport' }[command];
  const result = await runner[name](options);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await dispatchMaintenance(parseMaintenanceArgs(argv));
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  if (result && typeof result === 'object' && ['failed', 'interrupted'].includes(result.automatic?.status ?? result.status)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
