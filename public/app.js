'use strict';

const workspace = document.querySelector('#workspace');
const projectList = document.querySelector('#project-list');
const notice = document.querySelector('#notice');
const newButton = document.querySelector('#new-project');
let projects = [];
let project = null;
let dirty = false;
let busy = false;
let proposal = null;
let contextRequest = null;
let endingApproval = null;
let referenceProposal = null;
let editVersion = 0;
let imageStateUnknown = false;
let modeChanges = new Set();

const id = () => crypto.randomUUID();
const emptyImage = () => ({ status: 'idle', batchId: null, url: null, error: null });
const emptyEnding = () => ({ events: '', characters: '', relationships: '', objects: '', openThreads: '', source: 'plan', approved: false, signature: '', stale: false });
const signature = clip => {
  const describeRef = id => {
    const ref = project.refs.find(item => item.id === id);
    return { id, name: ref?.name, defaultRole: ref?.role, url: ref?.url, assetType: ref?.assetType, assetIds: ref?.assetIds, canonical: ref?.canonical };
  };
  return JSON.stringify({
    mode: clip.mode, activeCharacterIds: clip.activeCharacterIds || [], activeLocationId: clip.activeLocationId || '',
    ...(clip.mode === 'keyframe'
      ? { keyframes: clip.keyframes, frameRefs: [clip.keyframes.firstId, clip.keyframes.lastId].filter(Boolean).map(describeRef) }
      : { references: clip.references.map(entry => ({ ...describeRef(entry.id), role: entry.role })) })
  });
};
const path = () => '/api/projects/' + encodeURIComponent(project.id);
const part = value => encodeURIComponent(value);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function changed() { editVersion++; dirty = true; updateSaveState(); refreshDurationSummaries(); }
function field(label, value, onInput, options = {}) {
  const wrapper = el('label', 'field' + (options.wide ? ' wide' : ''));
  wrapper.append(el('span', 'field-label', label));
  const input = el(options.multiline ? 'textarea' : 'input');
  if (options.multiline) input.rows = options.rows || 3;
  else input.type = options.type || 'text';
  if (options.min !== undefined) input.min = options.min;
  if (options.max !== undefined) input.max = options.max;
  if (options.step !== undefined) input.step = options.step;
  input.value = value ?? '';
  if (options.placeholder) input.placeholder = options.placeholder;
  input.addEventListener('input', () => { onInput(input.value); changed(); });
  wrapper.append(input);
  if (options.hint) wrapper.append(el('small', 'field-hint', options.hint));
  return wrapper;
}
function selectField(label, value, choices, onChange) {
  const wrapper = el('label', 'field');
  wrapper.append(el('span', 'field-label', label));
  const select = el('select');
  choices.forEach(([v, text]) => { const option = el('option', '', text); option.value = v; select.append(option); });
  select.value = value;
  select.addEventListener('change', () => { onChange(select.value); changed(); });
  wrapper.append(select);
  return wrapper;
}
function checkbox(label, value, onChange) {
  const wrapper = el('label', 'check-field'); const input = el('input'); input.type = 'checkbox'; input.checked = value;
  input.addEventListener('change', () => { onChange(input.checked); changed(); });
  wrapper.append(input, el('span', '', label)); return wrapper;
}
function showNotice(message, error = false) {
  notice.textContent = message; notice.className = 'notice ' + (error ? 'error' : 'success'); notice.hidden = !message;
}
async function api(url, method = 'GET', body, raw = false) {
  const headers = method === 'GET' ? {} : { 'X-Local-Request': '1' };
  if (body !== undefined) headers['Content-Type'] = raw ? body.type : 'application/json';
  const payload = body === undefined ? undefined : raw ? body : JSON.stringify(body);
  if (method === 'PUT' && new TextEncoder().encode(payload).length > 10 * 1024 * 1024) throw new Error('Proje 10 MiB JSON boyut sınırını aşıyor. Kaydetmeden önce içeriği küçültün; değişiklikleriniz korunuyor.');
  const response = await fetch(url, { method, headers, body: payload });
  const data = await response.json().catch(() => null);
  if (method === 'PUT' && response.status === 409) throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || 'Proje üzerinde bir çakışma oluştu.') + ' Kaydedilmemiş değişiklikleriniz ve bekleyen öneriniz bu ekranda korunuyor. İşlem sürüyorsa bitmesini bekleyip kaydedin; proje değiştiyse içeriği kopyalayıp projeyi yeniden açın ve güncel sürüme uygulayın.');
  if (!response.ok) {
    const error = new Error((typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || `İstek başarısız (${response.status}).`) + (data?.retryAfter != null ? ` Tekrar deneme: ${data.retryAfter}` : ''));
    error.status = response.status; throw error;
  }
  if (!data) throw new Error('Sunucudan geçerli yanıt alınamadı.');
  return data;
}
function setBusy(value) {
  busy = value;
  workspace.querySelectorAll('button, input, textarea, select').forEach(node => { node.disabled = value; });
  projectList.querySelectorAll('button').forEach(node => { node.disabled = value; });
  newButton.disabled = value; workspace.setAttribute('aria-busy', String(value));
}
function updateSaveState() {
  const state = document.querySelector('#save-state');
  if (state) state.textContent = dirty ? 'Kaydedilmemiş değişiklikler' : 'Tüm değişiklikler kaydedildi';
}
function refreshDurationSummaries() {
  if (!project) return;
  workspace.querySelectorAll('[data-episode-total]').forEach(node => {
    const episode = project.episodes.find(item => item.id === node.dataset.episodeTotal);
    if (!episode) return;
    const total = episode.scenes.reduce((sum, scene) => sum + scene.clips.reduce((n, clip) => n + (Number(clip.duration) || 0), 0), 0);
    node.textContent = `Klip toplamı: ${total} sn / hedef: ${episode.targetSeconds} sn${total < 300 || total > 600 ? ' — toplam 300–600 saniye aralığında olmalı.' : total !== episode.targetSeconds ? ' — hedefle henüz eşleşmiyor.' : ' — hedefe ulaşıldı.'} 25 saniyelik kliplerle hedef için en az ${Math.ceil(episode.targetSeconds / 25)} klip gerekir; kısa kliplerde daha fazla gerekir.`;
  });
}
function acceptProject(updated) {
  project = updated; dirty = false;
  const index = projects.findIndex(item => item.id === updated.id);
  if (index < 0) projects.unshift(updated); else projects[index] = updated;
  renderList(); renderProject();
  if (busy) setBusy(true);
}
function validateProject() {
  if (!project.title.trim() || !project.idea.trim()) throw new Error('Proje adı ve fikir boş olamaz.');
  for (const episode of project.episodes) {
    if (!Number.isFinite(episode.targetSeconds) || episode.targetSeconds < 300 || episode.targetSeconds > 600) throw new Error('Bölüm hedefi 300–600 saniye olmalıdır.');
    for (const scene of episode.scenes) for (const clip of scene.clips) {
      if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 25) throw new Error('Her klip 0 saniyeden uzun ve en fazla 25 saniye olmalıdır.');
      if (clip.references.length > 5) throw new Error('Bir klipte en fazla 5 referans kullanılabilir.');
    }
  }
}
async function save() {
  if (!project || !dirty) return;
  if (imageStateUnknown) throw new Error('Görsel işlem durumu belirsiz; kaydetmeden önce projeyi yeniden açıp durumu kontrol edin.');
  validateProject();
  acceptProject(await api(path(), 'PUT', project));
}
async function run(action, success) {
  if (busy) return;
  showNotice(''); setBusy(true);
  try { await action(); if (success) showNotice(success); }
  catch (error) { showNotice(error.message || 'Bir hata oluştu.', true); }
  finally { setBusy(false); }
}
function canLeave() { return (!dirty && !proposal && !referenceProposal) || window.confirm('Kaydedilmemiş değişiklikler veya bekleyen öneri var. Kaydetmeden ayrılmak istiyor musunuz?'); }
function renderList() {
  projectList.replaceChildren();
  if (!projects.length) { projectList.append(el('p', 'list-empty', 'Henüz proje yok.')); return; }
  projects.forEach(item => {
    const entry = button('', 'project-link' + (project?.id === item.id ? ' active' : ''), () => {
      if (project?.id === item.id || !canLeave()) return;
      run(async () => { const next = await api('/api/projects/' + part(item.id)); proposal = null; referenceProposal = null; contextRequest = null; endingApproval = null; modeChanges.clear(); imageStateUnknown = false; acceptProject(next); });
    });
    entry.append(el('span', 'project-symbol', '▤'), el('span', 'project-name', item.title || 'İsimsiz proje')); projectList.append(entry);
  });
}
function heading(kicker, title, detail) {
  const container = el('div', 'section-heading'); const copy = el('div');
  copy.append(el('div', 'section-kicker', kicker), el('h2', '', title));
  if (detail) copy.append(el('p', 'muted', detail));
  container.append(copy); return container;
}
function renderWelcome() {
  workspace.replaceChildren();
  const hero = el('section', 'welcome');
  hero.append(el('div', 'eyebrow accent', 'FİKRİNİZİN İLK SAHNESİ'), el('h1', '', 'Hayal edin. Sahneye taşıyın.'), el('p', 'welcome-copy', 'Hikâyenizi, sahnelerinizi ve görsel dünyanızı tek bir yerde şekillendirin.'), button('＋ Yeni proje oluştur', 'btn primary', renderNew));
  workspace.append(hero);
}
function renderNew() {
  if (!canLeave()) return;
  project = null; proposal = null; referenceProposal = null; contextRequest = null; endingApproval = null; modeChanges.clear(); imageStateUnknown = false; dirty = false; renderList(); workspace.replaceChildren(); showNotice('');
  const draft = { title: '', idea: '', preferences: {}, kind: 'film' };
  const form = el('form', 'panel new-form');
  form.append(heading('01 / BAŞLANGIÇ', 'Yeni proje', 'Daha sonra tüm detayları düzenleyebilirsiniz.'),
    field('Proje adı', '', value => { draft.title = value; }),
    field('Fikir', '', value => { draft.idea = value; }, { multiline: true, rows: 5 }),
    selectField('Tür', draft.kind, [['film', 'Film'], ['series', 'Dizi']], value => { draft.kind = value; }));
  const actions = el('div', 'actions'); const submit = el('button', 'btn primary', 'Proje oluştur'); submit.type = 'submit';
  actions.append(button('İptal', 'btn ghost', () => { if (canLeave()) { dirty = false; renderWelcome(); } }), submit); form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.idea.trim()) { showNotice('Proje adı ve fikir gereklidir.', true); return; }
    run(async () => acceptProject(await api('/api/projects', 'POST', draft)), 'Proje oluşturuldu.');
  });
  workspace.append(form);
}
function safeImageUrl(value) {
  if (!value) return null;
  try { const url = new URL(value, window.location.href); return url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function renderProject() {
  workspace.replaceChildren();
  const header = el('div', 'page-header'); const copy = el('div');
  copy.append(el('div', 'eyebrow accent', 'PROJE ÇALIŞMA ALANI'), el('h1', '', project.title || 'İsimsiz proje'), el('p', 'muted', 'Videoları harici aracınızda üretin ve montajlayın.'));
  const saveArea = el('div', 'save-area'); const state = el('span', 'save-state'); state.id = 'save-state';
  saveArea.append(state, button('Kaydet', 'btn secondary', () => run(save, 'Proje kaydedildi.')));
  header.append(copy, saveArea); workspace.append(header); updateSaveState();
  const steps = el('div', 'steps');
  [['#idea', 'FİKİR'], ['#assets', 'KARAKTER & MEKÂN'], ['#references', 'REFERANSLAR'], ['#episodes', 'BÖLÜMLER']].forEach(([href, title]) => { const a = el('a', 'step', title); a.href = href; steps.append(a); });
  workspace.append(steps);
  const idea = el('section', 'panel'); idea.id = 'idea'; idea.append(heading('01 / HİKÂYE', 'Fikir ve tercihler'));
  idea.append(el('p', 'muted', 'Model isteğinden önce hedefe ait bağlamı, kullanılan ve dışarıda bırakılan kaynakları inceleyebilirsiniz.'));
  const grid = el('div', 'form-grid');
  grid.append(field('Proje adı', project.title, value => { project.title = value; }, { wide: true }), field('Fikir', project.idea, value => { project.idea = value; }, { multiline: true, wide: true }), selectField('Proje türü', project.kind, [['film', 'Film'], ['series', 'Dizi']], value => { project.kind = value; }));
  const names = { genre: 'Tür', tone: 'Ton / atmosfer', visualStyle: 'Görsel stil' };
  [...new Set([...Object.keys(project.preferences), ...Object.keys(names)])].forEach(key => {
    if (project.preferences[key] != null && typeof project.preferences[key] === 'object') return;
    grid.append(field(names[key] || key, project.preferences[key], value => { project.preferences[key] = value; }));
  });
  [['world', 'Dünya ve kurallar'], ['story', 'Hikâye'], ['relationships', 'İlişkiler'], ['seasonArc', 'Sezon akışı']].forEach(([key, label]) => grid.append(field(label, project.storyBible[key], value => { project.storyBible[key] = value; }, { multiline: true, wide: true })));
  idea.append(grid); workspace.append(idea);
  renderAssets(); renderReferences(); renderEpisodes();
  if (proposal) renderProposal();
  if (contextRequest) renderContextRequest();
  if (endingApproval) renderEndingApproval();
  if (referenceProposal) renderReferenceProposal();
}
function addAndRender(collection, item) { collection.push(item); changed(); renderProject(); }
function addReference(ref) {
  project.refs.push(ref);
  project.references.push({ id: ref.id, name: ref.name, role: ref.role, url: ref.url });
}
function removeAndRender(collection, item, label) {
  if (!window.confirm(label + ' silinsin mi?')) return;
  if (project && (collection === project.characters || collection === project.locations)) {
    const linked = project.refs.some(ref => ref.assetIds.includes(item.id)) || project.episodes.some(episode => episode.scenes.some(scene => scene.clips.some(clip => clip.activeCharacterIds.includes(item.id) || clip.activeLocationId === item.id)));
    if (linked) { showNotice('Bu varlık referanslarda veya kliplerde kullanılıyor. Önce ilgili bağlantıları kaldırın.', true); return; }
  }
  collection.splice(collection.indexOf(item), 1); changed(); renderProject();
}
function renderAssets() {
  const section = el('section', 'panel'); section.id = 'assets'; section.append(heading('02 / DÜNYA', 'Karakterler ve mekânlar', 'Görselleri üretip referans kütüphanesine ekleyebilirsiniz.'));
  const definitions = [
    ['characters', 'Karakter', [['name', 'Ad'], ['appearance', 'Görünüm'], ['costume', 'Kostüm'], ['personality', 'Kişilik'], ['continuity', 'Süreklilik']]],
    ['locations', 'Mekân', [['name', 'Ad'], ['layout', 'Yerleşim'], ['lighting', 'Işık'], ['atmosphere', 'Atmosfer']]]
  ];
  definitions.forEach(([type, label, fields]) => {
    const bar = el('div', 'subheading'); bar.append(el('h3', '', label + 'ler'), button('＋ ' + label, 'btn ghost', () => {
      const item = { id: id(), imagePrompt: '', image: emptyImage() }; fields.forEach(([key]) => { item[key] = key === 'name' ? 'Yeni ' + label.toLocaleLowerCase('tr') : ''; }); addAndRender(project[type], item);
    })); section.append(bar);
    project[type].forEach(item => {
      const card = el('div', 'nested-card'); const grid = el('div', 'form-grid');
      fields.forEach(([key, name]) => grid.append(field(name, item[key], value => { item[key] = value; }, { multiline: key !== 'name' })));
      grid.append(field('Görsel istemi', item.imagePrompt, value => { item.imagePrompt = value; }, { multiline: true, wide: true }));
      card.append(grid, renderImage(type, item));
      card.append(button('Sil', 'btn ghost', () => {
        if (!window.confirm(label + ' ve referans/klip ilişkileri silinsin mi?')) return;
        project[type].splice(project[type].indexOf(item), 1);
        project.refs.forEach(ref => { if ((ref.assetIds || []).includes(item.id)) { ref.assetIds = ref.assetIds.filter(value => value !== item.id); if (!ref.assetIds.length && ref.assetType !== 'group') ref.assetType = 'none'; } });
        project.episodes.forEach(episode => episode.scenes.forEach(scene => scene.clips.forEach(clip => { if (type === 'characters') clip.activeCharacterIds = (clip.activeCharacterIds || []).filter(value => value !== item.id); else if (clip.activeLocationId === item.id) clip.activeLocationId = ''; })));
        changed(); renderProject();
      })); section.append(card);
    });
  });
  workspace.append(section);
}
function renderImage(type, item) {
  const visual = el('div', 'visual asset-visual'); const image = item.image; const url = safeImageUrl(image.url);
  const preview = el('div', 'image-preview');
  if (url) { const img = el('img'); img.src = url; img.alt = (item.name || item.title || 'Varlık') + ' görseli'; preview.append(img); }
  else preview.append(el('span', 'preview-icon', '▧'), el('span', '', 'Henüz görsel yok'));
  visual.append(preview, el('div', 'image-status', 'Durum: ' + image.status));
  if (image.batchId) visual.append(el('p', 'batch-id', 'İşlem: ' + image.batchId));
  if (image.error) visual.append(el('p', 'image-error', String(image.error)));
  const actions = el('div', 'image-actions');
  if (!['starting', 'pending', 'partial'].includes(image.status)) actions.append(button('✳ Görsel oluştur', 'btn primary', () => {
    if (imageStateUnknown) { showNotice('Önce başka bir projeye geçip bu projeyi yeniden açarak görsel durumunu kontrol edin.', true); return; }
    if (!window.confirm('Görsel üretimi ücretli olabilir. İstek başlatılsın mı?')) return;
    run(async () => {
      await save();
      try { acceptProject(await api(path() + '/assets/' + type + '/' + part(item.id) + '/image', 'POST')); }
      catch (error) {
        try { acceptProject(await api(path())); }
        catch { imageStateUnknown = true; throw new Error(error.message + ' Durum yenilenemedi; yeniden denemeden önce projeyi tekrar açıp işlemi kontrol edin.'); }
        throw error;
      }
    }, 'Görsel isteği gönderildi.');
  }));
  if (image.status === 'starting' && !image.batchId) {
    visual.append(el('p', 'image-error', 'Görsel isteği başlangıçta kalmış ve işlem kimliği yok. Sağlayıcıda bir işlem başlatılmış veya ücret alınmış olabilir; durumu sağlayıcıdan kontrol etmeden yeni istek başlatmayın.'));
    actions.append(button('Kontrol ettim, durumu kurtar', 'btn secondary', () => {
      if (imageStateUnknown) { showNotice('Önce projeyi yeniden açıp görsel durumunu kontrol edin.', true); return; }
      if (!window.confirm('Sağlayıcıdaki işlem ve ücret durumunu kontrol ettiğinizi onaylıyor musunuz? Kurtarma yeni görsel oluşturmaz.')) return;
      run(async () => {
        await save();
        try { acceptProject(await api(path() + '/assets/' + type + '/' + part(item.id) + '/recover', 'POST')); }
        catch (error) {
          try { acceptProject(await api(path())); }
          catch { imageStateUnknown = true; throw new Error(error.message + ' Durum yenilenemedi; projeyi tekrar açıp işlemi kontrol edin.'); }
          throw error;
        }
      }, 'Görsel durumu kurtarıldı; gerekirse yeni isteği ayrıca başlatın.');
    }));
  }
  if (image.batchId && ['pending', 'partial'].includes(image.status)) actions.append(button('Durumu kontrol et', 'btn secondary', () => run(async () => {
    if (imageStateUnknown) throw new Error('Önce projeyi yeniden açıp görsel durumunu kontrol edin.');
    await save();
    try { acceptProject(await api(path() + '/assets/' + type + '/' + part(item.id) + '/poll', 'POST')); }
    catch (error) {
      try { acceptProject(await api(path())); }
      catch { imageStateUnknown = true; throw new Error(error.message + ' Durum yenilenemedi; projeyi tekrar açıp işlemi kontrol edin.'); }
      throw error;
    }
  }, 'Görsel durumu güncellendi.')));
  if (url) {
    const link = el('a', 'btn ghost', '↓ Görseli indir'); link.href = url; link.download = (item.name || item.title || 'gorsel'); actions.append(link);
    actions.append(button('Referansa ekle', 'btn secondary', () => { addReference({ id: id(), name: item.name || item.title || 'Görsel', role: type === 'characters' ? 'karakter' : type === 'locations' ? 'mekân' : 'sahne', url: image.url, assetType: type === 'characters' ? 'character' : type === 'locations' ? 'location' : 'none', assetIds: type === 'characters' || type === 'locations' ? [item.id] : [], canonical: false }); changed(); renderProject(); }));
  }
  visual.append(actions); return visual;
}
function renderReferences() {
  const section = el('section', 'panel'); section.id = 'references'; section.append(heading('03 / KÜTÜPHANE', 'Görsel referanslar', 'PNG, JPEG veya WebP yükleyin; kliplerde sıralayıp rol belirleyin.'));
  const upload = el('input'); upload.type = 'file'; upload.accept = 'image/png,image/jpeg,image/webp'; upload.setAttribute('aria-label', 'Referans görseli yükle');
  upload.addEventListener('change', () => {
    const file = upload.files[0]; if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) { showNotice('PNG, JPEG veya WebP dosyası en fazla 20 MB olmalıdır.', true); upload.value = ''; return; }
    run(async () => {
      const result = await api(path() + '/references/upload', 'POST', file, true);
      addReference({ id: id(), name: file.name, role: '', url: result.url, assetType: 'none', assetIds: [], canonical: false }); changed(); renderProject(); setBusy(true);
    }, 'Referans yüklendi; projeyi kaydedin.');
  }); section.append(upload);
  project.refs.forEach(ref => {
    const row = el('div', 'reference-card'); const url = safeImageUrl(ref.url);
    if (url) { const img = el('img', 'reference-thumb'); img.src = url; img.alt = ref.name || 'Referans'; row.append(img); }
    const fields = el('div', 'reference-fields');
    const original = project.references.find(item => item.id === ref.id);
    fields.append(field('Ad', ref.name, value => { ref.name = value; original.name = value; refreshReferenceWarnings(); }), field('Varsayılan rol', ref.role, value => { ref.role = value; original.role = value; refreshReferenceWarnings(); }));
    fields.append(selectField('Varlık ilişkisi', ref.assetType || 'none', [['none', 'İlişkisiz'], ['character', 'Karakter'], ['location', 'Mekân'], ['group', 'Grup']], value => { ref.assetType = value; ref.assetIds = []; renderProject(); }));
    const type = ref.assetType || 'none'; const ids = ref.assetIds || [];
    if (type === 'character' || type === 'location') {
      const assets = type === 'character' ? project.characters : project.locations;
      fields.append(selectField(type === 'character' ? 'Karakter' : 'Mekân', ids[0] || '', [['', 'Seçin'], ...assets.map(asset => [asset.id, asset.name])], value => { ref.assetIds = value ? [value] : []; refreshReferenceWarnings(); }));
    } else if (type === 'group') {
      const members = el('fieldset', 'asset-members'); members.append(el('legend', 'field-label', 'Grup üyeleri'));
      [...project.characters.map(asset => [asset, 'Karakter']), ...project.locations.map(asset => [asset, 'Mekân'])].forEach(([asset, label]) => members.append(checkbox(`${label}: ${asset.name}`, ids.includes(asset.id), checked => { ref.assetIds = checked ? [...ids, asset.id] : ids.filter(value => value !== asset.id); renderProject(); })));
      fields.append(members);
    }
    fields.append(checkbox('Kanonik referans', Boolean(ref.canonical), checked => { ref.canonical = checked; refreshReferenceWarnings(); }));
    row.append(fields, button('Sil', 'btn ghost', () => {
      if (!window.confirm('Referans ve kliplerdeki kullanımları silinsin mi?')) return;
      project.refs.splice(project.refs.indexOf(ref), 1);
      project.references = project.references.filter(item => item.id !== ref.id);
      project.episodes.forEach(episode => episode.scenes.forEach(scene => scene.clips.forEach(clip => { clip.references = clip.references.filter(item => item.id !== ref.id); if (clip.keyframes?.firstId === ref.id) { clip.keyframes.firstId = ''; clip.keyframes.labelsConfirmed = false; } if (clip.keyframes?.lastId === ref.id) { clip.keyframes.lastId = ''; clip.keyframes.labelsConfirmed = false; } })));
      changed(); renderProject();
    })); section.append(row);
  }); workspace.append(section);
}
function episodePath(episodeId) { return path() + '/episodes/' + part(episodeId); }
function scenePath(episodeId, sceneId) { return episodePath(episodeId) + '/scenes/' + part(sceneId); }
function previewDetails(preview) {
  const box = el('div', 'context-details');
  box.append(el('p', 'muted', 'Tahmini bağlam: ' + preview.estimatedChars + ' karakter.'));
  for (const [label, value] of [['Uyarılar', preview.warnings], ['Kullanılan kaynaklar', preview.sources], ['Dışarıda bırakılanlar', preview.omitted], ['Bağlam', preview.context]]) {
    const details = el('details'); details.open = label !== 'Bağlam';
    details.append(el('summary', '', label), el('pre', 'proposal-text', JSON.stringify(value, null, 2))); box.append(details);
  }
  return box;
}
function requestProposal(url, kind, episodeId, sceneId, clipId) {
  if (proposal && !window.confirm('Bekleyen öneri atılıp yeni öneri istensin mi?')) return;
  run(async () => {
    await save();
    const query = new URLSearchParams({ kind });
    if (sceneId) query.set('sceneId', sceneId);
    if (clipId) query.set('clipId', clipId);
    const preview = await api(episodePath(episodeId) + '/context' + (query.size ? '?' + query : ''));
    if (typeof preview.signature !== 'string' || !preview.signature) throw new Error('Bağlam imzası alınamadı; önizlemeyi yeniden alın.');
    contextRequest = { url, kind, episodeId, sceneId, clipId, preview, editVersion };
    renderProject(); setBusy(true);
    document.querySelector('#context-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function renderContextRequest() {
  const request = contextRequest;
  const section = el('section', 'panel proposal'); section.id = 'context-preview';
  section.append(heading('BAĞLAM / ÖNİZLEME', 'Gönderilecek bağlamı inceleyin', 'Bağlamı gözden geçirin; model çağrısı ücretli olabilir.'));
  section.append(previewDetails(request.preview));
  const actions = el('div', 'actions');
  actions.append(button('Vazgeç', 'btn ghost', () => { contextRequest = null; renderProject(); }), button('Model isteğine devam et', 'btn primary', () => {
    if (dirty || editVersion !== request.editVersion) { showNotice('Bağlam önizlemesinden sonra değişiklik yapıldı. Tekrar önizleme alın.', true); return; }
    if (proposal && !window.confirm('Bekleyen öneri atılıp yeni öneri oluşturulsun mu?')) return;
    const warnings = request.preview.warnings;
    if (warnings?.length && !window.confirm('Bağlam uyarıları:\n' + JSON.stringify(warnings, null, 2) + '\nBu uyarılarla devam edilsin mi?')) return;
    if (!window.confirm('Bu işlem ücretli bir model çağrısı yapabilir. Devam edilsin mi?')) return;
    run(async () => {
      const query = new URLSearchParams({ kind: request.kind });
      if (request.sceneId) query.set('sceneId', request.sceneId);
      if (request.clipId) query.set('clipId', request.clipId);
      const currentPreview = await api(episodePath(request.episodeId) + '/context' + (query.size ? '?' + query : ''));
      if (currentPreview.signature !== request.preview.signature) {
        contextRequest = { ...request, preview: currentPreview };
        renderProject(); setBusy(true);
        throw new Error('Bağlam değişti; güncel önizlemeyi ve uyarıları inceleyip yeniden onaylayın.');
      }
      let result;
      try { result = await api(request.url(), 'POST', { expectedSignature: request.preview.signature, revision: project.revision }); }
      catch (error) {
        if (error.status === 409) throw new Error('Bağlam değişti; yeni önizleme alıp tekrar onaylayın. ' + error.message);
        throw error;
      }
      const clip = request.kind === 'prompt' ? project.episodes.find(item => item.id === request.episodeId).scenes.find(item => item.id === request.sceneId).clips.find(item => item.id === request.clipId) : null;
      proposal = { ...request, data: result.data, preview: result.preview, referenceSignature: clip ? signature(clip) : null };
      contextRequest = null; renderProject(); setBusy(true);
      document.querySelector('#proposal')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (result.preview.signature !== request.preview.signature) throw new Error('Model isteği sırasında bağlam değişti. Kullanılan gerçek bağlamı ve uyarıları inceleyin; öneri korunuyor.');
    }, 'Sonucu gözden geçirin; mevcut içerik henüz değiştirilmedi.');
  })); section.append(actions); workspace.append(section);
}
function requestEndingApproval(episodeId) {
  run(async () => {
    await save();
    const revision = project.revision;
    const version = editVersion;
    const ending = structuredClone(project.episodes.find(item => item.id === episodeId).story.ending);
    const preview = await api(episodePath(episodeId) + '/context?kind=ending');
    if (typeof preview.closureSignature !== 'string' || !preview.closureSignature) throw new Error('Kapanış imzası alınamadı; önizlemeyi yeniden alın.');
    if (dirty || editVersion !== version || project.revision !== revision) throw new Error('Proje değişti; kapanış önizlemesini yeniden alın.');
    endingApproval = { episodeId, ending, preview, revision, editVersion: version };
    renderProject(); setBusy(true);
    document.querySelector('#ending-approval')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function renderEndingApproval() {
  const request = endingApproval;
  const section = el('section', 'panel proposal'); section.id = 'ending-approval';
  section.append(heading('KAPANIŞ / ÖNİZLEME', 'Kaydedilen kapanışı inceleyin', 'Bu kapanışı ve kaynağını kontrol edin; onay ayrı bir işlemdir.'));
  const ending = request.ending;
  for (const [key, label] of [['events', 'Olaylar'], ['characters', 'Karakterlerin durumu'], ['relationships', 'İlişkiler'], ['objects', 'Nesneler'], ['openThreads', 'Açık kalan konular'], ['source', 'Kapanış kaynağı']]) {
    section.append(el('h3', '', label), el('pre', 'proposal-text', key === 'source' ? (ending.source === 'verified' ? 'Kullanıcıca doğrulanmış' : 'Senaryo / plan') : ending[key]));
  }
  section.append(previewDetails(request.preview));
  const actions = el('div', 'actions');
  actions.append(button('Vazgeç', 'btn ghost', () => { endingApproval = null; renderProject(); }), button('Bu kapanışı onayla', 'btn primary', () => {
    if (dirty || editVersion !== request.editVersion || project.revision !== request.revision) { showNotice('Proje önizlemeden sonra değişti. Kapanış önizlemesini yeniden alın.', true); return; }
    if (!window.confirm('Gösterilen kapanışı ve kaynağını onaylıyor musunuz?')) return;
    run(async () => {
      if (dirty || editVersion !== request.editVersion || project.revision !== request.revision) throw new Error('Proje önizlemeden sonra değişti. Kapanış önizlemesini yeniden alın.');
      let updated;
      try { updated = await api(episodePath(request.episodeId) + '/ending/approve', 'POST', { revision: request.revision, expectedSignature: request.preview.closureSignature }); }
      catch (error) {
        if (error.status === 409) throw new Error('Kapanış veya proje değişti; yeni önizleme alıp tekrar onaylayın. ' + error.message);
        throw error;
      }
      endingApproval = null; acceptProject(updated);
    }, 'Kapanış onaylandı.');
  }));
  section.append(actions); workspace.append(section);
}
function renderEnding(episode) {
  const ending = episode.story.ending;
  const box = el('div', 'nested-card ending-card');
  box.append(el('h3', '', 'Bölüm kapanışı'), el('p', 'muted', 'Plan, senaryoda öngörülen kapanıştır; doğrulanmış, sizin gerçekleştiğini teyit ettiğiniz kapanıştır. Model çıktısı kendiliğinden doğrulanmış sayılmaz.'), el('p', ending.stale ? 'reference-warning' : 'muted', ending.stale ? 'Kapanışın dayandığı bilgiler değişmiş olabilir; gözden geçirip yeniden onaylayın.' : ending.approved ? 'Kayıtlı kapanış onaylı; değişiklikler durumu etkileyebilir.' : 'Kapanış henüz onaylanmadı.'));
  const grid = el('div', 'form-grid');
  [['events', 'Olaylar'], ['characters', 'Karakterlerin durumu'], ['relationships', 'İlişkiler'], ['objects', 'Nesneler'], ['openThreads', 'Açık kalan konular']].forEach(([key, label]) => grid.append(field(label, ending[key], value => { ending[key] = value; }, { multiline: true })));
  grid.append(selectField('Kapanış kaynağı', ending.source, [['plan', 'Senaryo / plan'], ['verified', 'Kullanıcıca doğrulanmış']], value => { ending.source = value; }));
  box.append(grid);
  const actions = el('div', 'image-actions');
  actions.append(button('✳ Kapanış öner', 'btn secondary', () => requestProposal(() => episodePath(episode.id) + '/ending/propose', 'ending', episode.id)), button('✳ Süreklilik incelemesi', 'btn secondary', () => requestProposal(() => episodePath(episode.id) + '/review', 'review', episode.id)), button('Kapanışı önizle ve onayla', 'btn primary', () => requestEndingApproval(episode.id)));
  box.append(actions); return box;
}
function renderEpisodes() {
  const section = el('section', 'scenes-section'); section.id = 'episodes';
  const head = heading('04 / ANLATIM', 'Bölümler ve klipler', 'Hedef süre 300–600 saniye; her klip en fazla 25 saniyedir.');
  head.append(button('＋ Bölüm', 'btn secondary', () => addAndRender(project.episodes, { id: id(), title: 'Yeni bölüm', targetSeconds: 300, script: '', story: { goal: '', planned: '', ending: emptyEnding() }, scenes: [] }))); section.append(head);
  project.episodes.forEach((episode, episodeIndex) => {
    const card = el('article', 'panel episode-card'); const title = heading('BÖLÜM ' + (episodeIndex + 1), episode.title || 'Bölüm');
    title.append(button('✳ Senaryo ve sahne öner', 'btn primary', () => requestProposal(() => episodePath(episode.id) + '/plan', 'plan', episode.id))); card.append(title);
    const grid = el('div', 'form-grid');
    grid.append(field('Bölüm adı', episode.title, value => { episode.title = value; }), field('Hedef süre (saniye)', episode.targetSeconds, value => { episode.targetSeconds = value === '' ? NaN : Number(value); }, { type: 'number', min: 300, max: 600, step: 1 }), field('Senaryo', episode.script, value => { episode.script = value; }, { multiline: true, rows: 7, wide: true }));
    grid.append(field('Bölüm hedefi', episode.story.goal, value => { episode.story.goal = value; }, { multiline: true }), field('Planlanan gelişmeler', episode.story.planned, value => { episode.story.planned = value; }, { multiline: true }));
    card.append(grid);
    card.append(renderEnding(episode));
    const summary = el('p', 'duration-summary'); summary.dataset.episodeTotal = episode.id; card.append(summary);
    card.append(button('＋ Sahne', 'btn secondary', () => addAndRender(episode.scenes, { id: id(), title: 'Yeni sahne', description: '', continuity: '', transitionNote: '', clips: [] })));
    episode.scenes.forEach((scene, index) => card.append(renderScene(episode, scene, index)));
    card.append(button('Bölümü sil', 'btn ghost', () => removeAndRender(project.episodes, episode, 'Bölüm ve tüm içeriği'))); section.append(card);
  });
  workspace.append(section); refreshDurationSummaries();
}
function renderScene(episode, scene, index) {
  const card = el('div', 'scene-card nested-scene'); const header = el('div', 'scene-header');
  header.append(el('div', 'scene-title', 'SAHNE ' + String(index + 1).padStart(2, '0')), button('✳ Klip öner', 'btn secondary', () => requestProposal(() => scenePath(episode.id, scene.id) + '/clips/propose', 'clips', episode.id, scene.id))); card.append(header);
  const content = el('div', 'scene-content'); const grid = el('div', 'form-grid');
  grid.append(field('Sahne adı', scene.title, value => { scene.title = value; }), field('Açıklama', scene.description, value => { scene.description = value; }, { multiline: true }), field('Süreklilik', scene.continuity, value => { scene.continuity = value; }, { multiline: true }), field('Geçiş notu', scene.transitionNote, value => { scene.transitionNote = value; }, { multiline: true }));
  content.append(grid, button('＋ Klip', 'btn secondary', () => addAndRender(scene.clips, { id: id(), title: 'Yeni klip', duration: 25, camera: { shot: '', angle: '', movement: '', lens: '', style: '', notes: '' }, startState: '', endState: '', transitionNote: '', imagePrompt: '', videoPrompt: '', mode: 'reference', activeCharacterIds: [], activeLocationId: '', keyframes: { firstId: '', lastId: '', firstLabel: '', lastLabel: '', labelsConfirmed: false }, references: [], referenceSignature: '[]', image: emptyImage() })));
  scene.clips.forEach((clip, clipIndex) => content.append(renderClip(episode, scene, clip, clipIndex)));
  content.append(button('Sahneyi sil', 'btn ghost', () => removeAndRender(episode.scenes, scene, 'Sahne ve klipleri'))); card.append(content); return card;
}
function renderClip(episode, scene, clip, index) {
  const card = el('div', 'nested-card clip-card'); const head = el('div', 'subheading');
  head.append(el('h3', '', 'KLİP ' + (index + 1)), button('Klibi sil', 'btn ghost', () => removeAndRender(scene.clips, clip, 'Klip'))); card.append(head);
  const grid = el('div', 'form-grid');
  grid.append(field('Klip adı', clip.title, value => { clip.title = value; }), field('Süre (saniye)', clip.duration, value => { clip.duration = value === '' ? NaN : Number(value); }, { type: 'number', min: 0.01, max: 25, step: 'any' }));
  [['shot', 'Plan'], ['angle', 'Açı'], ['movement', 'Hareket'], ['lens', 'Lens'], ['style', 'Stil'], ['notes', 'Kamera notları']].forEach(([key, label]) => grid.append(field(label, clip.camera[key], value => { clip.camera[key] = value; })));
  grid.append(field('Başlangıç durumu', clip.startState, value => { clip.startState = value; }, { multiline: true }), field('Bitiş durumu', clip.endState, value => { clip.endState = value; }, { multiline: true }), field('Geçiş notu', clip.transitionNote, value => { clip.transitionNote = value; }, { multiline: true }), field('Görsel istemi', clip.imagePrompt, value => { clip.imagePrompt = value; }, { multiline: true, wide: true }), field('Video promptu', clip.videoPrompt, value => { clip.videoPrompt = value; clip.promptDependencySignature = ''; }, { multiline: true, wide: true }));
  card.append(grid);
  const actions = el('div', 'image-actions');
  actions.append(button('Promptu kopyala', 'btn ghost', async () => {
    try { await navigator.clipboard.writeText(clip.videoPrompt || ''); showNotice('Video promptu kopyalandı.'); } catch (error) { showNotice('Kopyalama başarısız: ' + error.message, true); }
  }), button('Prompt güncelliğini kontrol et', 'btn secondary', () => run(async () => {
    await save();
    const current = project.episodes.find(item => item.id === episode.id)?.scenes.find(item => item.id === scene.id)?.clips.find(item => item.id === clip.id);
    if (!current) throw new Error('Klip artık bulunamıyor.');
    if (current.mode === 'keyframe' && !current.keyframes.firstId) throw new Error('İlk kare seçilmedi; prompt güncelliği doğrulanamıyor.');
    const query = new URLSearchParams({ kind: 'prompt', sceneId: scene.id, clipId: clip.id });
    const preview = await api(episodePath(episode.id) + '/context?' + query);
    if (preview.revision !== project.revision) throw new Error('Proje sunucuda değişti; projeyi yeniden açıp kontrol edin.');
    if (!current.promptDependencySignature) throw new Error('Prompt için kayıtlı bağımlılık imzası yok; güncellik doğrulanamıyor.');
    if (typeof preview.promptDependencySignature !== 'string' || !preview.promptDependencySignature) throw new Error('Sunucu prompt bağımlılık imzası döndürmedi; güncellik doğrulanamıyor.');
    if (preview.promptDependencySignature !== current.promptDependencySignature) throw new Error('Prompt bağımlılıkları değişmiş; promptu gözden geçirin veya yeni öneri alın.');
    showNotice('Kayıtlı prompt bağımlılıkları güncel.');
  })), button('✳ Prompt öner', 'btn secondary', () => requestProposal(() => scenePath(episode.id, scene.id) + '/clips/' + part(clip.id) + '/prompt/propose', 'prompt', episode.id, scene.id, clip.id)), button('Promptu mevcut seçimle eşleştir', 'btn ghost', () => {
    if (!window.confirm('Mevcut promptun seçili mod ve girdilerle uyumlu olduğunu kendiniz kontrol ettiniz mi? Bu işlem harici araçta etiketlerin geçerli olduğunu doğrulamaz.')) return;
    clip.referenceSignature = signature(clip); modeChanges.delete(clip.id); changed(); renderProject();
  })); card.append(actions);
  card.append(renderClipReferences(episode, scene, clip), renderImage('clips', clip)); return card;
}
function refreshReferenceWarnings() {
  workspace.querySelectorAll('.clip-references').forEach(box => {
    const clip = project.episodes.flatMap(episode => episode.scenes.flatMap(scene => scene.clips)).find(item => item.id === box.dataset.clipId);
    if (clip) updateReferenceWarning(box, clip);
  });
}
function updateReferenceWarning(box, clip) {
  const warning = box.querySelector('.reference-warning');
  if (!modeChanges.has(clip.id) && clip.referenceSignature === signature(clip)) { if (warning) warning.remove(); }
  else if (!warning) box.insertBefore(el('p', 'reference-warning', 'Klip girdileri, aktif varlıklar veya referans bilgileri prompt imzasıyla uyuşmuyor. Promptu gözden geçirin veya yeni öneri alın. Bu kontrol görsel dosyalarını veya tüm prompt bağlamını doğrulamaz.'), box.firstElementChild.nextSibling);
}
function renderClipReferences(episode, scene, clip) {
  const box = el('div', 'clip-references'); box.append(el('h3', '', 'Klip girdileri'));
  box.dataset.clipId = clip.id; updateReferenceWarning(box, clip);
  const active = el('fieldset', 'asset-members'); active.append(el('legend', 'field-label', 'Klipteki aktif karakterler'));
  project.characters.forEach(asset => active.append(checkbox(asset.name, (clip.activeCharacterIds || []).includes(asset.id), checked => { clip.activeCharacterIds = checked ? [...(clip.activeCharacterIds || []), asset.id] : clip.activeCharacterIds.filter(value => value !== asset.id); updateReferenceWarning(box, clip); })));
  box.append(active, selectField('Aktif mekân', clip.activeLocationId || '', [['', 'Seçilmedi'], ...project.locations.map(asset => [asset.id, asset.name])], value => { clip.activeLocationId = value; updateReferenceWarning(box, clip); }));
  box.append(selectField('Üretim modu', clip.mode || 'reference', [['reference', 'Referans görselleri (en fazla 5)'], ['keyframe', 'İlk / son kare']], value => { clip.mode = value; clip.referenceSignature = ''; modeChanges.add(clip.id); renderProject(); }));
  box.append(el('p', 'muted mode-note', 'Modlar birlikte kullanılmaz. Diğer moddaki seçimler korunur. Harici aracın desteklediği girdi ve etiketleri kendiniz doğrulayın; görsel boyutları burada doğrulanmaz.'));
  if (clip.mode === 'keyframe') {
    const frames = clip.keyframes;
    box.append(el('h3', '', 'İlk kare ve isteğe bağlı son kare'), el('p', 'muted mode-note', 'Gerçek bir video karesi gerekiyorsa harici olarak elde edip referans kütüphanesine yükleyin.'));
    const choices = [['', 'Seçilmedi'], ...project.refs.map(ref => [ref.id, ref.name])];
    box.append(selectField('İlk kare', frames.firstId, choices.filter(([value]) => !value || value !== frames.lastId), value => { frames.firstId = value; frames.labelsConfirmed = false; renderProject(); }), selectField('Son kare (isteğe bağlı)', frames.lastId, choices.filter(([value]) => !value || value !== frames.firstId), value => { frames.lastId = value; frames.labelsConfirmed = false; renderProject(); }),
      field('İlk kare etiketi', frames.firstLabel, value => { frames.firstLabel = value; frames.labelsConfirmed = false; box.querySelector('.label-confirm input').checked = false; updateReferenceWarning(box, clip); }),
      field('Son kare etiketi', frames.lastLabel, value => { frames.lastLabel = value; frames.labelsConfirmed = false; box.querySelector('.label-confirm input').checked = false; updateReferenceWarning(box, clip); }),
      checkbox('Etiketleri harici araçta kendim doğruladım', frames.labelsConfirmed, checked => {
        if (checked && (!frames.firstId || !/^@Image[1-9][0-9]*$/.test(frames.firstLabel) || (frames.lastId && (!/^@Image[1-9][0-9]*$/.test(frames.lastLabel) || frames.lastLabel === frames.firstLabel)))) {
          box.querySelector('.label-confirm input').checked = false; showNotice('İlk kare ve farklı, @Image1 biçiminde etiketler gereklidir; bu biçim harici araçta geçerlilik garantisi değildir.', true); frames.labelsConfirmed = false;
        } else frames.labelsConfirmed = checked;
        updateReferenceWarning(box, clip);
      }));
    box.lastElementChild.classList.add('label-confirm');
    if (!frames.firstId || !frames.labelsConfirmed) box.append(el('p', 'capability-warning', 'İlk kareyi seçin ve kendi verdiğiniz etiketleri doğrulayın. Etiket geçerliliği uygulama tarafından garanti edilmez.'));
    return box;
  }
  box.append(el('h3', '', 'Referans görselleri (en fazla 5)'), el('p', 'muted mode-note', 'Sıra, harici araçtaki etiketlerle otomatik eşleşme veya @Image geçerliliği garantisi değildir.'));
  box.append(button('✳ Referans seçimi öner', 'btn secondary', () => requestReferenceSuggestion(episode, scene, clip)));
  clip.references.forEach((entry, index) => {
    const ref = project.refs.find(item => item.id === entry.id); const row = el('div', 'reference-row');
    row.append(el('strong', '', `${index + 1}. ${ref?.name || 'Bulunamayan referans'}`), field('Rol', entry.role, value => { entry.role = value; updateReferenceWarning(box, clip); }),
      button('↑', 'btn ghost', () => { if (index > 0) { [clip.references[index - 1], clip.references[index]] = [clip.references[index], clip.references[index - 1]]; changed(); renderProject(); } }),
      button('↓', 'btn ghost', () => { if (index < clip.references.length - 1) { [clip.references[index + 1], clip.references[index]] = [clip.references[index], clip.references[index + 1]]; changed(); renderProject(); } }),
      button('Kaldır', 'btn ghost', () => { clip.references.splice(index, 1); changed(); renderProject(); }));
    const url = safeImageUrl(ref?.url);
    if (url) { const link = el('a', 'btn ghost', '↓ İndir'); link.href = url; link.download = `referans-${index + 1}`; row.append(link); }
    box.append(row);
  });
  const available = project.refs.filter(ref => !clip.references.some(entry => entry.id === ref.id));
  if (available.length && clip.references.length < 5) {
    const select = el('select'); select.setAttribute('aria-label', 'Eklenecek referans');
    available.forEach(ref => { const option = el('option', '', ref.name); option.value = ref.id; select.append(option); });
    const row = el('div', 'reference-add'); row.append(select, button('Referans ekle', 'btn secondary', () => { const ref = available.find(item => item.id === select.value); if (ref) { clip.references.push({ id: ref.id, role: ref.role }); changed(); renderProject(); } })); box.append(row);
  }
  return box;
}
function requestReferenceSuggestion(episode, scene, clip) {
  if (referenceProposal && !window.confirm('Bekleyen referans önerisi değiştirilsin mi?')) return;
  run(async () => {
    await save();
    const url = scenePath(episode.id, scene.id) + '/clips/' + part(clip.id) + '/references';
    const result = await api(url + '/suggest');
    referenceProposal = { url, ...result, selected: result.suggestion.selected.map(entry => ({ ...entry })), editVersion };
    renderProject(); setBusy(true);
    document.querySelector('#reference-proposal')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function renderReferenceProposal() {
  const request = referenceProposal; const section = el('section', 'panel proposal'); section.id = 'reference-proposal';
  section.append(heading('REFERANS / ÖNERİ', 'Otomatik seçim önerisi', 'Bu yalnızca bir öneridir; eksikleri, belirsizlikleri ve sınırı inceleyip açıkça onaylayın.'));
  const targetName = target => (target.type === 'character' ? project.characters : project.locations).find(item => item.id === target.id)?.name || target.id;
  for (const target of request.suggestion.missing) section.append(el('p', 'capability-warning', 'Eksik referans: ' + targetName(target) + ' (' + target.type + ')'));
  for (const target of request.suggestion.ambiguous) section.append(el('p', 'capability-warning', 'Belirsiz referans: ' + targetName(target) + ' — adaylar: ' + target.referenceIds.map(id => project.refs.find(ref => ref.id === id)?.name || id).join(', ')));
  for (const [key, label] of [['overflow', 'Beş sınırını aşan'], ['reasons', 'Seçim nedenleri'], ['warnings', 'Uyarılar']]) {
    section.append(el('h3', 'proposal-label', label), el('pre', 'proposal-text', JSON.stringify(request.suggestion[key], null, 2)));
  }
  section.append(el('h3', 'proposal-label', 'Seçilen referanslar (' + request.selected.length + '/5)'));
  if (!request.selected.length) section.append(el('p', 'muted', 'Önerilen referans yok.'));
  request.selected.forEach((entry, index) => {
    const ref = project.refs.find(item => item.id === entry.id); const row = el('div', 'reference-row');
    const role = el('label', 'field'); role.append(el('span', 'field-label', 'Rol')); const input = el('input'); input.value = entry.role; input.maxLength = 300; input.addEventListener('input', () => { entry.role = input.value; }); role.append(input);
    row.append(el('strong', '', `${index + 1}. ${ref?.name || entry.id}`), role,
      button('↑', 'btn ghost', () => { if (index > 0) { [request.selected[index - 1], request.selected[index]] = [request.selected[index], request.selected[index - 1]]; renderProject(); } }),
      button('↓', 'btn ghost', () => { if (index < request.selected.length - 1) { [request.selected[index + 1], request.selected[index]] = [request.selected[index], request.selected[index + 1]]; renderProject(); } }),
      button('Kaldır', 'btn ghost', () => { request.selected.splice(index, 1); renderProject(); })); section.append(row);
  });
  const available = project.refs.filter(ref => !request.selected.some(entry => entry.id === ref.id));
  if (available.length && request.selected.length < 5) {
    const select = el('select'); select.setAttribute('aria-label', 'Öneriye eklenecek referans');
    available.forEach(ref => { const option = el('option', '', ref.name); option.value = ref.id; select.append(option); });
    const row = el('div', 'reference-add'); row.append(select, button('Referans ekle', 'btn secondary', () => {
      const ref = available.find(item => item.id === select.value);
      if (ref && request.selected.length < 5 && !request.selected.some(entry => entry.id === ref.id)) { request.selected.push({ id: ref.id, role: ref.role }); renderProject(); }
    })); section.append(row);
  }
  const actions = el('div', 'actions');
  actions.append(button('İptal', 'btn ghost', () => { referenceProposal = null; renderProject(); }), button('Seçimi onayla ve uygula', 'btn primary', () => {
    if (dirty || editVersion !== request.editVersion) { showNotice('Proje öneriden sonra değişti; kaydedip yeni öneri alın.', true); return; }
    if (request.selected.length > 5) { showNotice('En fazla 5 referans seçilebilir.', true); return; }
    if (!window.confirm('Bu seçim mevcut klip referanslarının yerini alacak. Onaylıyor musunuz?')) return;
    run(async () => {
      const updated = await api(request.url + '/apply', 'POST', { expectedSignature: request.signature, revision: request.revision, selected: request.selected });
      referenceProposal = null; acceptProject(updated);
    }, 'Referans seçimi uygulandı. Promptu gözden geçirin.');
  })); section.append(actions); workspace.append(section);
}
function renderProposal() {
  const section = el('section', 'panel proposal'); section.id = 'proposal';
  const informational = proposal.kind === 'review';
  const ending = proposal.kind === 'ending';
  section.append(heading('ÖNERİ / ÖNİZLEME', informational ? 'Süreklilik incelemesi' : 'Öneriyi inceleyin', informational ? 'İnceleme yalnızca bilgilendirme amaçlıdır; sonucu kendiniz değerlendirin.' : ending ? 'Öneri kapanış metinlerine uygulanır; kaynak ve kapanış onayı ayrı işlemlerdir.' : 'Onay mevcut içeriğin yerini alır ve projeyi kaydeder. İptal mevcut içeriği korur.'));
  if (proposal.kind === 'plan') {
    section.append(el('h3', '', 'Senaryo'), el('pre', 'proposal-text', proposal.data.script));
    proposal.data.scenes.forEach((scene, index) => { const block = el('div', 'proposal-item'); block.append(el('h3', '', `${index + 1}. ${scene.title}`), el('p', '', scene.description), el('p', 'muted', 'Süreklilik: ' + scene.continuity)); section.append(block); });
  } else if (proposal.kind === 'clips') {
    proposal.data.clips.forEach((clip, index) => { const block = el('div', 'proposal-item'); block.append(el('h3', '', `${index + 1}. ${clip.title} · ${clip.duration} sn`), el('pre', 'proposal-text', JSON.stringify(clip, null, 2))); section.append(block); });
  } else section.append(el('pre', 'proposal-text', proposal.kind === 'prompt' ? proposal.data.videoPrompt : JSON.stringify(proposal.data, null, 2)));
  section.append(previewDetails(proposal.preview));
  const actions = el('div', 'actions');
  actions.append(button(informational ? 'Kapat' : 'İptal', 'btn ghost', () => { proposal = null; renderProject(); }));
  if (!informational) actions.append(button(ending ? 'Kapanışa uygula ve kaydet' : 'Onayla ve kaydet', 'btn primary', () => {
    if (!window.confirm(ending ? 'Öneri kapanış metinlerinin yerini alacak ve kaydedilecek; kapanış ayrıca onaylanmalıdır. Devam edilsin mi?' : 'Öneri mevcut içeriğin yerini alacak ve kaydedilecek. Onaylıyor musunuz?')) return;
    run(async () => {
      if (imageStateUnknown) throw new Error('Görsel işlem durumu belirsiz; projeyi yeniden açıp kontrol edin.');
      await save();
      const next = structuredClone(project); const episode = next.episodes.find(item => item.id === proposal.episodeId);
      if (!episode) throw new Error('Bölüm artık bulunamıyor; öneriyi iptal edin.');
      let data;
      if (ending) {
        data = structuredClone(proposal.data);
      } else if (proposal.kind === 'plan') {
        episode.script = proposal.data.script;
        episode.scenes = proposal.data.scenes.map(scene => ({ id: id(), title: scene.title, description: scene.description, continuity: scene.continuity, transitionNote: scene.transitionNote || '', clips: [] }));
        data = { script: episode.script, scenes: episode.scenes };
      } else {
        const scene = episode.scenes.find(item => item.id === proposal.sceneId);
        if (!scene) throw new Error('Sahne artık bulunamıyor; öneriyi iptal edin.');
        if (proposal.kind === 'clips') {
          scene.clips = proposal.data.clips.map(clip => ({ id: id(), title: clip.title, duration: clip.duration, camera: clip.camera, startState: clip.startState, endState: clip.endState, transitionNote: clip.transitionNote || '', imagePrompt: clip.imagePrompt, videoPrompt: clip.videoPrompt, mode: 'reference', activeCharacterIds: [], activeLocationId: '', keyframes: { firstId: '', lastId: '', firstLabel: '', lastLabel: '', labelsConfirmed: false }, references: [], referenceSignature: '[]', image: emptyImage() }));
          data = { clips: scene.clips };
        } else {
          const clip = scene.clips.find(item => item.id === proposal.clipId);
          if (!clip) throw new Error('Klip artık bulunamıyor; öneriyi iptal edin.');
          if (signature(clip) !== proposal.referenceSignature) throw new Error('Klip girdileri öneriden sonra değişti; yeni prompt önerisi alın.');
          clip.videoPrompt = proposal.data.videoPrompt; clip.referenceSignature = proposal.referenceSignature;
          data = { videoPrompt: clip.videoPrompt, referenceSignature: clip.referenceSignature };
        }
      }
      const current = project; project = next;
      try { validateProject(); } finally { project = current; }
      let updated;
      try { updated = await api(episodePath(proposal.episodeId) + '/apply-proposal', 'POST', { kind: proposal.kind, sceneId: proposal.sceneId, clipId: proposal.clipId, expectedSignature: proposal.preview.signature, revision: project.revision, data }); }
      catch (error) {
        if (error.status === 409) throw new Error('Önerinin bağlamı değişmiş veya proje çakışmış olabilir. Öneri ve kaydınız korunuyor; güncel bağlamla yeni öneri alın. ' + error.message);
        throw error;
      }
      if (proposal.kind === 'prompt') modeChanges.delete(proposal.clipId);
      proposal = null; acceptProject(updated);
    }, 'Öneri uygulandı ve kaydedildi.');
  }));
  section.append(actions); workspace.append(section);
}
newButton.addEventListener('click', renderNew);
window.addEventListener('beforeunload', event => { if (dirty || proposal || referenceProposal || busy) { event.preventDefault(); event.returnValue = ''; } });
renderWelcome();
run(async () => { projects = await api('/api/projects'); renderList(); });
