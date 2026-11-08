import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, cueKey, hash, pickVideo, pickSourceTrack, nextBatch, contextBefore, parseVtt, OUR_TRACK_LABEL } from '../src/lib/core.js';

test('cleanText strips tags and entities', () => {
  assert.equal(cleanText('<i>Bonjour</i>  &amp; <c.yellow>salut</c>\n  toi '), 'Bonjour & salut\ntoi');
});

test('cleanText normalises CRLF', () => {
  assert.equal(cleanText("C'est votre première\r\nfois à Singapour ?"), "C'est votre première\nfois à Singapour ?");
});

test('pickVideo prefers the player with subtitle tracks over a same-size preview', () => {
  // Shapes taken from the CANAL+ recon report.
  const preview = { readyState: 4, currentSrc: '', srcObject: {}, clientWidth: 1000, clientHeight: 429, textTracks: [] };
  const player = { readyState: 4, currentSrc: 'https://x.akamaized.net/a.m3u8', srcObject: null, clientWidth: 873, clientHeight: 491,
    textTracks: [{ kind: 'subtitles', label: 'French', language: 'fra', mode: 'showing' }] };
  const idle = { readyState: 0, currentSrc: '', srcObject: null, clientWidth: 0, clientHeight: 0, textTracks: [] };
  assert.equal(pickVideo([idle, preview, player]), player);
  assert.equal(pickVideo([idle]), null);
});

test('cueKey is stable and text-sensitive', () => {
  assert.equal(cueKey(1, 2, 'a'), cueKey(1.001, 2.004, 'a'));
  assert.notEqual(cueKey(1, 2, 'a'), cueKey(1, 2, 'b'));
  assert.match(hash('x'), /^[0-9a-f]{8}$/);
});

test('pickSourceTrack prefers showing French, ignores our track', () => {
  const tracks = [
    { kind: 'subtitles', language: 'en', label: OUR_TRACK_LABEL, mode: 'showing' },
    { kind: 'captions', language: 'fr', label: 'Français (SME)', mode: 'disabled' },
    { kind: 'subtitles', language: 'fr', label: 'Français', mode: 'showing' },
    { kind: 'metadata', language: '', label: 'id3', mode: 'hidden' },
  ];
  assert.equal(pickSourceTrack(tracks).label, 'Français');
  assert.equal(pickSourceTrack([tracks[0], tracks[3]]), null);
  assert.equal(pickSourceTrack([{ kind: 'subtitles', language: '', label: 'Sous-titres', mode: 'hidden' }]).label, 'Sous-titres');
});

test('nextBatch skips done/pending/past cues, sorts, limits', () => {
  const cues = [
    { key: 'c', start: 30, end: 32, fr: 'c' },
    { key: 'a', start: 1, end: 2, fr: 'a' }, // past
    { key: 'b', start: 20, end: 22, fr: 'b', en: 'B' },
    { key: 'd', start: 25, end: 27, fr: 'd' },
    { key: 'e', start: 26, end: 28, fr: 'e', pending: true },
  ];
  assert.deepEqual(nextBatch(cues, 10).map(c => c.key), ['d', 'c']);
  assert.deepEqual(nextBatch(cues, 10, 1).map(c => c.key), ['d']);
});

test('contextBefore returns last translated lines', () => {
  const cues = [1, 2, 3, 4, 5, 6].map(i => ({ start: i, end: i + 0.5, fr: `f${i}`, en: `e${i}` }));
  assert.deepEqual(contextBefore(cues, 5, 2), [{ fr: 'f3', en: 'e3' }, { fr: 'f4', en: 'e4' }]);
});

