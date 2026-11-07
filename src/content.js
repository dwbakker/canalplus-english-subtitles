// Content script: reads the French text track, asks the background to translate,
// and renders English as a native text track (default) or a DOM overlay.
import { OUR_TRACK_LABEL, cleanText, cueKey, buildCueText, computeOffset, pickVideo, pickSourceTrack, nextBatch, contextBefore } from './lib/core.js';

const api = globalThis.browser ?? globalThis.chrome;
const LOG = (...a) => console.debug('[canal-subs]', ...a);

let settings = { enabled: true, display: 'track', source: 'auto', hasKey: false };
let video = null;
let videoSrc = '';
let srcTrack = null;
const ourTracks = new WeakMap(); // video → TextTrack (addTextTrack can't be undone, so reuse)
let cues = new Map(); // key → {key,start,end,fr,en?,pending?}
let inFlight = 0;
let pausedUntil = 0;
let fatalError = null;
let translatedCount = 0;
let overlay = null;
// What the viewer picked in the CANAL+ subtitle menu: 'en' (our "Anglais" track), 'fr', or 'off'.
// The menu is the switch; we follow it instead of fighting it. Kept across episodes.
let userChoice = 'en';
let lastModes = null; // track modes after our last write, to spot changes made by the menu

// Timeline mode: once the background has downloaded the episode's subtitles, our track is filled
// from that full timeline instead of from the cues Safari hands over (Safari stops delivering
// cues for a hidden track after a seek, and only ~2 s ahead anyway).
let episode = null; // [{start,end,fr,en}] in subtitle-file time
let offset = 0; // video time = file time + offset
let offsetMatches = 0;
let timelineAdded = new Set(); // episode indices already on our track
let lastTimelineFetch = 0;
let timelineComplete = false;
const inTimeline = () => !!episode && episode.some(c => c.en != null);

// ---------- settings ----------
async function loadSettings() {
  const s = await api.storage.local.get(['enabled', 'display', 'source', 'apiKey']);
  const was = settings;
  settings = {
    enabled: s.enabled ?? true,
    display: s.display ?? 'track',
    source: s.source ?? 'auto',
    hasKey: !!s.apiKey,
  };
  fatalError = null;
  // Changing the popup is an explicit request for our subtitles.
  if (settings.enabled && (!was.enabled || was.display !== settings.display)) userChoice = 'en';
  if (!settings.enabled && was.enabled) turnOff();
  if (was.source !== settings.source || was.hasKey !== settings.hasKey) resetTimeline();
  lastModes = null;
  applyDisplay();
}
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('model' in changes) resetTimeline();
  if (['enabled', 'display', 'source', 'apiKey', 'model'].some(k => k in changes)) loadSettings();
});

// ---------- attach to the player ----------
function findVideo() {
  return pickVideo(document.querySelectorAll('video'));
}

// New <video> element, or the same element playing a new stream (CANAL+ reuses its player).
function resetFor(newVideo) {
  LOG('attaching to', newVideo?.currentSrc?.slice(0, 80));
  video = newVideo;
  videoSrc = newVideo?.currentSrc || '';
  srcTrack = null;
  cues = new Map();
  translatedCount = 0;
  inFlight = 0;
  prefetchState = null;
  lastPoll = 0;
  lastModes = null;
  resetTimeline(false);
  const t = video && ourTracks.get(video);
  if (t) for (const c of [...(t.cues || [])]) t.removeCue(c); // our cues belong to the old episode
  renderedDisplay = null;
}

// Forget the downloaded timeline (new episode, other subtitle source or model).
function resetTimeline(rebuild = true) {
  episode = null;
  offset = 0;
  offsetMatches = 0;
  timelineAdded = new Set();
  lastTimelineFetch = 0;
  timelineComplete = false;
  prefetchState = null;
  lastPoll = 0;
  if (rebuild && video) rebuildTrack();
}

function ourTrack() {
  if (!video) return null;
  let t = ourTracks.get(video);
  if (!t) {
    t = video.addTextTrack('subtitles', OUR_TRACK_LABEL, 'en');
    t.mode = 'hidden';
    ourTracks.set(video, t);
  }
  return t;
}

