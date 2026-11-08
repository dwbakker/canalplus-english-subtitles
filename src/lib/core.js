// Pure helpers shared by content and background scripts (unit-tested in test/).

export const OUR_TRACK_LABEL = 'English (auto)';

/** Normalise cue text: strip VTT tags, collapse whitespace. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Stable id for a cue: its timing plus text. */
export function cueKey(start, end, text) {
  return `${start.toFixed(2)}-${end.toFixed(2)}:${hash(text)}`;
}

/** FNV-1a 32-bit hash, hex. Good enough for cache keys. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pick the main player <video>. CANAL+ pages also run muted preview/trailer videos
 * (srcObject, no text tracks) that can be as big as the player, so rank by:
 * has subtitle tracks > has a real src > area.
 */
export function pickVideo(videos) {
  const score = v => {
    const subs = [...(v.textTracks || [])].some(t => (t.kind === 'subtitles' || t.kind === 'captions') && t.label !== OUR_TRACK_LABEL);
    return (subs ? 2e9 : 0) + (v.currentSrc ? 1e9 : 0) + Math.min(v.clientWidth * v.clientHeight, 9e8);
  };
  const live = [...videos].filter(v => v.readyState > 0 || v.currentSrc || v.srcObject);
  live.sort((a, b) => score(b) - score(a));
  return live[0] || null;
}

/** Pick the source track: French subtitles/captions that aren't ours. Prefers a non-SME track. */
export function pickSourceTrack(tracks) {
  const candidates = [...tracks].filter(
    t => (t.kind === 'subtitles' || t.kind === 'captions') && t.label !== OUR_TRACK_LABEL,
  );
  const isFrench = t => /^fr/i.test(t.language || '') || /fran[cç]ais|french/i.test(t.label || '');
  const french = candidates.filter(isFrench);
  const pool = french.length ? french : candidates;
  // Prefer the track the user turned on in the CANAL+ menu.
  return pool.find(t => t.mode === 'showing') || pool.find(t => t.mode === 'hidden') || pool[0] || null;
}

/**
 * Choose the next batch of untranslated cues, nearest to the playhead first.
 * cues: [{key, start, end, fr, en?, pending?}]
 */
export function nextBatch(cues, currentTime, maxSize = 40) {
  const todo = cues.filter(c => c.en == null && !c.pending && c.end >= currentTime - 2);
  todo.sort((a, b) => a.start - b.start);
  return todo.slice(0, maxSize);
}

/** The last few translated lines before a batch, for context. */
export function contextBefore(cues, batchStart, n = 4) {
  return cues
    .filter(c => c.en != null && c.end <= batchStart)
    .sort((a, b) => a.start - b.start)
    .slice(-n)
    .map(c => ({ fr: c.fr, en: c.en }));
}

/**
 * Offset between the downloaded subtitle timeline and the video clock, learned by matching
 * the French text of cues Safari handed us against the downloaded cues. Median → robust to
 * repeated lines like "Merci.". Returns {offset, matches}; offset 0 when nothing matched yet.
 */
