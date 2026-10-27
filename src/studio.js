import { isId } from './storage.js';

const origin = 'https://studio.claude.gg';
const model = 'gpt-image-2.5-sunburst';

export class StudioError extends Error {
  constructor(message, status = 502, retryAfter = null) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

export function createStudio({ apiKey = process.env.STUDIO_API_KEY, fetchImpl = fetch } = {}) {
  async function request(path, options = {}) {
    if (!apiKey) throw new StudioError('STUDIO_API_KEY ayarlanmamış.', 503);
    let response;
    try { response = await fetchImpl(origin + path, { ...options, headers: { Authorization: 'Bearer ' + apiKey, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal: AbortSignal.timeout(60000) }); }
    catch { throw new StudioError('Studio bağlantısı başarısız; ücretli istek işlenmiş olabilir.'); }
    if (!response.ok) {
      let retry = response.headers.get('retry-after');
      if (response.status === 429 && !retry) { try { retry = (await response.json()).error.retry_after; } catch {} }
      retry = /^\d{1,8}$/.test(String(retry)) ? Number(retry) : null;
      throw new StudioError('Studio isteği başarısız (HTTP ' + response.status + ').', response.status === 429 ? 429 : 502, retry);
    }
    return response;
  }
  async function json(path, options) { try { return await (await request(path, options)).json(); } catch (e) { if (e instanceof StudioError) throw e; throw new StudioError('Studio yanıtı geçersiz.'); } }
  return {
    async start(prompt, beforePost = async () => {}) {
      const catalog = await json('/v1/models');
      const entries = Array.isArray(catalog) ? catalog : catalog.data;
      if (!Array.isArray(entries) || !entries.some(item => item.id === model)) throw new StudioError('Studio model kataloğunda gerekli model bulunamadı.');
      await beforePost();
      const result = await json('/v1/images/generations', { method: 'POST', body: JSON.stringify({ model, prompt, generations_count: 1, wait: false }) });
      if (!isId(result.id)) throw new StudioError('Studio batch kimliği geçersiz; ücretli istek işlenmiş olabilir.');
      return result.id;
    },
    async poll(batchId, storage) {
      if (!isId(batchId)) throw new StudioError('Geçersiz batch kimliği.', 400);
      const result = await json('/v1/images/' + encodeURIComponent(batchId));
      if (!Array.isArray(result.data) || !result.data.length) throw new StudioError('Studio batch yanıtı geçersiz.');
      const item = result.data.find(x => x.status === 'completed');
      if (!item) {
        if (result.data.some(x => x.status === 'pending' || x.status === 'processing')) return { status: result.data.some(x => x.status === 'failed') ? 'partial' : 'pending', batchId, url: null, error: null };
        if (result.data.every(x => x.status === 'failed')) return { status: 'error', batchId, url: null, error: 'Görsel üretimi başarısız.' };
        throw new StudioError('Studio batch durumu geçersiz.');
      }
      const imagePath = item.url || item.content_url || item.preview_url;
      let imageUrl;
      try { imageUrl = new URL(imagePath, origin); } catch { throw new StudioError('Studio görsel adresi geçersiz.'); }
      if (imageUrl.origin !== origin || imageUrl.username || imageUrl.password || imageUrl.search || imageUrl.hash || !/^\/images\/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(imageUrl.pathname)) throw new StudioError('Studio görsel adresi geçersiz.');
      const response = await request(imageUrl.pathname);
      const type = response.headers.get('content-type')?.split(';')[0];
      const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      if (!extensions[type]) throw new StudioError('Studio görsel türü geçersiz.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new StudioError('Studio görseli çok büyük.'); chunks.push(chunk); }
      if (!size) throw new StudioError('Studio görseli boş.');
      const url = await storage.saveImage(Buffer.concat(chunks), extensions[type]);
      return { status: 'completed', batchId, url, error: null };
    }
  };
}