function setMode(track, mode) {
  if (track && track.mode !== mode) track.mode = mode;
}

function turnOff() {
  const t = video && ourTracks.get(video);
  setMode(t, 'hidden');
  if (srcTrack && userChoice === 'en') setMode(srcTrack, 'showing');
}

/** Follow the CANAL+ menu, then make the tracks match the choice. */
function syncModes() {
  const ours = ourTrack();
  const fr = srcTrack;
  if (!ours || !fr || !settings.enabled) return;
  const prev = lastModes;
  if (prev) {
    if (ours.mode === 'showing' && prev.ours !== 'showing') userChoice = 'en';
    else if (fr.mode === 'showing' && prev.fr !== 'showing') userChoice = 'fr';
    else if (ours.mode !== 'showing' && fr.mode !== 'showing' && (prev.ours === 'showing' || prev.fr === 'showing')) userChoice = 'off';
    if (userChoice !== prev.choice) LOG('menu choice →', userChoice);
  }
  const native = settings.display.startsWith('track');
  if (userChoice === 'en') {
    setMode(ours, native ? 'showing' : 'hidden');
    setMode(fr, 'hidden'); // keep French cues loading, but don't draw them
  } else if (userChoice === 'fr') {
    setMode(ours, 'hidden');
  }
  // 'off': leave everything as the menu set it.
  lastModes = { ours: ours.mode, fr: fr.mode, choice: userChoice };
}

function applyDisplay() {
  if (!video) return;
  if (renderedDisplay !== settings.display) rebuildTrack();
  syncModes();
  ensureOverlay();
  if (overlay) overlay.text.style.display = settings.enabled && settings.display === 'overlay' && userChoice === 'en' ? '' : 'none';
}

// Re-create our track's cues when the display mode changes (English only ↔ French + English).
let renderedDisplay = null;
function rebuildTrack() {
  const t = ourTrack();
  if (!t) return;
  for (const c of [...(t.cues || [])]) t.removeCue(c);
  timelineAdded = new Set();
  if (inTimeline()) addTimelineCues(t);
  else for (const c of cues.values()) if (c.en != null) addOurCue(t, c);
  renderedDisplay = settings.display;
}

function addTimelineCues(t) {
  episode.forEach((c, i) => {
    if (c.en == null || timelineAdded.has(i)) return;
    timelineAdded.add(i);
    addOurCue(t, { start: c.start + offset, end: c.end + offset, fr: c.fr, en: c.en });
  });
}

async function refreshTimeline() {
  const st = prefetchState?.state;
  if (st !== 'translating' && st !== 'done') return;
  if (timelineComplete && offsetMatches >= 5) return;
  if (Date.now() - lastTimelineFetch < (st === 'done' ? 10000 : 4000)) return;
  lastTimelineFetch = Date.now();
  const myVideo = video;
  let res;
  try {
    res = await api.runtime.sendMessage({ type: 'episodeCues', masterUrl: video.currentSrc, source: settings.source });
  } catch {
    return;
  }
  if (myVideo !== video || !res?.cues?.length) return;
  const wasTimeline = inTimeline();
  episode = res.cues;
  if (st === 'done' && episode.every(c => c.en != null)) timelineComplete = true;
  const cal = computeOffset([...cues.values()], episode);
  const offsetChanged = cal.matches > 0 && Math.abs(cal.offset - offset) > 0.08;
  if (cal.matches > 0) offset = cal.offset;
  offsetMatches = cal.matches;
  if (!wasTimeline || offsetChanged) {
    LOG('timeline', { cues: episode.length, offset, matches: offsetMatches });
    rebuildTrack(); // replaces any live-added cues, so nothing shows twice
  } else {
    addTimelineCues(ourTrack());
  }
}

function addOurCue(track, c) {
  try {
    track.addCue(new VTTCue(c.start, c.end, buildCueText(c.fr, c.en, settings.display)));
  } catch (e) {
    LOG('addCue failed', e);
  }
}


