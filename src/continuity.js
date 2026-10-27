import { createHash } from 'node:crypto';
import { seedancePolicyInfo } from './seedance-policy.js';

export class ContinuityError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key] ?? '']));
const endingFields = ['events', 'characters', 'relationships', 'objects', 'openThreads', 'source'];
const card = item => pick(item, ['id', 'name', 'appearance', 'costume', 'personality', 'continuity', 'layout', 'lighting', 'atmosphere', 'imagePrompt']);
const clipData = clip => ({ ...pick(clip, ['id', 'title', 'duration', 'startState', 'endState', 'imagePrompt', 'videoPrompt', 'transitionNote', 'mode', 'activeCharacterIds', 'activeLocationId', 'keyframes']), camera: clip.camera, references: clip.references });
const storyClipData = clip => ({ ...pick(clip, ['id', 'title', 'duration', 'startState', 'endState', 'imagePrompt', 'videoPrompt', 'transitionNote']), camera: clip.camera });
const closureClipData = clip => ({
  ...pick(clip, ['id', 'title', 'duration', 'startState', 'endState', 'imagePrompt', 'videoPrompt', 'transitionNote']), camera: clip.camera, references: clip.references,
  ...(clip.mode && clip.mode !== 'reference' ? { mode: clip.mode } : {}),
  ...(clip.activeCharacterIds?.length ? { activeCharacterIds: clip.activeCharacterIds } : {}),
  ...(clip.activeLocationId ? { activeLocationId: clip.activeLocationId } : {}),
  ...(clip.keyframes && (clip.keyframes.firstId || clip.keyframes.lastId || clip.keyframes.firstLabel || clip.keyframes.lastLabel || clip.keyframes.labelsConfirmed) ? { keyframes: clip.keyframes } : {})
});
const sceneData = scene => ({ ...pick(scene, ['id', 'title', 'description', 'continuity', 'transitionNote']), clips: (scene.clips || []).map(closureClipData) });
const storySceneData = scene => ({ ...pick(scene, ['id', 'title', 'description', 'continuity', 'transitionNote']), clips: (scene.clips || []).map(storyClipData) });
const episodeData = episode => ({ ...pick(episode, ['id', 'title', 'targetSeconds', 'script']), story: { ...pick(episode.story, ['goal', 'planned']), ending: pick(episode.story?.ending, endingFields) }, scenes: (episode.scenes || []).map(sceneData) });
const episodeEvidence = episode => ({ script: episode.script, scenes: (episode.scenes || []).map(scene => ({ title: scene.title, description: scene.description, continuity: scene.continuity, transitionNote: scene.transitionNote, clips: (scene.clips || []).map(clip => ({ title: clip.title, startState: clip.startState, endState: clip.endState, transitionNote: clip.transitionNote })) })) });
const normalizedState = value => (value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const safeContext = value => {
  if (Array.isArray(value)) return value.map(safeContext);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:url|uri|path|imageUrl|contentUrl|previewUrl)$/i.test(key)).map(([key, item]) => [key, safeContext(item)]));
  return typeof value === 'string' ? value.replace(/(?:https?:\/\/|\/images\/)[^\s"<>]+/gi, '[address omitted]') : value;
};
export const validFrameLabel = label => typeof label === 'string' && /^@Image[1-9][0-9]*$/.test(label);

function chain(project) {
  const base = { ...pick(project, ['title', 'idea', 'kind']), preferences: project.preferences, storyBible: project.storyBible, characters: (project.characters || []).map(card), locations: (project.locations || []).map(card) };
  const prior = [];
  let broken = false;
  return (project.episodes || []).map(episode => {
    const ending = episode.story?.ending || {};
    const signature = hash({ ...base, prior, episode: episodeData(episode) });
    const stale = !!ending.approved && (broken || ending.signature !== signature);
    broken ||= !ending.approved || stale;
    prior.push({ id: episode.id, ending: pick(ending, endingFields), approved: !!ending.approved, signature: ending.signature || '', stale });
    return { signature, stale };
  });
}

function indexOf(items, target) { return items.findIndex(item => item === target || (target?.id && item.id === target.id)); }

export function closureSignature(project, episode) {
  const index = indexOf(project.episodes || [], episode);
  if (index < 0) throw new ContinuityError('Bölüm projede bulunamadı.');
  return chain(project)[index].signature;
}

export function applyContinuityState(project) {
  const states = chain(project);
  (project.episodes || []).forEach((episode, index) => { if (episode.story?.ending) episode.story.ending.stale = states[index].stale; });
  return project;
}

export function contextPreview(project, episode, scene, clip, kind = clip ? 'prompt' : scene ? 'clips' : 'plan') {
  if (!['plan', 'clips', 'prompt', 'ending', 'review'].includes(kind) || (['plan', 'ending', 'review'].includes(kind) && (scene || clip)) || (kind === 'clips' && (!scene || clip)) || (kind === 'prompt' && (!scene || !clip))) throw new ContinuityError('Bağlam türü veya hedefi geçersiz.');
  const episodes = project.episodes || [];
  const episodeIndex = indexOf(episodes, episode);
  if (episodeIndex < 0) throw new ContinuityError('Bölüm projede bulunamadı.');
  episode = episodes[episodeIndex];
  const scenes = episode.scenes || [];
  const sceneIndex = scene ? indexOf(scenes, scene) : -1;
  if (scene && sceneIndex < 0) throw new ContinuityError('Sahne bölümde bulunamadı.');
  if (scene) scene = scenes[sceneIndex];
  const clips = scene?.clips || [];
  const clipIndex = clip ? indexOf(clips, clip) : -1;
  if (clip && (!scene || clipIndex < 0)) throw new ContinuityError('Klip sahnede bulunamadı.');
  if (clip) clip = clips[clipIndex];
  const states = chain(project);
  const sources = [];
  const omitted = [];
  const warnings = [];
  const closures = [];
  for (let i = 0; i < episodeIndex; i++) {
    const prior = episodes[i], ending = prior.story?.ending;
    if (!ending?.approved || states[i].stale) {
      const reason = ending?.approved ? 'stale' : 'missing';
      omitted.push({ id: prior.id, type: 'closure', reason });
      warnings.push({ id: prior.id, type: reason, message: ending?.approved ? 'Önceki bölüm kapanışı güncel değil; bağlama dahil edilmedi.' : 'Önceki bölümün onaylı kapanışı yok; bağlama dahil edilmedi.' });
    } else {
      closures.push({ episodeId: prior.id, title: prior.title, ending: pick(ending, endingFields) });
      sources.push({ id: prior.id, type: 'closure' });
    }
  }
  episodes.slice(episodeIndex + 1).forEach(item => omitted.push({ id: item.id, type: 'episode', reason: 'future' }));
  const prefix = scene ? scenes.slice(0, sceneIndex) : [];
  scenes.slice(scene ? sceneIndex + 1 : 0).forEach(item => omitted.push({ id: item.id, type: 'scene', reason: 'future' }));
  if (scene) clips.slice(clip ? clipIndex + 1 : 0).forEach(item => omitted.push({ id: item.id, type: 'clip', reason: 'future' }));
  const characters = (project.characters || []).map(card), locations = (project.locations || []).map(card);
  if (scene) omitted.push({ id: episode.id, type: 'script', reason: 'may_contain_future' });
  sources.push({ id: project.id, type: 'storyBible' }, { id: episode.id, type: 'episode' });
  characters.forEach(item => sources.push({ id: item.id, type: 'character' }));
  locations.forEach(item => sources.push({ id: item.id, type: 'location' }));
  prefix.forEach(item => { sources.push({ id: item.id, type: 'scene' }); (item.clips || []).forEach(clip => sources.push({ id: clip.id, type: 'clip' })); });
  const previousScene = prefix.at(-1);
  const context = {
    project: { ...pick(project, ['title', 'idea', 'kind']), preferences: project.preferences, storyBible: project.storyBible, characters, locations },
    priorClosures: closures, continuityWarnings: warnings,
    episode: { ...pick(episode, ['id', 'title', 'targetSeconds']), story: pick(episode.story, ['goal', 'planned']), ...(scene ? {} : { script: episode.script }), scenes: prefix.map(storySceneData) },
    previousSceneEnding: previousScene ? { sceneId: previousScene.id, continuity: previousScene.continuity, transitionNote: previousScene.transitionNote, endState: previousScene.clips?.at(-1)?.endState || '' } : null
  };
  if (scene) {
    sources.push({ id: scene.id, type: 'scene' });
    context.scene = { ...pick(scene, ['id', 'title', 'description', 'continuity', 'transitionNote']), clips: (clip ? clips.slice(0, clipIndex) : []).map(storyClipData) };
    context.previousClipEnding = clipIndex > 0 ? { clipId: clips[clipIndex - 1].id, endState: clips[clipIndex - 1].endState, transitionNote: clips[clipIndex - 1].transitionNote } : null;
  }
  if (clip) {
    if (!Array.isArray(clip.references) || clip.references.length > 5) throw new ContinuityError('Klip referansları geçersiz.');
    const mode = clip.mode ?? 'reference';
    if (!['reference', 'keyframe'].includes(mode)) throw new ContinuityError('Klip modu geçersiz.');
    const activeCharacterIds = clip.activeCharacterIds ?? [];
    const activeLocationId = clip.activeLocationId ?? '';
    if (!Array.isArray(activeCharacterIds) || new Set(activeCharacterIds).size !== activeCharacterIds.length) throw new ContinuityError('Etkin karakterler geçersiz.');
    const activeCharacters = activeCharacterIds.map(id => {
      const character = (project.characters || []).find(item => item.id === id);
      if (!character) throw new ContinuityError('Etkin karakter bulunamadı.');
      return card(character);
    });
    const activeLocation = activeLocationId ? (project.locations || []).find(item => item.id === activeLocationId) : null;
    if (activeLocationId && !activeLocation) throw new ContinuityError('Etkin mekân bulunamadı.');
    const referenceData = id => {
      const reference = (project.refs || project.references || []).find(item => item.id === id);
      if (!reference) throw new ContinuityError('Klip referansı bulunamadı.');
      sources.push({ id: reference.id, type: 'reference' });
      return safeContext(reference);
    };
    const selectedReferences = mode === 'reference' ? clip.references.map((selected, index) => {
      const reference = referenceData(selected.id);
      return { ...reference, label: '@Image' + (index + 1), referenceRole: reference.role, clipRole: selected.role };
    }) : undefined;
    let keyframes;
    if (mode === 'keyframe') {
      const frames = clip.keyframes || {};
      if (!frames.firstId) throw new ContinuityError('İlk ana kare seçilmelidir.');
      const first = referenceData(frames.firstId), last = frames.lastId ? referenceData(frames.lastId) : null;
      const confirmed = frames.labelsConfirmed === true;
      if (confirmed && (!validFrameLabel(frames.firstLabel) || (last && (!validFrameLabel(frames.lastLabel) || frames.firstLabel === frames.lastLabel)))) throw new ContinuityError('Onaylı ana kare etiketleri geçersiz.');
      keyframes = { first: { ...first, frameRole: 'first', ...(confirmed ? { label: frames.firstLabel } : {}) }, last: last ? { ...last, frameRole: 'last', ...(confirmed ? { label: frames.lastLabel } : {}) } : null, labelsConfirmed: confirmed };
    }
    sources.push({ id: clip.id, type: 'clip' });
    context.scene.clips.forEach(item => sources.push({ id: item.id, type: 'clip' }));
    const { references, keyframes: ignoredFrames, ...promptClip } = clipData(clip);
    context.clip = { ...promptClip, mode, activeCharacterIds, activeLocationId, activeCharacters, activeLocation: activeLocation ? card(activeLocation) : null, ...(mode === 'reference' ? { selectedReferences, externalMapping: 'Etiketler yalnız sıralı yerel eşlemedir; dış araçta aynı sırayı kullanıcı doğrulamalıdır.' } : { keyframes, externalMapping: 'Seçili karelerin dış araçtaki ilk/son rol eşlemesini kullanıcı yapmalıdır.' }) };
  }
  if (clip) {
    const previousClip = clipIndex > 0 ? clips[clipIndex - 1] : previousScene?.clips?.at(-1);
    if (previousClip || previousScene) {
      const end = normalizedState(previousClip?.endState), start = normalizedState(clip.startState);
      if (!end || !start) warnings.push({ id: clip.id, type: 'unknown', message: 'Önceki bitiş veya klip başlangıç durumu boş; sınır sürekliliği bilinmiyor.' });
      else if (end !== start && ![previousClip?.transitionNote, clip.transitionNote, ...(clipIndex === 0 ? [previousScene?.transitionNote, scene.transitionNote] : [])].some(note => note?.trim())) warnings.push({ id: clip.id, type: 'review', message: 'Bitiş ve başlangıç metinleri farklı; geçişi gözden geçirin. Farklı ifade tek başına çelişki anlamına gelmez.' });
    }
  } else if (kind === 'clips' && previousScene && !normalizedState(previousScene.clips?.at(-1)?.endState)) {
    warnings.push({ id: previousScene.id, type: 'unknown', message: 'Önceki sahnenin son klip bitiş durumu boş; sahne sınırı bilinmiyor.' });
  }
  let modelContext = context;
  if (kind === 'ending' || kind === 'review') {
    const evidence = episodeEvidence(episode);
    if (kind === 'ending') {
      modelContext = evidence;
      sources.length = 0; omitted.length = 0; warnings.length = 0;
      sources.push({ id: episode.id, type: 'script' });
    } else {
      context.currentEpisodeEvidence = evidence;
      for (let i = omitted.length - 1; i >= 0; i--) if (omitted[i].type === 'scene') omitted.splice(i, 1);
    }
    scenes.forEach(item => { sources.push({ id: item.id, type: 'scene' }); (item.clips || []).forEach(entry => sources.push({ id: entry.id, type: 'clip' })); });
  }
  modelContext = safeContext(modelContext);
  const serialized = JSON.stringify(modelContext);
  if (serialized.length > 80000) throw new ContinuityError('Süreklilik bağlamı 80000 karakter sınırını aşıyor (' + serialized.length + '). Lütfen hikâye, kart veya sahne metinlerini kısaltın.');
  return { context: modelContext, sources, omitted, warnings, ...(kind === 'prompt' ? { policy: seedancePolicyInfo } : {}), signature: hash({ context: modelContext, ...(kind === 'prompt' ? { policy: seedancePolicyInfo, clip, references: project.refs || project.references } : {}), ...(kind === 'ending' ? { target: pick(episode.story?.ending, endingFields) } : kind === 'review' ? {} : { episode: episodeData(episode) }) }), estimatedChars: serialized.length };
}
