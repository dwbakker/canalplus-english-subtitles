// Background script: translation via Claude + cache in storage.local.
import Anthropic from '@anthropic-ai/sdk';
import { hash, parseMasterSubtitles, isFrenchRendition, isSdhRendition, stripSdh, chooseRendition, parseMediaPlaylist, parseSubtitleFile, mergeCues, prefetchOrder } from './lib/core.js';

const api = globalThis.browser ?? globalThis.chrome;

export const DEFAULTS = {
  enabled: true,
  apiKey: '',
  model: 'claude-opus-5-5',
  display: 'track', // 'track' (native, works in fullscreen) | 'overlay' (FR + EN DOM overlay)
};

async function settings() {
  const s = await api.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

const SYSTEM = `You translate French TV/film subtitles into natural, idiomatic English subtitles.
Rules:
- Translate each item's "fr" into "en", keeping the same "id". Return every id exactly once.
- Keep it short enough to read on screen; keep line breaks (\\n) where the French has them.
- Subtitles often split one sentence across items: translate so each item reads naturally in order, without moving meaning between items.
- Keep names, places and on-screen tone (slang, profanity, formality). Keep sound/speaker cues like [RIRES] translated as [LAUGHS], "- " dialogue dashes as-is.
- "context" gives earlier lines for reference only; do not translate it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, en: { type: 'string' } },
        required: ['id', 'en'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

const cacheKey = (fr, model) => `tr:${model}:${hash(fr)}:${fr.length}`;

async function translateWithClaude({ items, context }, s) {
  const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true, maxRetries: 3 });
  const response = await client.messages.create({
    model: s.model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify({ context, items }) }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this batch');
  if (response.stop_reason === 'max_tokens') throw new Error('Response cut off (max_tokens)');
  const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(text);
  return Object.fromEntries(parsed.translations.map(t => [t.id, t.en]));
}

// Apple's on-device translator, reached through the Mac app that contains this extension
// (apple/). Safari routes native messages to the containing app whatever id is passed.
const NATIVE_APP = 'io.github.dwbakker.canalplus-subtitles';
export const APPLE = 'apple';
const needsKey = model => model !== APPLE;

class ProviderError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

async function translateWithApple({ items }) {
  let res;
  try {
    res = await api.runtime.sendNativeMessage(NATIVE_APP, { type: 'translate', items: items.map(it => ({ id: it.id, text: it.fr })) });
  } catch {
    throw new ProviderError('Apple translation needs the Mac app version of the extension (see the README).');
  }
  if (!res?.ok) throw new ProviderError(res?.error || 'Apple translation failed.', !!res?.retryable);
  return res.translations;
}

const isRetryable = err =>
  !!err?.retryable || err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError;

function describeError(err) {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid Anthropic API key — check the extension popup.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'API key lacks permission for this model.';
  if (err instanceof Anthropic.NotFoundError) return 'Model not found — pick another in the popup.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API — retrying later.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return String(err?.message ?? err);
}

// cacheKey → Promise<string|undefined> for lines currently being translated, so the
// live path and the whole-episode prefetch never pay for the same line twice.
const inFlight = new Map();

/** items: [{id, fr}] → {id: en} using cache, then in-flight requests, then Claude for the rest. */
async function translate(msg) {
  const s = await settings();
  if (needsKey(s.model) && !s.apiKey) throw new Error('No Anthropic API key set — open the extension popup.');
  const keys = msg.items.map(it => cacheKey(it.fr, s.model));
  const cached = await api.storage.local.get(keys);
  const result = {};
  const waits = [];
  const need = [];
  msg.items.forEach((it, i) => {
    const k = keys[i];
    if (cached[k] != null) result[it.id] = cached[k];
    else if (inFlight.has(k)) waits.push([it, inFlight.get(k)]);
    else need.push(it);
  });
  if (need.length) {
    const translator = s.model === APPLE ? translateWithApple : translateWithClaude;
    const fresh = translator({ items: need, context: msg.context ?? [] }, s);
    for (const it of need) {
      const k = cacheKey(it.fr, s.model);
      const p = fresh.then(f => f[it.id]);
      p.catch(() => {});
      inFlight.set(k, p);
    }
    try {
      const f = await fresh;
      const toStore = {};
      for (const it of need) {
        const en = f[it.id];
        if (typeof en === 'string') {
          result[it.id] = en;
          toStore[cacheKey(it.fr, s.model)] = en;
        }
      }
      await api.storage.local.set(toStore);
    } finally {
      for (const it of need) inFlight.delete(cacheKey(it.fr, s.model));
    }
  }
  for (const [it, p] of waits) {
    const en = await p.catch(() => undefined);
    if (typeof en === 'string') result[it.id] = en;
  }
  return { translations: result, cachedCount: msg.items.length - need.length - waits.length };
}

// ---------- whole-episode prefetch ----------
// Safari hands cues to the page only ~2 s before display, too late for a Claude round trip.
// So we fetch the French WebVTT rendition from the HLS playlist and translate everything into
// the cache up front; the live path then finds each line already translated.
const jobs = new Map(); // masterUrl → job

async function fetchText(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${new URL(url).pathname.split('/').pop()}`);
  return { text: await r.text(), url: r.url || url, type: r.headers.get('content-type') || '' };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function downloadRendition(rendition) {
  const media = await fetchText(rendition.uri);
  const pl = parseMediaPlaylist(media.text, media.url);
  if (!pl.ended) return { rendition, cues: [], live: true };
  if (pl.encrypted || pl.isFmp4) return { rendition, cues: [], unsupported: pl.encrypted ? 'encrypted subtitles' : 'fMP4 subtitles not supported yet' };
  let sample = '';
  const parsed = await pool(pl.segments, 6, async url => {
    const { text } = await fetchText(url);
    if (!sample && text.trim()) sample = text.trim().slice(0, 160);
    return parseSubtitleFile(text);
  });
  const cues = mergeCues(parsed);
  // Describe what came back when nothing parsed, so an unknown format can be identified.
  if (!cues.length) {
    const what = sample ? `starts with: ${JSON.stringify(sample)}` : 'segments were empty';
    return { rendition, cues, unsupported: `no cues parsed from "${rendition.name}" (${pl.segments.length} segments, ${what})` };
  }
  return { rendition, cues };
}

