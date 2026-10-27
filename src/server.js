import http from 'node:http';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createStorage, isId } from './storage.js';
import * as inworld from './inworld.js';
import { createStudio, StudioError } from './studio.js';
import { contextPreview, closureSignature, applyContinuityState, ContinuityError } from './continuity.js';
import { suggestReferences } from './reference-selection.js';

export async function loadEnv(file = '.env') {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(INWORLD_API_KEY|INWORLD_MODEL|STUDIO_API_KEY|PORT)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const text = (v, max, empty = true) => typeof v === 'string' && v.length <= max && (empty || !!v.trim());
const validImage = i => i && typeof i === 'object' && ['idle','starting','pending','partial','completed','error'].includes(i.status) && (i.batchId === null || isId(i.batchId)) && (i.url === null || (typeof i.url === 'string' && /^\/images\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(i.url))) && (i.error === null || text(i.error, 500));
const imageUrl = value => typeof value === 'string' && /^\/images\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const array = (value, max) => Array.isArray(value) && value.length <= max;
const endingFields = ['events', 'characters', 'relationships', 'objects', 'openThreads', 'source'];
const digest = value => createHash('sha256').update(value).digest('hex');
async function signatureDependencies(storage, project, episode, scene, clip, { allowMissing = false } = {}) {
  const policy = await fs.readFile(new URL('../.agents/skills/sd25-pe/SKILL.md', import.meta.url));
  const generator = await fs.readFile(new URL('./inworld.js', import.meta.url));
  const policyCode = await fs.readFile(new URL('./seedance-policy.js', import.meta.url));
  const effectiveIds = clip.mode === 'reference' ? clip.references.map(entry => entry.id) : [clip.keyframes.firstId, clip.keyframes.lastId];
  const references = await Promise.all(project.refs.map(async ref => {
    if (!imageUrl(ref.url)) throw new HttpError(400, 'Referans görseli geçersiz.');
    const bytes = await storage.readImage(ref.url.slice(8));
    if (!bytes && effectiveIds.includes(ref.id) && !allowMissing) throw new HttpError(409, 'Referans görseli bulunamadı.');
    return { id: ref.id, name: ref.name, role: ref.role, url: ref.url, assetType: ref.assetType, assetIds: ref.assetIds, canonical: ref.canonical, imageHash: bytes ? digest(bytes) : null };
  }));
  return { policy: digest(policy), policyCode: digest(policyCode), generator: digest(generator), references, mode: clip.mode, activeCharacterIds: clip.activeCharacterIds, activeLocationId: clip.activeLocationId, keyframes: clip.keyframes, selected: clip.references, context: contextPreview(project, episode, scene, clip, 'prompt').signature };
}
async function referenceSuggestion(storage, project, episode, scene, clip) {
  const suggestion = suggestReferences(project, clip);
  const selector = await fs.readFile(new URL('./reference-selection.js', import.meta.url));
  const signature = digest(JSON.stringify({ purpose: 'reference-suggestion', selector: digest(selector), suggestion, dependencies: await signatureDependencies(storage, project, episode, scene, clip, { allowMissing: true }) }));
  return { suggestion, signature, revision: project.revision };
}
async function proposalPreview(storage, project, episode, scene, clip, kind) {
  const preview = contextPreview(project, episode, scene, clip, kind);
  if (clip && (kind === 'prompt' || kind === undefined)) {
    const dependencies = await signatureDependencies(storage, project, episode, scene, clip);
    preview.signature = digest(JSON.stringify({ signature: preview.signature, dependencies }));
    const normalizedProject = structuredClone(project);
    const normalizedEpisode = normalizedProject.episodes.find(item => item.id === episode.id);
    const normalizedScene = normalizedEpisode.scenes.find(item => item.id === scene.id);
    const normalizedClip = normalizedScene.clips.find(item => item.id === clip.id);
    normalizedClip.videoPrompt = '';
    delete normalizedClip.referenceSignature;
    delete normalizedClip.promptDependencySignature;
    const normalizedContext = contextPreview(normalizedProject, normalizedEpisode, normalizedScene, normalizedClip, 'prompt').signature;
    preview.promptDependencySignature = digest(JSON.stringify({ purpose: 'prompt-dependencies', dependencies: { ...dependencies, context: normalizedContext } }));
  }
  return preview;
}
function checkRevision(body, project) {
  if (!object(body) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, 'Geçerli proje revizyonu gerekli.');
  if (body.revision !== project.revision) throw new HttpError(409, 'Proje değişti; önizlemeyi yenileyin.');
}
function clipTarget(project, route) {
  const episode = project.episodes.find(item => item.id === route[1]);
  const scene = episode?.scenes.find(item => item.id === route[2]);
  const clip = scene?.clips.find(item => item.id === route[3]);
  if (!clip) throw new HttpError(404, 'Klip bulunamadı.');
  return { episode, scene, clip };
}
function checkExpectedSignature(body, signature) {
  if (!object(body) || typeof body.expectedSignature !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedSignature)) throw new HttpError(400, 'Geçerli bağlam imzası gerekli.');
  if (body.expectedSignature !== signature) throw new HttpError(409, 'Bağlam değişti; önizlemeyi yenileyin.');
}
function preserveApprovals(project, previous) {
  for (const episode of project.episodes) {
    const ending = episode.story.ending;
    const old = previous.episodes.find(item => item.id === episode.id)?.story?.ending;
    const unchanged = old && endingFields.every(key => ending[key] === old[key]);
    ending.approved = !!(unchanged && old.approved && /^[a-f0-9]{64}$/.test(old.signature));
    ending.signature = ending.approved ? old.signature : '';
    delete ending.stale;
  }
  applyContinuityState(project);
}
function protectPendingImages(previous, project) {
  const assets = p => ({ characters: p.characters, locations: p.locations, clips: p.episodes.flatMap(episode => episode.scenes.flatMap(scene => scene.clips)) });
  const oldAssets = assets(previous), newAssets = assets(project);
  for (const type of ['characters', 'locations', 'clips']) {
    const incoming = new Map(newAssets[type].map(asset => [asset.id, asset]));
    for (const asset of oldAssets[type]) {
      if (!['starting', 'pending', 'partial'].includes(asset.image.status)) continue;
      const current = incoming.get(asset.id);
      if (!current) throw new HttpError(409, 'Görsel işlemi süren öğe silinemez.');
      current.image = asset.image;
    }
  }
}
function cleanProject(p, id) {
  const ids = new Set();
  const unique = value => { if (!isId(value) || ids.has(value)) return false; ids.add(value); return true; };
  const fields = (value, keys, max = 10000) => object(value) && keys.every(key => text(value[key], max));
  const fail = () => { throw new HttpError(400, 'Proje verisi geçersiz.'); };
  if (!object(p) || p.id !== id || p.schemaVersion !== 4 || !Number.isSafeInteger(p.revision) || p.revision < 0 || !text(p.title, 300, false) || !text(p.idea, 20000, false) || !object(p.preferences) || JSON.stringify(p.preferences).length > 20000 || !['film', 'series'].includes(p.kind) || !fields(p.storyBible, ['world', 'story', 'relationships', 'seasonArc'], 20000) || !array(p.characters, 100) || !array(p.locations, 100) || !array(p.refs, 100) || !array(p.references, 100) || !array(p.episodes, 100)) fail();
  if (!unique(p.id)) fail();
  for (const character of p.characters) if (!fields(character, ['appearance', 'costume', 'personality', 'continuity', 'imagePrompt']) || !unique(character.id) || !text(character.name, 300, false) || !validImage(character.image)) fail();
  for (const location of p.locations) if (!fields(location, ['layout', 'lighting', 'atmosphere', 'imagePrompt']) || !unique(location.id) || !text(location.name, 300, false) || !validImage(location.image)) fail();
  const characterIds = new Set(p.characters.map(item => item.id)), locationIds = new Set(p.locations.map(item => item.id));
  for (const ref of p.refs) {
    if (!object(ref) || !unique(ref.id) || !text(ref.name, 300, false) || !text(ref.role, 300) || !imageUrl(ref.url) || !['character', 'location', 'group', 'none'].includes(ref.assetType) || !array(ref.assetIds, 200) || new Set(ref.assetIds).size !== ref.assetIds.length || typeof ref.canonical !== 'boolean') fail();
    if (ref.assetType === 'none' && ref.assetIds.length || ['character', 'location'].includes(ref.assetType) && ref.assetIds.length > 1 || ref.assetIds.some(id => ref.assetType === 'character' ? !characterIds.has(id) : ref.assetType === 'location' ? !locationIds.has(id) : !characterIds.has(id) && !locationIds.has(id))) fail();
  }
  const legacyRefs = new Map(p.references.map(ref => [ref?.id, ref]));
  if (p.references.length !== p.refs.length || legacyRefs.size !== p.references.length || p.refs.some(ref => !legacyRefs.has(ref.id) || ['name', 'role', 'url'].some(key => legacyRefs.get(ref.id)[key] !== ref[key]))) fail();
  const referenceIds = new Set(p.refs.map(ref => ref.id));
  for (const episode of p.episodes) {
    if (!object(episode) || !unique(episode.id) || !text(episode.title, 300, false) || !Number.isFinite(episode.targetSeconds) || episode.targetSeconds < 300 || episode.targetSeconds > 600 || !text(episode.script, 50000) || !array(episode.scenes, 40)) fail();
    if (!fields(episode.story, ['goal', 'planned'], 20000) || !fields(episode.story.ending, ['events', 'characters', 'relationships', 'objects', 'openThreads'], 20000) || !['plan', 'verified'].includes(episode.story.ending.source) || typeof episode.story.ending.approved !== 'boolean' || !text(episode.story.ending.signature, 64) || !/^(?:[a-f0-9]{64})?$/.test(episode.story.ending.signature)) fail();
    for (const scene of episode.scenes) {
      if (!object(scene) || !unique(scene.id) || !text(scene.title, 300, false) || !fields(scene, ['description', 'continuity', 'transitionNote']) || !array(scene.clips, 100)) fail();
      for (const clip of scene.clips) {
        if (!object(clip) || !unique(clip.id) || !text(clip.title, 300, false) || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 25 || !fields(clip.camera, ['shot', 'angle', 'movement', 'lens', 'style', 'notes'], 1000) || !fields(clip, ['startState', 'endState', 'imagePrompt', 'videoPrompt', 'transitionNote']) || !text(clip.referenceSignature, 150000) || !validImage(clip.image) || !array(clip.references, 5)) fail();
        if (clip.promptDependencySignature !== undefined && (typeof clip.promptDependencySignature !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(clip.promptDependencySignature))) fail();
        const used = new Set();
        for (const ref of clip.references) { if (!object(ref) || !referenceIds.has(ref.id) || used.has(ref.id) || !text(ref.role, 300)) fail(); used.add(ref.id); }
        if (!['reference', 'keyframe'].includes(clip.mode) || !array(clip.activeCharacterIds, 100) || new Set(clip.activeCharacterIds).size !== clip.activeCharacterIds.length || clip.activeCharacterIds.some(id => !characterIds.has(id)) || (clip.activeLocationId !== '' && !locationIds.has(clip.activeLocationId)) || !object(clip.keyframes)) fail();
        const { firstId, lastId, firstLabel, lastLabel, labelsConfirmed } = clip.keyframes;
        if ((firstId !== '' && !referenceIds.has(firstId)) || (lastId !== '' && !referenceIds.has(lastId)) || (firstId && firstId === lastId) || !text(firstLabel, 100) || !text(lastLabel, 100) || typeof labelsConfirmed !== 'boolean') fail();
        if (labelsConfirmed && (!firstId || !/^@Image[1-9][0-9]*$/.test(firstLabel) || (lastId && (!/^@Image[1-9][0-9]*$/.test(lastLabel) || firstLabel === lastLabel)))) fail();
      }
    }
  }
  const { script, scenes, ...data } = p;
  return { ...data, updatedAt: new Date().toISOString() };
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON içerik türü gerekli.');
  const limit = 10 * 1024 * 1024;
  if (Number(req.headers['content-length'] || 0) > limit) { req.resume(); throw new HttpError(413, 'JSON isteği 10 MiB sınırını aşıyor.'); }
  const parts = []; let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) { size += part.length; if (size > limit) { req.resume(); throw new HttpError(413, 'JSON isteği 10 MiB sınırını aşıyor.'); } parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new HttpError(400, 'JSON okunamadı.'); }
}
async function readUpload(req) {
  const type = (req.headers['content-type'] || '').toLowerCase();
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  if (!extensions[type]) throw new HttpError(415, 'Desteklenmeyen görsel türü.');
  if (Number(req.headers['content-length'] || 0) > 20 * 1024 * 1024) throw new HttpError(413, 'Görsel çok büyük.');
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > 20 * 1024 * 1024) throw new HttpError(413, 'Görsel çok büyük.'); parts.push(part); }
  const bytes = Buffer.concat(parts);
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!(type === 'image/png' ? png : type === 'image/jpeg' ? jpeg : webp)) throw new HttpError(400, 'Görsel içeriği türüyle eşleşmiyor.');
  return [bytes, extensions[type]];
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}

