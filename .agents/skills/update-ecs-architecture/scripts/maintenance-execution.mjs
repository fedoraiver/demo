import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { digest } from './maintenance-inputs.mjs';

export function atomicJson(filename, value) {
  const staged = `${filename}.${process.pid}.new`;
  fs.writeFileSync(staged, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(staged, filename);
}

/** 子进程只接收独立 argv；Windows 也不通过 shell 拼接用户路径。 */
export async function executeMaintenanceCommand({ spec, cwd, directory, record, save }) {
  record.command = spec.command;
  record.args = [...(spec.args || [])];
  record.cwd = cwd;
  record.stdout = path.join(directory, `${record.id}-${record.attempt}.stdout.log`);
  record.stderr = path.join(directory, `${record.id}-${record.attempt}.stderr.log`);
  const stdout = fs.openSync(record.stdout, 'w'), stderr = fs.openSync(record.stderr, 'w');
  record.startedAt = new Date().toISOString();
  record.queueWaitMs = Date.parse(record.startedAt) - Date.parse(record.requestedAt);
  record.status = 'running';
  save();
  try {
    const result = await new Promise(resolve => {
      let child;
      try { child = spawn(spec.command, spec.args || [], { cwd, env: spec.env ? { ...process.env, ...spec.env } : process.env,
        stdio: ['ignore', stdout, stderr], windowsHide: true, shell: false }); }
      catch (error) { resolve({ code: null, signal: null, error: error.message }); return; }
      record.pid = child.pid ?? null;
      save();
      child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    record.exitCode = result.code;
    record.signal = result.signal;
    if (result.error) record.error = result.error;
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
    record.status = result.code === 0 && !result.signal && !result.error ? 'passed' : result.signal ? 'interrupted' : 'failed';
    record.logHashes = Object.fromEntries([record.stdout, record.stderr].map(filename => [filename, digest(fs.readFileSync(filename))]));
    save();
    return record.status === 'passed';
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
}