async function runPrefetch(job, { masterUrl, currentTime, source }) {
  const master = await fetchText(masterUrl);
  const french = parseMasterSubtitles(master.text, master.url).filter(r => isFrenchRendition(r) && !r.forced);
  if (!french.length) return Object.assign(job, { state: 'none', detail: 'no French subtitle rendition in playlist' });
  job.state = 'downloading';
  job.detail = `${french.length} French subtitle track(s)`;
  // Download every French rendition (they're small) and pick the most complete / the user's choice.
  const candidates = await Promise.all(french.map(r => downloadRendition(r).catch(err => ({ rendition: r, cues: [], error: err }))));
  if (candidates.every(c => c.live)) return Object.assign(job, { state: 'live', detail: 'live stream: translating as it plays' });
  const chosen = chooseRendition(candidates, source);
  if (!chosen) {
    const why = candidates.find(c => c.unsupported)?.unsupported || candidates.find(c => c.error)?.error;
    if (why instanceof Error) throw why;
    return Object.assign(job, { state: 'unsupported', detail: why || 'no cues parsed from subtitle files' });
  }
  // Deaf/hard-of-hearing tracks: drop sound descriptions, music and speaker labels.
  const cues = isSdhRendition(chosen.rendition)
    ? chosen.cues.map(c => ({ start: c.start, end: c.end, text: stripSdh(c.raw ?? c.text) })).filter(c => c.text)
    : chosen.cues.map(c => ({ start: c.start, end: c.end, text: c.text }));
  job.source = chosen.rendition.name;
  job.detail = `using "${chosen.rendition.name}" (${candidates.map(c => `${c.rendition.name}: ${c.cues.length}`).join(', ')})`;
  console.info('[canal-subs]', job.detail);

  job.state = 'translating';
  job.cues = cues; // kept for episodeCues (not sent with status)
  job.total = cues.length;
  job.done = 0;
  const ordered = prefetchOrder(cues, currentTime);
  const indexOf = new Map(cues.map((c, i) => [c, i]));
  const BATCH = 60;
  const batches = [];
  for (let i = 0; i < ordered.length; i += BATCH) batches.push(ordered.slice(i, i + BATCH));
  await pool(batches, 2, async batch => {
    const first = indexOf.get(batch[0]);
    const context = cues.slice(Math.max(0, first - 4), first).map(c => ({ fr: c.text }));
    const items = batch.map(c => ({ id: String(indexOf.get(c)), fr: c.text }));
    for (let attempt = 0; ; attempt++) {
      try {
        await translate({ items, context });
        break;
      } catch (err) {
        if (!isRetryable(err) || attempt >= 3) throw err;
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    job.done += batch.length;
  });
  job.state = 'done';
}

const jobKey = (model, msg) => `${model}|${msg.source || 'auto'}|${msg.masterUrl}`;

function prefetch(msg, model) {
  const key = jobKey(model, msg);
  let job = jobs.get(key);
  // Retry failed jobs after a minute (cached batches make retries cheap).
  if (job?.state === 'error' && Date.now() - job.at > 60000) job = null;
  if (!job) {
    job = { state: 'starting', total: 0, done: 0, detail: '', at: Date.now() };
    jobs.set(key, job);
    runPrefetch(job, msg).catch(err => {
      job.state = 'error';
      job.at = Date.now();
      job.detail = describeError(err);
      console.warn('[canal-subs] prefetch failed', err);
    });
  }
  const { cues, ...status } = job;
  return status;
}

/** The episode's subtitle timeline with whatever translations are cached so far. */
async function episodeCues(msg, model) {
  const job = jobs.get(jobKey(model, msg));
  if (!job?.cues) return { cues: [] };
  const keys = job.cues.map(c => cacheKey(c.text, model));
  const cached = await api.storage.local.get(keys);
  return {
    total: job.cues.length,
    cues: job.cues.map((c, i) => ({ start: c.start, end: c.end, fr: c.text, en: cached[keys[i]] ?? null })),
  };
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'translate') {
    translate(msg).then(
      r => sendResponse({ ok: true, ...r }),
      err => sendResponse({ ok: false, error: describeError(err), retryable: isRetryable(err) }),
    );
    return true; // async response
  }
  if (msg?.type === 'episodeCues') {
    settings().then(s => episodeCues(msg, s.model)).then(sendResponse, () => sendResponse({ cues: [] }));
    return true;
  }
  if (msg?.type === 'prefetch') {
    settings().then(s => sendResponse(s.apiKey || !needsKey(s.model) ? prefetch(msg, s.model) : { state: 'nokey' }));
    return true;
  }
  if (msg?.type === 'getSettings') {
    settings().then(s => sendResponse({ ...s, apiKey: s.apiKey ? '•••' : '' }));
    return true;
  }
  if (msg?.type === 'clearCache') {
    api.storage.local.get(null).then(all => {
      const keys = Object.keys(all).filter(k => k.startsWith('tr:'));
      return api.storage.local.remove(keys).then(() => sendResponse({ removed: keys.length }));
    });
    return true;
  }
  return false;
});