export function createServer({ storage = createStorage(), studio = createStudio(), generateEpisodePlan = inworld.generateEpisodePlan, generateSceneClips = inworld.generateSceneClips, generateClipPrompt = inworld.generateClipPrompt, generateEndingSuggestion = inworld.generateEndingSuggestion, generateContinuityReview = inworld.generateContinuityReview } = {}) {
  const active = new Set();
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) throw new HttpError(403, 'Geçersiz sunucu adresi.');
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw new HttpError(403, 'Kaynak reddedildi.');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new HttpError(403, 'Kaynak reddedildi.');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-local-request'] !== '1') throw new HttpError(403, 'Yerel istek başlığı gerekli.');
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(staticFiles, path)) {
        const [name, type] = staticFiles[path];
        const content = await fs.readFile(new URL('../public/' + name, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(content); return;
      }
      if (req.method === 'GET' && path.startsWith('/images/')) {
        const name = path.slice(8), bytes = await storage.readImage(name);
        if (!bytes) throw new HttpError(404, 'Görsel bulunamadı.');
        const ext = name.split('.').pop();
        res.writeHead(200, { 'Content-Type': {png:'image/png',jpg:'image/jpeg',webp:'image/webp'}[ext], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(bytes); return;
      }
      if (path === '/api/projects' && req.method === 'GET') { const projects = await storage.list(); projects.forEach(applyContinuityState); return send(res, 200, projects); }
      if (path === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req), id = randomUUID();
        if (!object(body)) throw new HttpError(400, 'Proje verisi geçersiz.');
        const project = cleanProject({ id, schemaVersion: 4, revision: 0, title: body.title, idea: body.idea, preferences: body.preferences, kind: body.kind ?? 'film', storyBible: { world: '', story: '', relationships: '', seasonArc: '' }, characters: [], locations: [], refs: [], references: [], episodes: [] }, id);
        await storage.save(project); return send(res, 201, project);
      }
      const match = path.match(/^\/api\/projects\/([a-zA-Z0-9_-]{1,128})(?:\/(.*))?$/);
      if (!match) throw new HttpError(404, 'Yol bulunamadı.');
      const id = match[1], route = match[2] || '';
      const assetRoute = route.match(/^assets\/(characters|locations|clips)\/([a-zA-Z0-9_-]{1,128})\/(image|poll|recover)$/);
      const oldAssetRoute = route.match(/^scenes\/([a-zA-Z0-9_-]{1,128})\/(image|poll)$/);
      const planRoute = route.match(/^episodes\/([a-zA-Z0-9_-]{1,128})\/plan$/);
      const clipsRoute = route.match(/^episodes\/([a-zA-Z0-9_-]{1,128})\/scenes\/([a-zA-Z0-9_-]{1,128})\/clips\/propose$/);
      const promptRoute = route.match(/^episodes\/([a-zA-Z0-9_-]{1,128})\/scenes\/([a-zA-Z0-9_-]{1,128})\/clips\/([a-zA-Z0-9_-]{1,128})\/prompt\/propose$/);
      const continuityRoute = route.match(/^episodes\/([a-zA-Z0-9_-]{1,128})\/(context|ending\/approve|ending\/propose|review|apply-proposal)$/);
      const referenceRoute = route.match(/^episodes\/([a-zA-Z0-9_-]{1,128})\/scenes\/([a-zA-Z0-9_-]{1,128})\/clips\/([a-zA-Z0-9_-]{1,128})\/references\/(suggest|apply)$/);
      const upload = route === 'references/upload';
      if (route && !assetRoute && !oldAssetRoute && !planRoute && !clipsRoute && !promptRoute && !referenceRoute && !continuityRoute && !upload && route !== 'generate') throw new HttpError(404, 'Yol bulunamadı.');
      if (!route && req.method === 'GET') { const p = await storage.get(id); if (!p) throw new HttpError(404, 'Proje bulunamadı.'); applyContinuityState(p); return send(res, 200, p); }
      if (continuityRoute?.[2] === 'context' && req.method === 'GET') {
        const p = await storage.get(id); if (!p) throw new HttpError(404, 'Proje bulunamadı.');
        applyContinuityState(p);
        const episode = p.episodes.find(item => item.id === continuityRoute[1]); if (!episode) throw new HttpError(404, 'Bölüm bulunamadı.');
        const sceneId = url.searchParams.get('sceneId'), clipId = url.searchParams.get('clipId');
        const scene = sceneId ? episode.scenes.find(item => item.id === sceneId) : undefined;
        if ((sceneId && !scene) || (clipId && !scene)) throw new HttpError(404, 'Sahne bulunamadı.');
        const clip = clipId ? scene.clips.find(item => item.id === clipId) : undefined;
        if (clipId && !clip) throw new HttpError(404, 'Klip bulunamadı.');
        const kind = url.searchParams.has('kind') ? url.searchParams.get('kind') : undefined;
        const preview = await proposalPreview(storage, p, episode, scene, clip, kind);
        return send(res, 200, kind === 'ending' ? { ...preview, revision: p.revision, closureSignature: closureSignature(p, episode) } : { ...preview, revision: p.revision });
      }
      if (referenceRoute?.[4] === 'suggest' && req.method === 'GET') {
        const project = await storage.get(id); if (!project) throw new HttpError(404, 'Proje bulunamadı.');
        applyContinuityState(project);
        const { episode, scene, clip } = clipTarget(project, referenceRoute);
        if (clip.mode !== 'reference') throw new HttpError(409, 'Referans seçimi için referans modunu seçin.');
        return send(res, 200, await referenceSuggestion(storage, project, episode, scene, clip));
      }
      if (referenceRoute && (referenceRoute[4] !== 'apply' || req.method !== 'POST')) throw new HttpError(405, 'Yöntem desteklenmiyor.');
      if ((!route && req.method !== 'PUT') || (route && (req.method !== 'POST' || continuityRoute?.[2] === 'context'))) throw new HttpError(405, 'Yöntem desteklenmiyor.');
      if (route && !upload && !planRoute && !clipsRoute && !promptRoute && !referenceRoute && !['apply-proposal', 'ending/approve', 'ending/propose', 'review'].includes(continuityRoute?.[2]) && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0)) throw new HttpError(400, 'Bu işlem istek gövdesi kabul etmez.');
      if (active.has(id)) throw new HttpError(409, 'Proje üzerinde başka bir işlem sürüyor.');
      active.add(id);
      try {
        let project = await storage.get(id);
        if (!project) throw new HttpError(404, 'Proje bulunamadı.');
        applyContinuityState(project);
        if (!route) {
          const previous = project;
          project = cleanProject(await readBody(req), id);
          if (project.revision !== previous.revision) throw new HttpError(409, 'Proje değişmiş; kaydetmeden önce projeyi yeniden açın.');
          protectPendingImages(previous, project);
          preserveApprovals(project, previous);
          project.revision = previous.revision + 1;
          if (Object.hasOwn(previous, 'script')) project.script = previous.script;
          if (Object.hasOwn(previous, 'scenes')) project.scenes = previous.scenes;
        } else if (upload) {
          const [bytes, extension] = await readUpload(req);
          return send(res, 201, { url: await storage.saveImage(bytes, extension) });
        } else if (referenceRoute) {
          const body = await readBody(req);
          checkRevision(body, project);
          const { episode, scene, clip } = clipTarget(project, referenceRoute);
          if (clip.mode !== 'reference') throw new HttpError(409, 'Referans seçimi için referans modunu seçin.');
          const preview = await referenceSuggestion(storage, project, episode, scene, clip);
          checkExpectedSignature(body, preview.signature);
          if (!array(body.selected, 5)) throw new HttpError(400, 'Referans seçimi geçersiz.');
          const selected = new Set();
          for (const ref of body.selected) {
            if (!object(ref) || !project.refs.some(item => item.id === ref.id) || selected.has(ref.id) || !text(ref.role, 300)) throw new HttpError(400, 'Referans seçimi geçersiz.');
            selected.add(ref.id);
          }
          for (const ref of project.refs.filter(item => selected.has(item.id))) if (!await storage.readImage(ref.url.slice(8))) throw new HttpError(409, 'Referans görseli bulunamadı.');
          clip.references = body.selected.map(({ id, role }) => ({ id, role }));
          const legacyScript = project.script, legacyScenes = project.scenes;
          project = cleanProject(project, id);
          if (legacyScript !== undefined) project.script = legacyScript;
          if (legacyScenes !== undefined) project.scenes = legacyScenes;
          applyContinuityState(project);
          project.revision++;
        } else if (continuityRoute) {
          const episode = project.episodes.find(item => item.id === continuityRoute[1]);
          if (!episode) throw new HttpError(404, 'Bölüm bulunamadı.');
          const action = continuityRoute[2];
          if (action === 'ending/approve') {
            const body = await readBody(req);
            if (!object(body) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, 'Geçerli proje revizyonu gerekli.');
            if (body.revision !== project.revision) throw new HttpError(409, 'Proje değişti; önizlemeyi yenileyin.');
            const signature = closureSignature(project, episode);
            checkExpectedSignature(body, signature);
            if (!endingFields.slice(0, 5).some(key => episode.story.ending[key].trim())) throw new HttpError(400, 'Boş kapanış onaylanamaz.');
            cleanProject(project, id);
            episode.story.ending.approved = true;
            episode.story.ending.signature = signature;
            applyContinuityState(project);
            project.revision++; project.updatedAt = new Date().toISOString();
          } else if (action === 'ending/propose' || action === 'review') {
            const body = await readBody(req);
            const preview = await proposalPreview(storage, project, episode, undefined, undefined, action === 'review' ? 'review' : 'ending');
            checkExpectedSignature(body, preview.signature);
            const data = await (action === 'review' ? generateContinuityReview(project, episode) : generateEndingSuggestion(project, episode));
            return send(res, 200, { data, preview });
          } else {
            const body = await readBody(req);
            if (!object(body) || !['plan', 'clips', 'prompt', 'ending'].includes(body.kind) || typeof body.expectedSignature !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedSignature) || !object(body.data)) throw new HttpError(400, 'Öneri verisi geçersiz.');
            checkRevision(body, project);
            if ((['plan', 'ending'].includes(body.kind) && (body.sceneId != null || body.clipId != null)) || (body.kind === 'clips' && body.clipId != null) || (['clips', 'prompt'].includes(body.kind) && !isId(body.sceneId)) || (body.kind === 'prompt' && !isId(body.clipId))) throw new HttpError(400, 'Öneri hedefi geçersiz.');
            const scene = body.sceneId ? episode.scenes.find(item => item.id === body.sceneId) : undefined;
            if (['clips', 'prompt'].includes(body.kind) && !scene) throw new HttpError(404, 'Sahne bulunamadı.');
            const clip = body.clipId && scene ? scene.clips.find(item => item.id === body.clipId) : undefined;
            if (body.kind === 'prompt' && !clip) throw new HttpError(404, 'Klip bulunamadı.');
            const preview = await proposalPreview(storage, project, episode, scene, clip, body.kind);
            if (preview.signature !== body.expectedSignature) throw new HttpError(409, 'Öneri bağlamı değişti; yeni öneri alın.');
            const previous = structuredClone(project);
            if (body.kind === 'plan') { episode.script = body.data.script; episode.scenes = body.data.scenes; }
            else if (body.kind === 'clips') scene.clips = body.data.clips;
            else if (body.kind === 'prompt') {
              if (!text(body.data.videoPrompt, 10000, false)) throw new HttpError(400, 'Prompt önerisi geçersiz.');
              if (!inworld.validateClipPrompt(body.data.videoPrompt, preview.context.clip).valid) throw new HttpError(400, 'Prompt referansları geçersiz.');
              clip.videoPrompt = body.data.videoPrompt;
              const describeRef = id => { const ref = project.refs.find(item => item.id === id); return { id, name: ref?.name, defaultRole: ref?.role, url: ref?.url, assetType: ref?.assetType, assetIds: ref?.assetIds, canonical: ref?.canonical }; };
              clip.referenceSignature = JSON.stringify({ mode: clip.mode, activeCharacterIds: clip.activeCharacterIds || [], activeLocationId: clip.activeLocationId || '', ...(clip.mode === 'keyframe' ? { keyframes: clip.keyframes, frameRefs: [clip.keyframes.firstId, clip.keyframes.lastId].filter(Boolean).map(describeRef) } : { references: clip.references.map(entry => ({ ...describeRef(entry.id), role: entry.role })) }) });
              clip.promptDependencySignature = preview.promptDependencySignature;
            } else {
              const ending = body.data.ending ?? body.data;
              if (!object(ending) || endingFields.slice(0, 5).some(key => !text(ending[key], 20000))) throw new HttpError(400, 'Kapanış önerisi geçersiz.');
              for (const key of endingFields.slice(0, 5)) episode.story.ending[key] = ending[key];
              episode.story.ending.source = 'plan';
            }
            project = cleanProject(project, id);
            protectPendingImages(previous, project);
            preserveApprovals(project, previous);
            if (body.kind === 'ending') {
              const ending = project.episodes.find(item => item.id === episode.id).story.ending;
              ending.approved = false;
              ending.signature = '';
              applyContinuityState(project);
            }
            project.revision = previous.revision + 1;
            if (Object.hasOwn(previous, 'script')) project.script = previous.script;
            if (Object.hasOwn(previous, 'scenes')) project.scenes = previous.scenes;
          }
        } else if (planRoute || clipsRoute || promptRoute) {
          const body = await readBody(req);
          const params = planRoute || clipsRoute || promptRoute;
          const episode = project.episodes.find(item => item.id === params[1]);
          if (!episode) throw new HttpError(404, 'Bölüm bulunamadı.');
          if (planRoute) { const preview = await proposalPreview(storage, project, episode, undefined, undefined, 'plan'); checkExpectedSignature(body, preview.signature); const data = await generateEpisodePlan(project, episode); return send(res, 200, { data, preview }); }
          const scene = episode.scenes.find(item => item.id === params[2]);
          if (!scene) throw new HttpError(404, 'Sahne bulunamadı.');
          if (clipsRoute) { const preview = contextPreview(project, episode, scene, undefined, 'clips'); checkExpectedSignature(body, preview.signature); const data = await generateSceneClips(project, episode, scene); return send(res, 200, { data, preview }); }
          const clip = scene.clips.find(item => item.id === params[3]);
          if (!clip) throw new HttpError(404, 'Klip bulunamadı.');
          checkRevision(body, project);
          const preview = await proposalPreview(storage, project, episode, scene, clip, 'prompt');
          checkExpectedSignature(body, preview.signature);
          const data = await generateClipPrompt(project, episode, scene, clip);
          return send(res, 200, { data, preview });
        } else if (route === 'generate') {
          throw new HttpError(409, 'Bölüm planı önerisini kullanın; mevcut bölümler otomatik değiştirilmez.');
        } else {
          const type = assetRoute?.[1];
          let asset;
          if (type === 'characters' || type === 'locations') asset = project[type].find(item => item.id === assetRoute[2]);
          else if (type === 'clips') asset = project.episodes.flatMap(episode => episode.scenes.flatMap(scene => scene.clips)).find(item => item.id === assetRoute[2]);
          else {
            const scene = project.episodes.flatMap(episode => episode.scenes).find(item => item.id === oldAssetRoute[1]);
            asset = scene?.clips[0];
          }
          if (!asset) throw new HttpError(404, 'Öğe bulunamadı.');
          const action = assetRoute ? assetRoute[3] : oldAssetRoute[2];
          const syncLegacy = () => {
            if (!oldAssetRoute || !Array.isArray(project.scenes)) return;
            const legacy = project.scenes.find(item => item.id === oldAssetRoute[1]);
            if (legacy) legacy.image = asset.image;
          };
          const saveImageState = async () => {
            syncLegacy(); applyContinuityState(project); project.updatedAt = new Date().toISOString(); project.revision++;
            await storage.save(project);
          };
          if (action === 'image') {
            if (['starting', 'pending', 'partial'].includes(asset.image.status)) throw new HttpError(409, 'Görsel isteği zaten sürüyor veya sonucu belirsiz.');
            if (!text(asset.imagePrompt, 10000, false)) throw new HttpError(400, 'Görsel istemi boş.');
            let submitted = false;
            try {
              const batchId = await studio.start(asset.imagePrompt, async () => {
                asset.image = { status: 'starting', batchId: null, url: asset.image.url, error: null };
                await saveImageState(); submitted = true;
              });
              asset.image = { status: 'pending', batchId, url: asset.image.url, error: null };
            } catch (error) {
              if (submitted && error instanceof StudioError && (error.status === 429 || error.status === 503)) {
                asset.image = { status: 'error', batchId: null, url: asset.image.url, error: error.message };
                await saveImageState();
              }
              throw error;
            }
          } else if (action === 'recover') {
            if (asset.image.status !== 'starting' || asset.image.batchId !== null) throw new HttpError(409, 'Yalnızca batch kimliği olmayan başlangıç durumu kurtarılabilir.');
            asset.image = { ...asset.image, status: 'error', error: 'Görsel işlemi elle kurtarıldı; önceki istek işlenmiş olabilir.' };
          } else {
            if (!asset.image.batchId || !['pending', 'partial'].includes(asset.image.status)) throw new HttpError(409, 'Sorgulanacak bekleyen görsel yok.');
            const result = await studio.poll(asset.image.batchId, storage);
            asset.image = { ...result, url: result.status === 'completed' ? result.url : asset.image.url };
          }
          await saveImageState(); return send(res, 200, project);
        }
        await storage.save(project); return send(res, 200, project);
      } finally { active.delete(id); }
    } catch (error) {
      const known = error instanceof HttpError || error instanceof StudioError || error instanceof inworld.InworldError || error instanceof ContinuityError;
      const status = known ? error.status : 500;
      const message = known ? error.message : 'İşlem başarısız. Yapılandırmayı ve bağlantıyı kontrol edin.';
      return send(res, status, { error: message, ...(error.retryAfter != null ? { retryAfter: error.retryAfter } : {}) }, error.retryAfter != null ? { 'Retry-After': String(error.retryAfter) } : {});
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await loadEnv();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT geçersiz.');
  createServer().listen(port, '127.0.0.1', () => console.log('Yerel sunucu 127.0.0.1:' + port));
}