function tick() {
  const v = findVideo();
  if (v !== video || (v && v.currentSrc && v.currentSrc !== videoSrc)) resetFor(v);
  if (!video || !settings.enabled) return;

  const t = pickSourceTrack(video.textTracks);
  if (t !== srcTrack) {
    srcTrack = t;
    lastModes = null;
    LOG('source track', t && { label: t.label, lang: t.language, kind: t.kind, mode: t.mode });
  }
  if (!srcTrack) return;
  applyDisplay();
  pollPrefetch();
  refreshTimeline();
  publishDebug();
  if (srcTrack.mode === 'disabled') return; // French not loading: nothing to read
  ingest();
  pump();
}

// Debug snapshot readable from the page console (CANAL+ silences console.log):
//   JSON.parse(document.documentElement.dataset.canalSubs)
let lastDebug = '';
function publishDebug() {
  const ours = video && ourTracks.get(video);
  const d = JSON.stringify({
    choice: userChoice,
    display: settings.display,
    frMode: srcTrack?.mode,
    oursMode: ours?.mode,
    oursCues: ours?.cues?.length ?? 0,
    onScreen: ours?.activeCues ? [...ours.activeCues].map(c => c.text) : [],
    frOnScreen: srcTrack?.activeCues ? [...srcTrack.activeCues].map(c => c.text) : [],
    nativeCues: cues.size,
    timeline: episode ? `${episode.filter(c => c.en != null).length}/${episode.length}` : null,
    offset: +offset.toFixed(2),
    offsetMatches,
    prefetch: prefetchState && `${prefetchState.state} ${prefetchState.done ?? ''}/${prefetchState.total ?? ''} ${prefetchState.detail ?? ''}`.trim(),
    error: fatalError,
  });
  if (d !== lastDebug) document.documentElement.dataset.canalSubs = lastDebug = d;
}

// ---------- whole-episode prefetch (runs in background) ----------
let lastPoll = 0;
let prefetchState = null;
async function pollPrefetch() {
  const src = video.currentSrc || '';
  if (!/^https?:/.test(src) || !/\.m3u8/.test(src)) return;
  if (prefetchState && ['done', 'none', 'live', 'unsupported', 'nokey'].includes(prefetchState.state)) return;
  if (Date.now() - lastPoll < 3000) return;
  lastPoll = Date.now();
  const myVideo = video;
  let st;
  try {
    st = await api.runtime.sendMessage({
      type: 'prefetch',
      masterUrl: src,
      label: srcTrack.label,
      language: srcTrack.language,
      currentTime: video.currentTime,
      source: settings.source,
    });
  } catch (e) {
    st = { state: 'error', detail: String(e) };
  }
  if (myVideo !== video || !st) return;
  if (st.state !== prefetchState?.state) LOG('prefetch', st.state, st.detail || '');
  prefetchState = st;
  if (st.state === 'translating' && st.total) status(`Pre-translating episode: ${Math.round((100 * st.done) / st.total)}%`);
  else if (st.state === 'downloading') status('Downloading French subtitles…');
  else if (st.state === 'done') status(`Episode translated ✓${st.source ? ` (${st.source})` : ''}`);
  else if (st.state === 'error') LOG('prefetch error (live translation still works):', st.detail);
}

function ingest() {
  const list = srcTrack.cues;
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const fr = cleanText(c.text);
    if (!fr) continue;
    const key = cueKey(c.startTime, c.endTime, fr);
    if (!cues.has(key)) cues.set(key, { key, start: c.startTime, end: c.endTime, fr });
  }
}

// ---------- translation ----------
async function pump() {
  if (!settings.hasKey) return status('Set your Anthropic API key in the extension popup.', true);
  if (fatalError) return;
  if (Date.now() < pausedUntil) return;
  if (timelineComplete) return; // everything is already translated and on the track
  const maxConcurrent = 2;
  while (inFlight < maxConcurrent) {
    const all = [...cues.values()];
    const batch = nextBatch(all, video.currentTime, translatedCount === 0 ? 10 : 40);
    if (!batch.length) return;
    batch.forEach(c => (c.pending = true));
    inFlight++;
    if (translatedCount === 0) status('Translating subtitles…');
    sendBatch(batch, contextBefore(all, batch[0].start)).finally(() => inFlight--);
  }
}