test('parseVtt handles headers, settings, hours-less times', () => {
  const vtt = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n1\n00:00:01.500 --> 00:00:03.000 line:85%\n<i>Salut</i>\n- Ça va ?\n\n01:02:03.000 --> 01:02:04.250\nOui.\n`;
  assert.deepEqual(parseVtt(vtt).map(({ raw, ...c }) => c), [
    { start: 1.5, end: 3, text: 'Salut\n- Ça va ?' },
    { start: 3723, end: 3724.25, text: 'Oui.' },
  ]);
});

import { parseAttrs, parseMasterSubtitles, pickRendition, parseMediaPlaylist, mergeCues, prefetchOrder } from '../src/lib/core.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fra",URI="audio/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fra",DEFAULT=YES,AUTOSELECT=YES,URI="subs/fr/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French - DST",LANGUAGE="fra",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="subs/fr_dst/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=4000000,SUBTITLES="subs",AUDIO="aud"
video/1080.m3u8
`;
const BASE = 'https://cdn.example.net/__token__exp%3D1~acl%3D%2Fwal%2F*/wal/hls/ANT_1/master.m3u8';

test('parseAttrs handles quoted commas', () => {
  assert.deepEqual(parseAttrs('A=1,B="x, y",C=NO'), { A: '1', B: 'x, y', C: 'NO' });
});

test('parseMasterSubtitles + pickRendition pick the non-SDH French track by label', () => {
  const r = parseMasterSubtitles(MASTER, BASE);
  assert.equal(r.length, 2);
  assert.equal(r[0].uri, 'https://cdn.example.net/__token__exp%3D1~acl%3D%2Fwal%2F*/wal/hls/ANT_1/subs/fr/index.m3u8');
  assert.equal(pickRendition(r, { label: 'French', language: 'fra' }).name, 'French');
  assert.equal(pickRendition(r, { label: 'French - DST', language: 'fra' }).name, 'French - DST');
  assert.equal(pickRendition(r, {}).name, 'French');
  assert.equal(pickRendition([], {}), null);
});

test('parseMediaPlaylist', () => {
  const p = parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXTINF:60,\nseg0.vtt\n#EXTINF:60,\nseg1.vtt\n#EXT-X-ENDLIST\n', BASE);
  assert.equal(p.segments.length, 2);
  assert.ok(p.segments[1].endsWith('/ANT_1/seg1.vtt'));
  assert.equal(p.ended, true);
  assert.equal(p.encrypted, false);
});

test('mergeCues dedupes boundary repeats and sorts', () => {
  const m = mergeCues([
    [{ start: 59, end: 61, text: 'Salut\r\ntoi' }, { start: 10, end: 11, text: 'Un' }],
    [{ start: 59, end: 61, text: 'Salut\ntoi' }, { start: 70, end: 71, text: '' }],
  ]);
  assert.deepEqual(m.map(c => c.text), ['Un', 'Salut\ntoi']);
});

test('prefetchOrder starts near the playhead and wraps', () => {
  const cues = [0, 100, 200, 300].map(s => ({ start: s, end: s + 2, text: String(s) }));
  assert.deepEqual(prefetchOrder(cues, 215).map(c => c.start), [200, 300, 0, 100]);
  assert.deepEqual(prefetchOrder(cues, 9999).map(c => c.start), [0, 100, 200, 300]);
});

import { buildCueText } from '../src/lib/core.js';
test('buildCueText escapes and builds dual cues', () => {
  assert.equal(buildCueText('Tom & Jerry', 'Tom & <Jerry>', 'track'), 'Tom &amp; &lt;Jerry&gt;');
  assert.equal(buildCueText('Salut\ntoi', 'Hi\nyou', 'track-dual'), 'Salut toi\n<c.en><i>Hi you</i></c.en>');
  assert.equal(buildCueText('- Pas vraiment.\n- Pourquoi ?', '- Not really.\n- Why?', 'track-dual'), '- Pas vraiment. - Pourquoi ?\n<c.en><i>- Not really. - Why?</i></c.en>');
});

import { computeOffset } from '../src/lib/core.js';
test('computeOffset: median of text matches, robust to repeated lines', () => {
  const episode = [
    { start: 40.34, fr: 'Ca va, madame ?' }, { start: 73.1, fr: 'Attention.' },
    { start: 80, fr: 'Merci.' }, { start: 227.86, fr: 'Merci.' }, { start: 300, fr: 'Fin.' },
  ];
  const native = [
    { start: 50.34, fr: 'Ca va, madame ?' }, { start: 83.1, fr: 'Attention.' }, { start: 237.86, fr: 'Merci.' }, { start: 9, fr: 'Inconnu' },
  ];
  const r = computeOffset(native, episode);
  assert.equal(r.matches, 3);
  assert.ok(Math.abs(r.offset - 10) < 1e-9);
  assert.deepEqual(computeOffset([], episode), { offset: 0, matches: 0 });
});

import { chooseRendition } from '../src/lib/core.js';
test('chooseRendition: auto picks complete SDH over sparse forced-style French; respects prefs', () => {
  const std = { rendition: { name: 'French', characteristics: '' }, cues: Array(155).fill({}) };
  const sdh = { rendition: { name: 'French - DST', characteristics: 'public.accessibility.transcribes-spoken-dialog' }, cues: Array(620).fill({}) };
  assert.equal(chooseRendition([std, sdh], 'auto').rendition.name, 'French - DST');
  assert.equal(chooseRendition([std, sdh], 'standard').rendition.name, 'French');
  // VOST-like: both complete → standard (no sound descriptions)
  const stdFull = { ...std, cues: Array(600).fill({}) };
  assert.equal(chooseRendition([stdFull, sdh], 'auto').rendition.name, 'French');
  assert.equal(chooseRendition([stdFull, sdh], 'sdh').rendition.name, 'French - DST');
  assert.equal(chooseRendition([{ ...sdh, cues: [] }], 'auto'), null);
});

import { stripSdh } from '../src/lib/core.js';
test('stripSdh removes sound descriptions, music and speaker labels', () => {
  assert.equal(stripSdh('(Rires)'), '');
  assert.equal(stripSdh('[Musique douce]'), '');
  assert.equal(stripSdh('♪ La la la ♪'), '');
  assert.equal(stripSdh('(Il soupire) Tu viens ?'), 'Tu viens ?');
  assert.equal(stripSdh('JEAN : Bonjour.'), 'Bonjour.');
  assert.equal(stripSdh('- MARIE (off) : Viens !\n- (Rires)'), 'Viens !');
  assert.equal(stripSdh('- Oui ?\n- Non.'), '- Oui ?\n- Non.');
  assert.equal(stripSdh("C'est votre première\nfois à Singapour ?"), "C'est votre première\nfois à Singapour ?");
  assert.equal(stripSdh('Attention : ça glisse.'), 'Attention : ça glisse.');
});

import { readFileSync } from 'node:fs';
test('bundled scripts are pure ASCII (Safari may decode them as Latin-1)', () => {
  for (const f of ['dist/background.js', 'dist/content.js']) {
    const bytes = readFileSync(f);
    const bad = bytes.findIndex(b => b > 0x7f);
    assert.equal(bad, -1, `${f} has a non-ASCII byte at offset ${bad}`);
    // and every regex literal still compiles when the file is read as Latin-1
    new Function(bytes.toString('latin1'));
  }
});

import { parseTtml, parseSubtitleFile } from '../src/lib/core.js';
test('stripSdh drops colour-coded and bare sound descriptions', () => {
  assert.equal(stripSdh('Musique intrigante'), '');
  assert.equal(stripSdh('<c.magenta>La mer, qu\'on voit danser</c>'), '');
  assert.equal(stripSdh('<c.red>Klaxon</c>\n<c.white>Attends-moi !</c>'), 'Attends-moi !');
  assert.equal(stripSdh(' J\'aurais pas aimé le savoir \n à l\'avance. '), "J'aurais pas aimé le savoir\nà l'avance.");
  assert.equal(stripSdh('Silence !'), 'Silence !');
  assert.equal(stripSdh('Musique, tu dis ?'), 'Musique, tu dis ?');
});

test('parseVtt accepts short fractions and missing milliseconds', () => {
  const cues = parseVtt('WEBVTT\n\n00:00:01.5 --> 00:00:03\nSalut.\n');
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[1.5, 3, 'Salut.']]);
});

test('parseTtml reads times in several formats and colours', () => {
  const xml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" xmlns:tts="http://www.w3.org/ns/ttml#styling">
  <head><styling><style xml:id="mus" tts:color="#FF00FF"/></styling></head><body><div>
  <p begin="00:00:01.000" end="00:00:03.500">Bonjour<br/>toi.</p>
  <p begin="40000000t" end="60000000t"><span style="mus">Musique douce</span></p>
  <p begin="7s" dur="2s"><span tts:color="red">(Rires)</span> Oui.</p>
  </div></body></tt>`;
  const cues = parseSubtitleFile(xml);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[1, 3.5, 'Bonjour\ntoi.'], [4, 6, 'Musique douce'], [7, 9, '(Rires) Oui.']]);
  assert.equal(stripSdh(cues[1].raw), '');
  assert.equal(stripSdh(cues[2].raw), 'Oui.');
  assert.equal(parseTtml('<tt></tt>').length, 0);
});

test('buildCueText drops empty lines between two-line subtitles', () => {
  assert.equal(buildCueText('- Tu pars où ?\n- En Jordanie.', '- Where are you going?\n\n- In Jordan.', 'track'), '- Where are you going?\n- In Jordan.');
});
