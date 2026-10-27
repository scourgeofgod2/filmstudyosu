import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorage, isId } from '../src/storage.js';

async function temporaryStorage(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'film-storage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, storage: createStorage(root) };
}

test('projects persist, list in updated order, and missing projects return null', async t => {
  const { storage } = await temporaryStorage(t);
  const older = { id: 'old', title: 'Old', updatedAt: '2024-01-01T00:00:00.000Z' };
  const newer = { id: 'new', title: 'New', updatedAt: '2025-01-01T00:00:00.000Z' };
  await storage.save(older);
  await storage.save(newer);
  assert.deepEqual(await storage.get('old'), older);
  assert.equal(await storage.get('missing'), null);
  assert.deepEqual(await storage.list(), [newer, older]);
  older.title = 'Updated';
  await storage.save(older);
  assert.deepEqual(await storage.get('old'), older);
});

test('image storage accepts only safe formats and rejects traversal', async t => {
  const { root, storage } = await temporaryStorage(t);
  const bytes = Buffer.from('test image');
  const url = await storage.saveImage(bytes, 'png');
  assert.match(url, /^\/images\/[a-f0-9-]{36}\.png$/);
  assert.deepEqual(await storage.readImage(url.slice('/images/'.length)), bytes);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'private');
  assert.equal(await storage.readImage('../outside.txt'), null);
  assert.equal(await storage.readImage('..\\outside.txt'), null);
  await assert.rejects(storage.saveImage(bytes, '../txt'));
  assert.equal(await readFile(outside, 'utf8'), 'private');
});

test('project ids cannot escape the temporary project directory', async t => {
  const { root, storage } = await temporaryStorage(t);
  const outside = path.join(root, 'outside.json');
  await writeFile(outside, 'private');
  for (const id of ['../outside', '..\\outside', '/absolute', '.', '', 'a/b', 'a'.repeat(129)]) {
    assert.equal(isId(id), false);
    await assert.rejects(storage.get(id));
    await assert.rejects(storage.save({ id, updatedAt: '' }));
  }
  assert.equal(await readFile(outside, 'utf8'), 'private');
});
