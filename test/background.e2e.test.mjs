// Runs the real bundled dist/background.js with mocked browser APIs, HLS CDN and Anthropic API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CDN = 'https://sampled-hlsfairplay1-aka-canalplus.akamaized.net/__token__exp%3D1~acl%3D%2Fwal%2F*~hmac%3Dabc/wal/hls/ANT_1/';
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fra",DEFAULT=YES,URI="subs/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French - DST",LANGUAGE="fra",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog",URI="subs/dst.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="subs"
v.m3u8`;
const lines = Array.from({ length: 130 }, (_, i) => `Réplique numéro ${i}`);
const ts = s => new Date(s * 1000).toISOString().slice(11, 23);
const seg = (from, to) => 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n' +
  lines.slice(from, to).map((l, k) => `${ts((from + k) * 5)} --> ${ts((from + k) * 5 + 3)}\n${l}\r\n`).join('\n');
const files = {
  'ANT_1.m3u8': MASTER,
  'subs/fr.m3u8': '#EXTM3U\n#EXTINF:300,\nfr-0.vtt\n#EXTINF:300,\nfr-1.vtt\n#EXTINF:300,\nfr-2.vtt\n#EXT-X-ENDLIST',
  // overlapping boundaries: cue 60 appears in seg 0 and 1
  'subs/fr-0.vtt': seg(0, 61), 'subs/fr-1.vtt': seg(60, 120), 'subs/fr-2.vtt': seg(120, 130),
  'subs/dst.m3u8': '#EXTM3U\n#EXTINF:900,\ndst-0.vtt\n#EXT-X-ENDLIST',
  'subs/dst-0.vtt': seg(0, 20),
};

function setup({ failFirst = 0, store: initial } = {}) {
  const store = initial ?? { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' };
  const nativeCalls = [];
  const anthropicCalls = [];
  let fails = failFirst;
  const fetchMock = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.anthropic.com/')) {
      const body = JSON.parse(init.body ?? (await input.text()));
      anthropicCalls.push({ body, headers: init.headers });
      if (fails-- > 0) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }), { status: 529, headers: { 'content-type': 'application/json' } });
      await new Promise(r => setTimeout(r, 20));
      const { items } = JSON.parse(body.messages[0].content);
      const text = JSON.stringify({ translations: items.map(i => ({ id: i.id, en: 'EN ' + i.fr })) });
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith(CDN)) {
      const f = files[url.slice(CDN.length)];
      return f == null ? new Response('nope', { status: 404 }) : new Response(f, { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  let listener;
  const browser = {
    storage: { local: {
      async get(keys) { if (keys == null) return { ...store }; return Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, store[k]])); },
      async set(o) { Object.assign(store, o); },
      async remove(keys) { [].concat(keys).forEach(k => delete store[k]); },
    } },
    runtime: {
      onMessage: { addListener: l => (listener = l) },
      // The Mac app's native handler (Apple's translator).
      async sendNativeMessage(app, msg) {
        nativeCalls.push({ app, msg });
        return { ok: true, translations: Object.fromEntries(msg.items.map(i => [i.id, 'APPLE ' + i.text])) };
      },
    },
  };
  const g = Object.fromEntries(['Response','Request','Headers','URL','URLSearchParams','AbortController','AbortSignal','TextEncoder','TextDecoder','ReadableStream','FormData','Blob','File','Event','EventTarget','DOMException','structuredClone','queueMicrotask','setTimeout','clearTimeout','setInterval','clearInterval','crypto','performance','atob','btoa'].map(k => [k, globalThis[k]]));
  const ctx = vm.createContext({ ...g, browser, fetch: fetchMock, console: { ...console, warn() {} }, navigator: { userAgent: 'Safari' } });
  ctx.globalThis = ctx;
  vm.runInContext(readFileSync('dist/background.js', 'utf8'), ctx);
  const send = msg => new Promise(res => listener(msg, {}, res));
  return { store, anthropicCalls, nativeCalls, send };
}

const poll = async (send, msg, until, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const st = await send(msg);
    if (until(st) || Date.now() > end) return st;
    await new Promise(r => setTimeout(r, 25));
  }
};

test('prefetch downloads French rendition, translates whole episode into cache, live path hits cache', async () => {
  const { store, anthropicCalls, send } = setup();
  const msg = { type: 'prefetch', masterUrl: CDN + 'ANT_1.m3u8', label: 'French', language: 'fra', currentTime: 400 };
  const st = await poll(send, msg, s => s.state === 'done' || s.state === 'error');
  assert.equal(st.state, 'done', JSON.stringify(st));
  assert.equal(st.total, 130); // 131 parsed lines, boundary duplicate removed
  assert.equal(anthropicCalls.length, 3); // 60 + 60 + 10
  const first = anthropicCalls[0].body;
  assert.equal(first.model, 'claude-haiku-5-5'); // a saved Opus choice maps to Haiku
  assert.deepEqual(first.output_config.format.type, 'json_schema');
  assert.equal(first.output_config.effort, 'low');
  // first batch starts near the playhead (t=400s → line 76), not at line 0
  assert.equal(JSON.parse(first.messages[0].content).items[0].fr, 'Réplique numéro 76');
  assert.equal(Object.keys(store).filter(k => k.startsWith('tr:')).length, 130);

  // Live path: a cue Safari hands us (CRLF normalised by content script) is served from cache, no API call.
  const r = await send({ type: 'translate', items: [{ id: 'k1', fr: 'Réplique numéro 5' }], context: [] });
  assert.equal(r.ok, true);
  assert.equal(r.translations.k1, 'EN Réplique numéro 5');
  assert.equal(r.cachedCount, 1);
  assert.equal(anthropicCalls.length, 3);
});

test('auto source picks the more complete DST track when French is sparse', async () => {
  files['subs/dst-0.vtt'] = seg(0, 130) + '\n' + Array.from({ length: 70 }, (_, i) => `${ts(700 + i * 5)} --> ${ts(702 + i * 5)}\n(Bruit ${i})\n`).join('\n');
  files['subs/fr-0.vtt'] = seg(0, 20); files['subs/fr-1.vtt'] = 'WEBVTT\n'; files['subs/fr-2.vtt'] = 'WEBVTT\n';
  try {
    const { send } = setup();
    const msg = { type: 'prefetch', masterUrl: CDN + 'ANT_1.m3u8', currentTime: 0, source: 'auto' };
    const st = await poll(send, msg, s => s.state === 'done' || s.state === 'error');
    assert.equal(st.state, 'done', JSON.stringify(st));
    assert.equal(st.source, 'French - DST');
    assert.equal(st.total, 130); // 70 '(Bruit n)' sound descriptions stripped
    const tl = await send({ type: 'episodeCues', masterUrl: CDN + 'ANT_1.m3u8', source: 'auto' });
    assert.equal(tl.cues.length, 130);
    assert.ok(tl.cues.every(c => !/Bruit/.test(c.fr)));
    const std = await poll(send, { ...msg, source: 'standard' }, s => s.state === 'done' || s.state === 'error');
    assert.equal(std.source, 'French');
    assert.equal(std.total, 20);
  } finally {
    files['subs/dst-0.vtt'] = seg(0, 20);
    files['subs/fr-0.vtt'] = seg(0, 61); files['subs/fr-1.vtt'] = seg(60, 120); files['subs/fr-2.vtt'] = seg(120, 130);
  }
});

test('concurrent live request for a line already in flight is not translated twice', async () => {
  const { anthropicCalls, send } = setup();
  const a = send({ type: 'translate', items: [{ id: 'a', fr: 'Bonjour' }, { id: 'b', fr: 'Salut' }], context: [] });
  const b = send({ type: 'translate', items: [{ id: 'x', fr: 'Salut' }], context: [] });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.translations.b, 'EN Salut');
  assert.equal(rb.translations.x, 'EN Salut');
  assert.equal(anthropicCalls.length, 1);
});

test('missing key and 404 playlist are reported, not thrown', async () => {
  const { store, send } = setup();
  const st = await poll(send, { type: 'prefetch', masterUrl: CDN + 'missing.m3u8', label: 'French', language: 'fra', currentTime: 0 }, s => s.state === 'error');
  assert.equal(st.state, 'error');
  assert.match(st.detail, /HTTP 404/);
  delete store.apiKey;
  assert.equal((await send({ type: 'prefetch', masterUrl: CDN + 'x.m3u8' })).state, 'nokey');
  const r = await send({ type: 'translate', items: [{ id: 'a', fr: 'x' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /API key/);
});

test('with no settings saved, Apple translates through the Mac app without an API key', async () => {
  const { anthropicCalls, nativeCalls, send } = setup({ store: {} });
  const r = await send({ type: 'translate', items: [{ id: 'a', fr: 'Bonjour.' }], context: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.stringify(r.translations), JSON.stringify({ a: 'APPLE Bonjour.' }));
  assert.equal(nativeCalls.length, 1);
  assert.equal(anthropicCalls.length, 0);
  const st = await send({ type: 'prefetch', masterUrl: CDN + 'ANT_1.m3u8', label: 'French', language: 'fra', currentTime: 0 });
  assert.notEqual(st.state, 'nokey');
});