async function sendBatch(batch, context) {
  const myCues = cues;
  let res;
  try {
    res = await api.runtime.sendMessage({
      type: 'translate',
      items: batch.map(c => ({ id: c.key, fr: c.fr })),
      context,
    });
  } catch (e) {
    res = { ok: false, error: String(e), retryable: true };
  }
  if (myCues !== cues) return; // video changed meanwhile
  batch.forEach(c => (c.pending = false));
  if (!res?.ok) {
    LOG('translate failed', res?.error);
    status(res?.error || 'Translation failed', true);
    if (res?.retryable) pausedUntil = Date.now() + 5000;
    else fatalError = res?.error;
    return;
  }
  const track = ourTrack();
  for (const c of batch) {
    const en = res.translations[c.key];
    if (en == null) continue;
    c.en = en;
    translatedCount++;
    if (!inTimeline()) addOurCue(track, c);
  }
  if (inTimeline()) lastTimelineFetch = 0; // pick the new lines up from the timeline right away
  if (translatedCount && overlay?.badge.dataset.kind !== 'error') status('');
}

// ---------- overlay (dual FR/EN + status badge) ----------
function stableContainer(v) {
  // Highest ancestor that is still roughly the video's size: usually the element the player fullscreens.
  let best = v.parentElement;
  const vw = v.clientWidth, vh = v.clientHeight;
  for (let el = v.parentElement; el && el !== document.body; el = el.parentElement) {
    const r = el.getBoundingClientRect();
    if (r.width >= vw * 0.9 && r.width <= vw * 1.15 && r.height >= vh * 0.9 && r.height <= vh * 1.3) best = el;
  }
  return best;
}

function ensureOverlay() {
  if (!video) return;
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const parent = fs && fs.contains(video) && fs !== video ? fs : stableContainer(video);
  if (overlay && overlay.root.parentElement === parent) return;
  if (!overlay) {
    const root = document.createElement('div');
    root.setAttribute('data-canal-subs', '');
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483646;';
    const text = document.createElement('div');
    text.style.cssText =
      'position:absolute;left:5%;right:5%;bottom:9%;text-align:center;font:600 clamp(16px,2.6vw,38px)/1.25 -apple-system,system-ui,sans-serif;color:#fff;text-shadow:0 0 4px #000,0 0 2px #000;white-space:pre-line;';
    const fr = document.createElement('div');
    fr.style.cssText = 'font-size:0.62em;opacity:0.8;margin-bottom:0.2em;';
    const en = document.createElement('div');
    text.append(fr, en);
    const badge = document.createElement('div');
    badge.style.cssText =
      'position:absolute;top:12px;right:12px;max-width:50%;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.7);color:#fff;font:13px -apple-system,system-ui,sans-serif;display:none;';
    root.append(text, badge);
    overlay = { root, text, fr, en, badge };
  }
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.appendChild(overlay.root);
}

let badgeTimer;
function status(msg, isError = false) {
  ensureOverlay();
  if (!overlay) return;
  const b = overlay.badge;
  clearTimeout(badgeTimer);
  b.textContent = msg ? `CANAL+ EN subs: ${msg}` : '';
  b.dataset.kind = isError ? 'error' : 'info';
  b.style.display = msg ? '' : 'none';
  if (msg && !isError) badgeTimer = setTimeout(() => (b.style.display = 'none'), 6000);
}

function renderOverlay() {
  requestAnimationFrame(renderOverlay);
  if (!overlay || !video || !settings.enabled || settings.display !== 'overlay') return;
  const t = video.currentTime;
  let fr = '', en = '';
  const list = inTimeline() ? episode.map(c => ({ ...c, start: c.start + offset, end: c.end + offset })) : cues.values();
  for (const c of list) {
    if (c.start <= t && t < c.end) {
      fr += (fr ? '\n' : '') + c.fr;
      en += (en ? '\n' : '') + (c.en ?? '…');
    }
  }
  if (overlay.fr.textContent !== fr) overlay.fr.textContent = fr;
  if (overlay.en.textContent !== en) overlay.en.textContent = en;
}

// ---------- boot ----------
document.addEventListener('fullscreenchange', () => ensureOverlay());
document.addEventListener('webkitfullscreenchange', () => ensureOverlay());
loadSettings().then(() => {
  setInterval(tick, 500);
  requestAnimationFrame(renderOverlay);
  LOG('ready');
});
