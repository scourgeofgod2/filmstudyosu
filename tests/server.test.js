import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createStorage } from '../src/storage.js';
import { createStudio } from '../src/studio.js';

async function fixture(t, fetchImpl) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'film-server-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createStorage(root);
  await storage.save({ id: 'project1', title: 'Film', idea: 'Idea', preferences: {}, script: '', updatedAt: '2025-01-01T00:00:00.000Z', scenes: [{ id: 'scene1', title: 'Scene', description: '', imagePrompt: 'Prompt', videoPrompt: '', image: { status: 'idle', batchId: null, url: null, error: null } }] });
  const studio = createStudio({ apiKey: 'test-key', fetchImpl });
  const server = createServer({ storage, studio, generate: async () => { throw new Error('unexpected generation'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = server.address().port;
  const call = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: url, method, headers: { 'X-Local-Request': '1' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end();
  });
  return { storage, call };
}

test('server persists pending and refuses duplicate paid requests', async t => {
  let posts = 0;
  const { storage, call } = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { posts++; return Response.json({ id: 'batch1' }); }
    return Response.json({ data: [{ id: 'gpt-image-2.5-sunburst' }] });
  });
  const route = '/api/projects/project1/scenes/scene1/image';
  const first = await call(route, 'POST');
  assert.equal(first.status, 200);
  assert.equal(first.body.scenes[0].image.status, 'pending');
  assert.equal((await storage.get('project1')).scenes[0].image.batchId, 'batch1');
  assert.equal((await call(route, 'POST')).status, 409);
  assert.equal(posts, 1);
});

test('ambiguous paid request remains starting and cannot be resent', async t => {
  let posts = 0;
  const { storage, call } = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('connection lost'); }
    return Response.json({ data: [{ id: 'gpt-image-2.5-sunburst' }] });
  });
  const route = '/api/projects/project1/scenes/scene1/image';
  assert.equal((await call(route, 'POST')).status, 502);
  assert.equal((await storage.get('project1')).scenes[0].image.status, 'starting');
  assert.equal((await call(route, 'POST')).status, 409);
  assert.equal(posts, 1);
});

test('server forwards rate limit and retry-after without leaking credentials', async t => {
  const { call } = await fixture(t, async () => new Response('', { status: 429, headers: { 'Retry-After': '8' } }));
  const result = await call('/api/projects/project1/scenes/scene1/image', 'POST');
  assert.equal(result.status, 429);
  assert.equal(result.headers['retry-after'], '8');
  assert.equal(result.body.retryAfter, 8);
  assert.ok(!JSON.stringify(result.body).includes('test-key'));
});
