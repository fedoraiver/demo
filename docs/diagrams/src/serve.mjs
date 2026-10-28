import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { pathsForRepository, repositoryRoot } from './paths.mjs';

const buildMessage = '架构图页面尚未生成，请先运行 npm run build --prefix docs/diagrams。';
const usage = 'Usage: node docs/diagrams/serve.mjs [--port <0-65535>]';
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8', '.dot': 'text/plain; charset=utf-8' };
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const failureStatus = error => error.status || (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404
  : ['EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? 403 : 500);

function route(requestTarget) {
  if (typeof requestTarget !== 'string' || !requestTarget.startsWith('/') || requestTarget.startsWith('//') || requestTarget.includes('#')) throw new HttpError(400, 'Invalid request target');
  const queryIndex = requestTarget.indexOf('?');
  const rawPath = queryIndex < 0 ? requestTarget : requestTarget.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : requestTarget.slice(queryIndex);
  let pathname;
  try { pathname = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'Invalid URL encoding'); }
  // 在 URL 标准化之前检查原始路径，避免 ../ 或编码分隔符被悄悄折叠。
  if (/[\\\0:]/.test(pathname) || pathname.startsWith('//') || pathname.split('/').some(part => part === '.' || part === '..')) throw new HttpError(403, 'Forbidden path');
  let redirect;
  if (pathname === '/') redirect = '/pages/ecs-architecture.html';
  else if (pathname === '/ecs-architecture.html' || pathname === '/ecs-source.html') redirect = '/pages' + pathname;
  else if (pathname === '/debugdump-manifest.json') redirect = '/data/manifest.json';
  else if (/^\/ecs-object-[^/]+\.svg$/.test(pathname)) redirect = '/svg/object' + pathname;
  else if (/^\/ecs-schedule-[^/]+\.svg$/.test(pathname)) redirect = '/svg/schedule' + pathname;
  else if (/^\/ecs-object-[^/]+\.mmd$/.test(pathname)) redirect = '/mermaid' + pathname;
  else if (/^\/ecs-schedule-[^/]+\.dot$/.test(pathname)) redirect = '/dot' + pathname;
  const target = redirect || pathname;
  if (target.endsWith('/')) throw new HttpError(404, 'Not found');
  return { relative: target.slice(1), redirect: redirect ? redirect.split('/').map(encodeURIComponent).join('/') + query : null };
}

async function openArtifact(repository, generatedDirectory, relative) {
  const target = path.resolve(generatedDirectory, relative);
  if (!within(generatedDirectory, target)) throw new HttpError(403, 'Forbidden path');
  let cursor = repository, stat;
  for (const part of path.relative(repository, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    stat = await fs.promises.lstat(cursor);
    if (stat.isSymbolicLink()) throw new HttpError(403, 'Symbolic links are not served');
  }
  if (!stat?.isFile()) throw new HttpError(404, 'Not found');
  if (!within(generatedDirectory, await fs.promises.realpath(target))) throw new HttpError(403, 'Forbidden path');
  const file = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    stat = await file.stat();
    if (!stat.isFile()) throw new HttpError(404, 'Not found');
    return { file, stat };
  } catch (error) { await file.close(); throw error; }
}

/** 只读提供 generated 产物；调用方负责关闭返回的服务。 */
export async function createArchitectureServer({ repository = repositoryRoot, port = 4173, host = '127.0.0.1' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port: expected an integer from 0 to 65535');
  const root = await fs.promises.realpath(path.resolve(repository));
  const { generatedDirectory } = pathsForRepository(root);
  try { const { file } = await openArtifact(root, generatedDirectory, 'pages/ecs-architecture.html'); await file.close(); }
  catch (error) { if (failureStatus(error) === 404) throw new Error(buildMessage); throw error; }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const text = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') { text(405, 'Method not allowed', { Allow: 'GET, HEAD' }); return; }
    try {
      const { relative, redirect } = route(request.url);
      const { file, stat } = await openArtifact(root, generatedDirectory, relative);
      if (redirect) { await file.close(); text(302, '', { Location: redirect }); return; }
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(relative).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
      if (request.method === 'HEAD') { await file.close(); response.end(); }
      else await pipeline(file.createReadStream(), response);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = failureStatus(error);
      text(status, status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : status === 400 ? 'Bad request' : 'Architecture preview failed');
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port }, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw Object.assign(new Error(`架构图预览端口 ${port} 已被占用，请使用 --port 指定其他端口。`, { cause: error }), { code: error.code });
    throw error;
  }
  const address = server.address(), hostname = address.address.includes(':') ? '[' + address.address + ']' : address.address;
  const url = new URL(`http://${hostname}:${address.port}/pages/ecs-architecture.html`);
  url.searchParams.set('workspace', root.replaceAll('\\', '/'));
  let closing;
  const close = () => closing ??= new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
  return { server, url: url.href, close };
}

export async function runServeCli(args = process.argv.slice(2), { repository = repositoryRoot, output = console.log } = {}) {
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error(usage);
  const port = args.length ? Number(args[1]) : 4173;
  if (!Number.isInteger(port) || port > 65535) throw new Error(usage);
  const preview = await createArchitectureServer({ repository, port });
  output(preview.url);
  return preview;
}