export function computeOffset(native, episode) {
  const byText = new Map();
  for (const e of episode) {
    if (!byText.has(e.fr)) byText.set(e.fr, []);
    byText.get(e.fr).push(e.start);
  }
  const diffs = [];
  for (const n of native) {
    const starts = byText.get(n.fr);
    if (!starts) continue;
    let best = null;
    for (const s of starts) {
      const d = n.start - s;
      if (Math.abs(d) < 120 && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) diffs.push(best);
  }
  if (!diffs.length) return { offset: 0, matches: 0 };
  diffs.sort((a, b) => a - b);
  return { offset: diffs[Math.floor(diffs.length / 2)], matches: diffs.length };
}

/** Escape text for use inside a VTTCue (cue text is parsed for tags/entities). */
export function escapeCueText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Join a subtitle's lines into one (CANAL+ wraps at ~40 chars; the player re-wraps if needed). */
export const oneLine = t => String(t).split('\n').map(l => l.trim()).filter(Boolean).join(' ');

/**
 * Text for our native track cue. 'track-dual' = French on one line, English below it on one
 * line in italics (styled smaller via ::cue(.en)), so two rows instead of four.
 */
export function buildCueText(fr, en, display) {
  if (display === 'track-dual') return `${escapeCueText(oneLine(fr))}\n<c.en><i>${escapeCueText(oneLine(en))}</i></c.en>`;
  // Some translators (Apple) double the line break in two-line subtitles; drop empty lines.
  return escapeCueText(String(en).replace(/\n\s*\n/g, "\n"));
}

/**
 * Remove non-dialogue from deaf/hard-of-hearing subtitles: sound descriptions in () or [],
 * music lines (♪), and speaker labels ("JEAN :", "FEMME (off) :"). Returns '' if nothing
 * spoken is left, so the cue can be dropped.
 */
// French deaf/hard-of-hearing subtitles colour-code non-dialogue: red = sound effects, magenta = music.
const SDH_COLOUR = /<c\.[^>]*\b(red|magenta|rouge)\b[^>]*>[\s\S]*?<\/c>|<font[^>]*color=["']?(#?f{2}0{4}|#?f{2}00f{2}|red|magenta)\b[^>]*>[\s\S]*?<\/font>/gi;
// Lines that are only a sound description, with no brackets ("Musique intrigante", "Rires").
const SOUND_LINE = /^-?\s*(musique|rires?|rire|soupirs?|souffle|sonnerie|applaudissements|bruits?|toux|tousse|pleurs?|sanglots?|cris|brouhaha|explosions?|coups? de (feu|sonnette|klaxon)|klaxon|sifflements?|halètements?|grincements?|claquements?|vibrations?|gémissements?|grognements?|chuchotements?|murmures?|ronflements?|aboiements?|tonnerre|sirènes?|générique)\b[^!?:]{0,40}$/i;

export function stripSdh(text) {
  const raw = String(text);
  // Raw cue text carries the colour tags; cleaned text has none.
  const decoloured = /<(c|font)\b/i.test(raw) ? cleanText(raw.replace(SDH_COLOUR, ' ')) : cleanText(raw);
  const lines = decoloured
    .split('\n')
    .map(line => {
      let l = line;
      if (/[♪♫#]/.test(l)) return '';
      l = l.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
      // Speaker label at line start (after an optional dialogue dash): mostly upper-case words + colon.
      l = l.replace(/^(\s*-?\s*)[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ0-9'’ .-]{1,30}\s*:\s*/, '$1');
      l = l.replace(/\s+/g, ' ').trim();
      if (/^-?\s*$/.test(l) || /^[-.…,!?\s]+$/.test(l) || SOUND_LINE.test(l)) return '';
      return l;
    })
    .filter(Boolean);
  // A lone dialogue dash is pointless once the other speaker's line is gone.
  if (lines.length === 1) lines[0] = lines[0].replace(/^-\s*/, '');
  return lines.join('\n');
}

/** Parse an HLS attribute list: KEY=VALUE,KEY="quoted, value" */
export function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

/** Subtitle renditions from an HLS master playlist, with absolute URIs. */
export function parseMasterSubtitles(text, baseUrl) {
  return String(text)
    .split(/\r?\n/)
    .filter(l => l.startsWith('#EXT-X-MEDIA:'))
    .map(l => parseAttrs(l.slice('#EXT-X-MEDIA:'.length)))
    .filter(a => a.TYPE === 'SUBTITLES' && a.URI)
    .map(a => ({
      name: a.NAME || '',
      language: a.LANGUAGE || '',
      characteristics: a.CHARACTERISTICS || '',
      isDefault: a.DEFAULT === 'YES',
      forced: a['FORCED'] === 'YES',
      uri: new URL(a.URI, baseUrl).href,
    }));
}

/** Choose the rendition matching the text track Safari exposes (same NAME, else French non-SDH). */
export function pickRendition(renditions, { label, language } = {}) {
  const list = renditions.filter(r => !r.forced);
  const isFr = r => /^fr/i.test(r.language) || /fran[cç]ais|french/i.test(r.name);
  const sdh = r => /accessibility|describes-music|transcribes-spoken/i.test(r.characteristics) || /DST|SME|sourds/i.test(r.name);
  return (
    list.find(r => label && r.name === label && (!language || r.language === language)) ||
    list.find(r => label && r.name === label) ||
    list.find(r => isFr(r) && !sdh(r)) ||
    list.find(isFr) ||
    null
  );
}

export const isFrenchRendition = r => /^fr/i.test(r.language) || /fran[cç]ais|french/i.test(r.name);
export const isSdhRendition = r =>
  /accessibility|describes-music|transcribes-spoken/i.test(r.characteristics) || /DST|SME|sourds/i.test(r.name);

/**
 * Choose which downloaded French rendition to translate.
 * candidates: [{rendition, cues}], pref: 'auto' | 'standard' | 'sdh'.
 * 'auto' takes the most complete one. Some series' "French" track only covers dialogue that isn't
 * in French (e.g. Singapura: ~155 lines), while the deaf/hard-of-hearing track has everything.
 * Near-ties (within 10%) go to the standard track, which has no sound descriptions.
 */
export function chooseRendition(candidates, pref = 'auto') {
  const ok = candidates.filter(c => c.cues.length);
  if (!ok.length) return null;
  const std = ok.filter(c => !isSdhRendition(c.rendition));
  const sdh = ok.filter(c => isSdhRendition(c.rendition));
  const most = list => list.reduce((a, b) => (b.cues.length > a.cues.length ? b : a), list[0]);
  if (pref === 'standard' && std.length) return most(std);
  if (pref === 'sdh' && sdh.length) return most(sdh);
  const best = most(ok);
  const bestStd = std.length ? most(std) : null;
  if (bestStd && bestStd.cues.length >= best.cues.length * 0.9) return bestStd;
  return best;
}

/** Segment URLs of an HLS media playlist. */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim());
  return {
    segments: lines.filter(l => l && !l.startsWith('#')).map(l => new URL(l, baseUrl).href),
    ended: lines.includes('#EXT-X-ENDLIST'),
    encrypted: lines.some(l => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l)),
    isFmp4: lines.some(l => l.startsWith('#EXT-X-MAP')),
  };
}

/** Merge cues from several segments: drop duplicates (cues repeated across segment boundaries), sort. */
export function mergeCues(lists) {
  const seen = new Set();
  const out = [];
  for (const c of lists.flat()) {
    const text = cleanText(c.text);
    if (!text) continue;
    const k = `${c.start.toFixed(2)}|${text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ start: c.start, end: c.end, text, raw: c.raw ?? c.text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Order for pre-translation: from just before the playhead to the end, then the beginning. */
export function prefetchOrder(cues, approxTime = 0) {
  let i = cues.findIndex(c => c.end >= approxTime - 20);
  if (i < 0) i = 0;
  return cues.slice(i).concat(cues.slice(0, i));
}

/** Minimal WebVTT parser (for network-captured files / tests). */
export function parseVtt(text) {
  const out = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
  const ts = s => {
    const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/);
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +`0.${m[4]}` : 0);
  };
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = ts(a);
    const end = ts(b.split(/\s+/).filter(Boolean)[0] || '');
    const raw = lines.slice(i + 1).join('\n');
    const body = cleanText(raw);
    if (!Number.isNaN(start) && !Number.isNaN(end) && body) out.push({ start, end, text: body, raw });
  }
  return out;
}

/** Minimal TTML/IMSC parser (plain XML subtitle segments). Colour spans become <c.colour> tags. */
export function parseTtml(xml) {
  const doc = String(xml);
  const attr = (tag, name) => tag.match(new RegExp(`\\b(?:[\\w-]+:)?${name}="([^"]*)"`))?.[1];
  const head = doc.match(/<tt\b[^>]*>/)?.[0] || '';
  const tickRate = +(attr(head, 'tickRate') || 10000000);
  const frameRate = +(attr(head, 'frameRate') || 25);
  // Styles by id, so <p style="s1"> / <span style="s2"> colours can be resolved.
  const colours = {};
  for (const m of doc.matchAll(/<(?:[\w-]+:)?style\b[^>]*>/g)) {
    const id = attr(m[0], 'id');
    const col = attr(m[0], 'color');
    if (id && col) colours[id] = col;
  }
  const colourName = tag => {
    const col = (attr(tag, 'color') || colours[attr(tag, 'style')] || '').toLowerCase();
    if (/^(red|#f00(0{3})?(ff)?)$/.test(col) || /^#ff0000/.test(col)) return 'red';
    if (/^(magenta|fuchsia|#f0f(f{0,3})?)$/.test(col) || /^#ff00ff/.test(col)) return 'magenta';
    return null;
  };
  const time = t => {
    if (!t) return NaN;
    let m = t.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +`0.${m[4]}` : 0);
    m = t.match(/^(\d+):(\d{2}):(\d{2}):(\d+)$/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / frameRate;
    m = t.match(/^([\d.]+)(h|m|s|ms|t|f)$/);
    if (m) return +m[1] * { h: 3600, m: 60, s: 1, ms: 0.001, t: 1 / tickRate, f: 1 / frameRate }[m[2]];
    return NaN;
  };
  const out = [];
  for (const m of doc.matchAll(/<(?:[\w-]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?p>/g)) {
    const pTag = `<p${m[1]}>`;
    const start = time(attr(pTag, 'begin'));
    let end = time(attr(pTag, 'end'));
    if (Number.isNaN(end)) end = start + time(attr(pTag, 'dur'));
    const pColour = colourName(pTag);
    let raw = m[2]
      .replace(/<(?:[\w-]+:)?br\s*\/?>/g, '\n')
      .replace(/<(?:[\w-]+:)?span\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?span>/g, (_, a, inner) => {
        const c = colourName(`<span${a}>`);
        return c ? `<c.${c}>${inner}</c>` : inner;
      })
      .replace(/<(?!\/?c[.>])[^>]+>/g, '')
      .replace(/\s*\n\s*/g, '\n');
    if (pColour) raw = `<c.${pColour}>${raw}</c>`;
    const text = cleanText(raw);
    if (!Number.isNaN(start) && !Number.isNaN(end) && text) out.push({ start, end, text, raw });
  }
  return out;
}

/** Parse one subtitle segment, WebVTT or TTML. */
export function parseSubtitleFile(text) {
  const t = String(text).replace(/^\uFEFF/, '').trimStart();
  return /^<(\?xml|tt\b|[\w-]+:tt\b)/.test(t) ? parseTtml(t) : parseVtt(t);
}
