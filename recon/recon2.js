// CANAL+ recon #2: (1) do cues arrive ahead of time? (2) can we read the HLS subtitle playlist?
// Use: play an episode with French subtitles ON, at a point where people are talking.
// Paste in the Web Inspector console. It watches for 30 s, then shows a text box with the report.
(async () => {
  const R = { when: new Date().toISOString() };
  const banner = document.createElement('div');
  banner.textContent = 'recon2 running… leave the video playing for 30 s';
  banner.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:#ff0;color:#000;padding:6px 10px;font:14px sans-serif';
  document.body.appendChild(banner);
  try {
  const short = (s, n = 200) => (s && s.length > n ? s.slice(0, n) + '…' : s);
  const v = [...document.querySelectorAll('video')].find(x => x.currentSrc);
  const t = v && [...v.textTracks].find(x => x.mode === 'showing' && /sub|cap/.test(x.kind));
  R.track = t && { label: t.label, kind: t.kind, mode: t.mode };

  // (2) Fetch the master playlist the player loaded and list subtitle renditions.
  try {
    const master = performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.m3u8/.test(n)).pop();
    const mtxt = await (await fetch(master)).text();
    R.masterHead = short(mtxt, 300);
    const subs = mtxt.split('\n').filter(l => /TYPE=SUBTITLES|TYPE=CLOSED-CAPTIONS/.test(l));
    R.subtitleRenditions = subs.map(l => short(l.replace(/URI="[^"]*"/, m => m.slice(0, 120) + '…"'), 300));
    const uriM = subs.find(l => /fr/i.test(l))?.match(/URI="([^"]+)"/);
    if (uriM) {
      const subUrl = new URL(uriM[1], master).href;
      const ptxt = await (await fetch(subUrl)).text();
      const lines = ptxt.split('\n');
      R.subPlaylist = { head: short(ptxt, 400), segmentCount: lines.filter(l => l && !l.startsWith('#')).length, hasKey: /EXT-X-KEY/.test(ptxt) };
      const seg = lines.find(l => l && !l.startsWith('#'));
      if (seg) {
        const segUrl = new URL(seg, subUrl).href;
        const r = await fetch(segUrl);
        const buf = await r.arrayBuffer();
        R.firstSegment = { status: r.status, contentType: r.headers.get('content-type'), bytes: buf.byteLength, head: short(new TextDecoder().decode(buf.slice(0, 500)), 500), host: new URL(segUrl).host };
      }
    }
  } catch (e) { R.playlistError = String(e); }

  // (1) Watch cues for 30 s: when does each cue appear relative to its start time?
  R.samples = [];
  if (t) {
    const seen = new Set();
    R.watchStartedAt = +v.currentTime.toFixed(2);
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const list = t.cues ? [...t.cues] : [];
      for (const c of list) {
        const k = c.startTime + '|' + c.text;
        if (!seen.has(k)) { seen.add(k); R.samples.push({ firstSeenAt: +v.currentTime.toFixed(2), start: +c.startTime.toFixed(2), end: +c.endTime.toFixed(2), text: short(c.text, 60), type: c.constructor.name }); }
      }
      await new Promise(r => setTimeout(r, 250));
    }
    R.cueCountAtEnd = t.cues?.length ?? null;
  }
  } catch (e) { R.fatal = String(e && e.stack || e); }
  banner.remove();
  const fresh = (R.samples || []).filter(s => s.start > (R.watchStartedAt ?? 0) + 1);
  R.summary = fresh.length
    ? `new cues during watch: ${fresh.length}, lead (start - firstSeen) min/avg/max: ${Math.min(...fresh.map(s => s.start - s.firstSeenAt)).toFixed(2)} / ${(fresh.reduce((a, s) => a + (s.start - s.firstSeenAt), 0) / fresh.length).toFixed(2)} / ${Math.max(...fresh.map(s => s.start - s.firstSeenAt)).toFixed(2)} s`
    : 'no new cues seen in 30 s';

  const ta = document.createElement('textarea');
  ta.value = JSON.stringify(R, null, 2);
  ta.style.cssText = 'position:fixed;inset:10%;z-index:2147483647;font:12px monospace;background:#fff;color:#000';
  document.body.appendChild(ta);
  ta.select();
  return 'Report shown in a text box: ⌘C to copy, reload to remove.';
})();
