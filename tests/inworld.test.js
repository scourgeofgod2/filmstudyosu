import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScript, parseGenerated } from '../src/inworld.js';

const scene = { title: 'Scene', description: 'Description', imagePrompt: 'Image', videoPrompt: 'Video' };
const project = { title: 'Film', idea: 'Idea', preferences: { mood: 'drama' } };

test('Inworld sends Basic credentials and validates generated scenes', async () => {
  let request;
  const result = await generateScript(project, { apiKey: 'encoded-key', model: 'test-model', fetchImpl: async (url, options) => {
    request = { url, options };
    const content = String.fromCharCode(96).repeat(3) + 'json\n' + JSON.stringify({ script: 'Script', scenes: [scene] }) + '\n' + String.fromCharCode(96).repeat(3);
    return Response.json({ choices: [{ message: { content } }] });
  } });
  assert.equal(request.url, 'https://api.inworld.ai/v1/chat/completions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Basic encoded-key');
  assert.equal(request.options.redirect, 'error');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'test-model');
  assert.deepEqual(JSON.parse(body.messages.find(m => m.role === 'user').content), project);
  assert.equal(result.script, 'Script');
  assert.ok(result.scenes[0].id);
  assert.deepEqual({ ...result.scenes[0], id: 'id' }, { ...scene, id: 'id', image: { status: 'idle', batchId: null, url: null, error: null } });
});

test('Inworld rejects a missing key without making a request', async () => {
  let calls = 0;
  await assert.rejects(generateScript(project, { apiKey: '', fetchImpl: async () => { calls++; } }), /INWORLD_API_KEY/);
  assert.equal(calls, 0);
});

test('Inworld rejects malformed response envelopes and generated content', async () => {
  for (const body of [{}, { choices: [{ message: { content: 1 } }] }, { choices: [{ message: { content: 'not json' } }] }, { choices: [{ message: { content: JSON.stringify({ script: 'ok', scenes: [{ ...scene, videoPrompt: '' }] }) } }] }]) {
    await assert.rejects(generateScript(project, { apiKey: 'key', fetchImpl: async () => Response.json(body) }));
  }
  for (const value of [{ script: '', scenes: [scene] }, { script: 'ok', scenes: [] }, { script: 'ok', scenes: Array(41).fill(scene) }, { script: 'ok', scenes: [null] }]) {
    assert.throws(() => parseGenerated(JSON.stringify(value)));
  }
});

test('Inworld rejects unsuccessful HTTP responses', async () => {
  await assert.rejects(generateScript(project, { apiKey: 'key', fetchImpl: async () => new Response('', { status: 401 }) }), /401/);
});
