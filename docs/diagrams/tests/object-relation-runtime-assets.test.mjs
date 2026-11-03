import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import { objectRelationRuntimeAssets } from '../src/object-relation-runtime-assets.mjs';
import { repositoryRoot, pathsForRepository } from '../src/paths.mjs';
import { createArchitectureServer } from '../src/serve.mjs';
import { readArchitectureResource } from '../src/architecture-asset-loader.mjs';

test('object relation runtime is a cached self-contained browser module with dependency license notices', async () => {
  const first = objectRelationRuntimeAssets();
  assert.equal(objectRelationRuntimeAssets(), first);
  const assets = await first;
  assert.equal(typeof assets.module, 'string');
  assert.ok(assets.module.length > 1000);
  assert.match(assets.module, /createObjectRelationRenderer/);
  assert.match(assets.module, /mermaid 12\.2\.0/);
  assert.match(assets.module, /Kn[u]+t Sveidqvist/);
  assert.match(assets.module, /Permission is hereby granted/);
  assert.equal(await objectRelationRuntimeAssets(), assets);
});

test('the standalone runtime survives directory distribution and verified local HTTP transport without dependency files', async () => {
  const parent = path.join(repositoryRoot, 'tmp/ecs-architecture/object-runtime-tests'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'distributed-')), paths = pathsForRepository(root), { module } = await objectRelationRuntimeAssets();
  fs.mkdirSync(paths.pagesDirectory, { recursive: true }); fs.mkdirSync(path.join(paths.generatedDirectory, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(paths.pagesDirectory, 'ecs-architecture.html'), '<!doctype html><title>isolated transport fixture</title>');
  const filename = path.join(paths.generatedDirectory, 'runtime/object-relations.mjs'); fs.writeFileSync(filename, module);
  const runtime = await import(pathToFileURL(filename).href);
  assert.equal(typeof runtime.createObjectRelationRenderer, 'function');
  const server = await createArchitectureServer({ repository: root, port: 0 });
  try {
    const resource = { url: '../runtime/object-relations.mjs', bytes: Buffer.byteLength(module), sha256: createHash('sha256').update(module).digest('hex') };
    assert.equal(await readArchitectureResource(resource, { baseUrl: server.url, crypto: webcrypto }), module);
    const response = await fetch(new URL(resource.url, server.url), { method: 'HEAD' });
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal(Number(response.headers.get('content-length')), resource.bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['object-relations.mjs']);
  } finally { await server.close(); }
});
