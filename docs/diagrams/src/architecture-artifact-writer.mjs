import fs from 'node:fs';
import { hashFile } from './stream-files.mjs';

const retryDelays = [20, 40, 80, 160, 320];
const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

// Windows 短暂占用时最多等待 620ms；始终保留旧目标和完整暂存文件，只重试原子替换。
export function replaceArtifactSync(staged, target, { platform = process.platform, rename = fs.renameSync,
  wait = milliseconds => Atomics.wait(waitBuffer, 0, 0, milliseconds) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { rename(staged, target); return; }
    catch (error) {
      if (platform !== 'win32' || !retryableCodes.has(error.code) || attempt === retryDelays.length) throw error;
      wait(retryDelays[attempt]);
    }
  }
}

export function copyVerifiedArtifactSync(source, staged, target, expectedSha256, options) {
  let existingSha256;
  try { existingSha256 = hashFile(target).sha256; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existingSha256 === expectedSha256) {
    // 相同目标无需替换，但目标正确不能掩盖编译器输入已经改变。
    if (hashFile(source).sha256 !== expectedSha256) throw new Error('Compiler call graph changed during artifact copy');
    return;
  }
  fs.copyFileSync(source, staged);
  if (hashFile(staged).sha256 !== expectedSha256) throw new Error('Compiler call graph changed during artifact copy');
  replaceArtifactSync(staged, target, options);
}
