import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio } from '../src/studio.js';

const origin = 'https://studio.claude.gg';
const model = 'gpt-image-2.5-sunburst';
const batch = 'batch_123';

test('catalog check precedes exactly one paid POST with the expected schema', async () => {
  const requests = [];
  const events = [];
  const studio = createStudio({ apiKey: 'secret', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url === origin + '/v1/models') { events.push('catalog'); return Response.json({ data: [{ id: model }] }); }
    events.push('post');
    return Response.json({ id: batch });
  } });
  assert.equal(await studio.start('A scene', async () => { events.push('beforePost'); }), batch);
  assert.deepEqual(events, ['catalog', 'beforePost', 'post']);
  for (const r of requests) { assert.equal(r.options.headers.Authorization, 'Bearer secret'); assert.equal(r.options.redirect, 'error'); }
  assert.equal(requests[1].url, origin + '/v1/images/generations');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[1].options.body), { model, prompt: 'A scene', generations_count: 1, wait: false });
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
});

test('missing model or invalid catalog never triggers a paid POST', async () => {
  for (const catalog of [{ data: [{ id: 'other' }] }, { data: null }]) {
    let calls = 0;
    const studio = createStudio({ apiKey: 'secret', fetchImpl: async () => { calls++; return Response.json(catalog); } });
    await assert.rejects(studio.start('prompt'));
    assert.equal(calls, 1);
  }
});

test('a failed paid POST is not retried', async () => {
  let posts = 0;
  const studio = createStudio({ apiKey: 'secret', fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('connection lost'); }
    return Response.json([{ id: model }]);
  } });
  await assert.rejects(studio.start('prompt'));
  assert.equal(posts, 1);
});

test('429 preserves retry-after header or response body', async () => {
  for (const [response, retryAfter] of [[new Response('', { status: 429, headers: { 'Retry-After': '12' } }), 12], [Response.json({ error: { retry_after: 7 } }, { status: 429 }), 7]]) {
    const studio = createStudio({ apiKey: 'secret', fetchImpl: async () => response });
    await assert.rejects(studio.start('prompt'), error => error.status === 429 && error.retryAfter === retryAfter);
  }
});

test('poll reports pending, partial, and failed without downloading', async () => {
  for (const [data, status] of [[[{ status: 'pending' }], 'pending'], [[{ status: 'processing' }, { status: 'failed' }], 'partial'], [[{ status: 'failed' }], 'error']]) {
    let calls = 0;
    const studio = createStudio({ apiKey: 'secret', fetchImpl: async () => { calls++; return Response.json({ data }); } });
    const result = await studio.poll(batch, { saveImage: () => assert.fail('unexpected download') });
    assert.equal(result.status, status);
    assert.equal(result.batchId, batch);
    assert.equal(result.url, null);
    assert.equal(calls, 1);
  }
});

test('completed poll downloads and stores image bytes once', async () => {
  const calls = [];
  const studio = createStudio({ apiKey: 'secret', fetchImpl: async (url) => {
    calls.push(url);
    return calls.length === 1 ? Response.json({ data: [{ status: 'completed', url: '/images/picture.png' }] }) : new Response(Buffer.from('image'), { headers: { 'Content-Type': 'image/png' } });
  } });
  let saved;
  const result = await studio.poll(batch, { saveImage: async (bytes, extension) => { saved = { bytes, extension }; return '/images/local.png'; } });
  assert.deepEqual(saved, { bytes: Buffer.from('image'), extension: 'png' });
  assert.deepEqual(calls, [origin + '/v1/images/' + batch, origin + '/images/picture.png']);
  assert.deepEqual(result, { status: 'completed', batchId: batch, url: '/images/local.png', error: null });
});

test('poll rejects unsafe image URLs before making another request', async () => {
  for (const url of ['https://example.invalid/images/a.png', '//example.invalid/images/a.png', '/images/a.png?token=x', '/images/../secret.png', '/images/a.svg', 'http://127.0.0.1/images/a.png']) {
    let calls = 0;
    const studio = createStudio({ apiKey: 'secret', fetchImpl: async () => { calls++; return Response.json({ data: [{ status: 'completed', url }] }); } });
    await assert.rejects(studio.poll(batch, { saveImage: () => assert.fail('unexpected save') }));
    assert.equal(calls, 1);
  }
});
