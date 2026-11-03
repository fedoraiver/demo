import fs from 'node:fs';
import crypto from 'node:crypto';

function* chunks(filename, chunkBytes) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const bufferBytes = Math.max(1, Math.min(chunkBytes, fs.fstatSync(descriptor).size));
    while (true) {
      const buffer = Buffer.allocUnsafe(bufferBytes), size = fs.readSync(descriptor, buffer);
      if (!size) return;
      yield buffer.subarray(0, size);
    }
  } finally { fs.closeSync(descriptor); }
}

export function hashFile(filename) {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  for (const chunk of chunks(filename, 1024 * 1024)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

// 调用图可能超过 JS 单字符串上限，逐条解析并验证完整文件，不保留全部记录数组。
export function visitNdjson(filename, visit, { chunkBytes = 1024 * 1024 } = {}) {
  const hash = crypto.createHash('sha256'); let bytes = 0, records = 0, pending = [], pendingBytes = 0;
  const record = parts => {
    const text = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('utf8');
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`Invalid compiler call graph JSON at line ${records + 1}`); }
    visit(value, ++records);
  };
  for (const chunk of chunks(filename, chunkBytes)) {
    hash.update(chunk); bytes += chunk.length;
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      pending.push(chunk.subarray(start, end)); record(pending); pending = []; pendingBytes = 0; start = end + 1;
    }
    if (start < chunk.length) { pending.push(chunk.subarray(start)); pendingBytes += chunk.length - start; }
  }
  if (pendingBytes) record(pending);
  return { sha256: hash.digest('hex'), bytes, records };
}
