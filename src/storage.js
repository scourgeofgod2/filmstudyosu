import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function migrate(project) {
  if (project.schemaVersion === 4) return project;
  if (project.schemaVersion != null && ![1, 2, 3].includes(project.schemaVersion)) throw new Error('Desteklenmeyen proje sürümü');
  if (![2, 3].includes(project.schemaVersion) && !Array.isArray(project.scenes)) throw new Error('Geçersiz eski proje');
  const legacy = [2, 3].includes(project.schemaVersion) ? project : {
    ...project, kind: project.kind ?? 'film', characters: project.characters ?? [], locations: project.locations ?? [], references: project.references ?? [],
    episodes: [{
      id: randomUUID(), title: project.title, targetSeconds: 300, script: project.script || '',
      scenes: project.scenes.map(scene => ({
        ...scene, continuity: scene.continuity ?? '', clips: [{
          ...scene, id: randomUUID(), duration: scene.duration ?? 25,
          camera: scene.camera ?? { shot: '', angle: '', movement: '', lens: '', style: '', notes: '' },
          startState: scene.startState ?? '', endState: scene.endState ?? '', references: scene.references ?? [], referenceSignature: scene.referenceSignature ?? '[]'
        }]
      }))
    }]
  };
  const v3 = project.schemaVersion === 3 ? legacy : {
    ...legacy, schemaVersion: 3, revision: legacy.revision ?? 0,
    storyBible: { world: '', story: '', relationships: '', seasonArc: '', ...legacy.storyBible },
    episodes: legacy.episodes.map(episode => ({
      ...episode,
      story: { goal: '', planned: '', ...episode.story, ending: { events: '', characters: '', relationships: '', objects: '', openThreads: '', source: 'plan', approved: false, signature: '', ...episode.story?.ending } },
      scenes: episode.scenes.map(scene => ({ ...scene, transitionNote: scene.transitionNote ?? '', clips: scene.clips.map(clip => ({ ...clip, transitionNote: clip.transitionNote ?? '' })) }))
    }))
  };
  return {
    ...v3, schemaVersion: 4,
    refs: (v3.refs ?? v3.references ?? []).map(ref => ({ ...ref, assetType: 'none', assetIds: [], canonical: false })),
    episodes: v3.episodes.map(episode => ({
      ...episode, scenes: episode.scenes.map(scene => ({
        ...scene, clips: scene.clips.map(clip => ({
          ...clip, mode: clip.mode ?? 'reference', activeCharacterIds: clip.activeCharacterIds ?? [], activeLocationId: clip.activeLocationId ?? '',
          keyframes: { firstId: '', lastId: '', firstLabel: '', lastLabel: '', labelsConfirmed: false, ...clip.keyframes }
        }))
      }))
    }))
  };
}

export function createStorage(root = path.resolve('data')) {
  const projects = path.join(root, 'projects');
  const images = path.join(root, 'images');
  const migrations = new Map();
  const projectPath = id => {
    if (!isId(id)) throw new Error('Geçersiz kimlik');
    return path.join(projects, id + '.json');
  };
  return {
    async list() {
      await fs.mkdir(projects, { recursive: true });
      const names = await fs.readdir(projects);
      return (await Promise.all(names.filter(n => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(n)).map(n => this.get(n.slice(0, -5))))).filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) {
      if (migrations.has(id)) return migrations.get(id);
      const operation = (async () => {
        let original;
        try { original = await fs.readFile(projectPath(id), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        const project = JSON.parse(original);
        const migrated = migrate(project);
        if (migrated !== project) {
          const version = [2, 3].includes(project.schemaVersion) ? 'v' + project.schemaVersion : 'v1';
          try { await fs.writeFile(projectPath(id) + '.' + version + '.bak', original, { flag: 'wx', mode: 0o600 }); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            await fs.writeFile(projectPath(id) + '.' + randomUUID() + '.' + version + '.bak', original, { flag: 'wx', mode: 0o600 });
          }
          await this.save(migrated);
        }
        return migrated;
      })();
      migrations.set(id, operation);
      try { return await operation; } finally { migrations.delete(id); }
    },
    async save(project) {
      await fs.mkdir(projects, { recursive: true });
      const target = projectPath(project.id);
      const tmp = target + '.' + randomUUID() + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(project, null, 2), { mode: 0o600 });
      try { await fs.rename(tmp, target); } catch (error) { await fs.rm(tmp, { force: true }); throw error; }
      return project;
    },
    async saveImage(bytes, extension) {
      if (!['png', 'jpg', 'webp'].includes(extension)) throw new Error('Geçersiz görsel türü');
      await fs.mkdir(images, { recursive: true });
      const name = randomUUID() + '.' + extension;
      await fs.writeFile(path.join(images, name), bytes, { mode: 0o600 });
      return '/images/' + name;
    },
    async readImage(name) {
      if (!/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(name)) return null;
      try { return await fs.readFile(path.join(images, name)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  };
}
