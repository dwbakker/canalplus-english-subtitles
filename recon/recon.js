// CANAL+ subtitle recon (Phase 0).
// Use: play a title in Safari with French subtitles ON, wait ~20 s, open
// Develop → Show Web Inspector → Console, paste this whole file, press Return.
// It prints a JSON report and copies it to the clipboard (if allowed).
// Read-only: it changes nothing on the page except temporarily listening for cues.
(async () => {
  const report = { when: new Date().toISOString(), url: location.href, ua: navigator.userAgent };
  const short = (s, n = 160) => (s && s.length > n ? s.slice(0, n) + '…' : s);

  // 1. Video elements and transport (native HLS vs MSE)
  const videos = [...document.querySelectorAll('video')];
  report.videos = videos.map((v, i) => ({
    i,
    currentSrc: short(v.currentSrc),
    srcIsBlob: (v.currentSrc || '').startsWith('blob:'),
    hasSrcObject: !!v.srcObject,
    hasMediaKeys: !!v.mediaKeys,
    webkitKeys: !!v.webkitKeys,
    currentTime: v.currentTime,
    paused: v.paused,
    size: [v.clientWidth, v.clientHeight],
    canPlayHls: v.canPlayType('application/vnd.apple.mpegurl'),
    textTracks: [...v.textTracks].map((t, j) => ({
      j, kind: t.kind, label: t.label, language: t.language, mode: t.mode, id: t.id,
      cueCount: t.cues ? t.cues.length : null,
      firstCues: t.cues ? [...t.cues].slice(0, 3).map(c => ({ s: c.startTime, e: c.endTime, text: short(c.text, 80) })) : null,
      cueRange: t.cues && t.cues.length ? [t.cues[0].startTime, t.cues[t.cues.length - 1].endTime] : null,
    })),
  }));

  // 2. Watch active cues for 8 s on the showing/hidden tracks
  report.liveCues = [];
  const v = videos.find(x => !x.paused) || videos[0];
  if (v) {
    const tracks = [...v.textTracks].filter(t => t.mode !== 'disabled');
    const handlers = tracks.map(t => {
      const h = () => report.liveCues.push({
        track: t.label || t.language, at: v.currentTime,
        active: [...(t.activeCues || [])].map(c => ({ s: c.startTime, e: c.endTime, text: short(c.text, 80) })),
      });
      t.addEventListener('cuechange', h);
      return [t, h];
    });
    // also: how far ahead are cues buffered?
    await new Promise(r => setTimeout(r, 8000));
    handlers.forEach(([t, h]) => t.removeEventListener('cuechange', h));
    report.cueLookahead = tracks.map(t => ({
      track: t.label || t.language,
      secondsAhead: t.cues && t.cues.length ? t.cues[t.cues.length - 1].endTime - v.currentTime : null,
    }));
  }

  // 3. Subtitle-looking DOM nodes (RxPlayer html mode / OnePlayer custom rendering)
  const sel = '.rxp-texttrack-region, .rxp-texttrack-p, [class*="subtit" i], [class*="texttrack" i], [class*="caption" i], [class*="sous-titre" i]';
  report.domSubtitleNodes = [...document.querySelectorAll(sel)].slice(0, 15).map(n => ({
    tag: n.tagName, cls: short(String(n.className), 100), text: short(n.textContent, 80),
  }));
  report.shadowHosts = [...document.querySelectorAll('*')].filter(n => n.shadowRoot).slice(0, 10).map(n => n.tagName);
  report.iframes = [...document.querySelectorAll('iframe')].map(f => short(f.src));

  // 4. Network: manifests and subtitle files seen so far
  const res = performance.getEntriesByType('resource').map(e => ({ name: e.name, type: e.initiatorType }));
  const rx = /m3u8|\.mpd|manifest|\.ism|\.vtt|webvtt|ttml|dfxp|stpp|wvtt|subtit|sous|\.srt|caption/i;
  report.mediaRequests = res.filter(e => rx.test(e.name)).slice(-40).map(e => ({ ...e, name: short(e.name, 220) }));
  report.resourceCount = res.length;

  // 5. Player globals, workers, service worker
  report.windowKeys = Object.keys(window).filter(k => /player|rx|one|canal|hls|shaka|dash/i.test(k)).slice(0, 40);
  report.rxDebugFlag = window.__RX_PLAYER_DEBUG_MODE__ ?? null;
  report.serviceWorker = !!navigator.serviceWorker?.controller;
  report.fullscreenElement = document.fullscreenElement?.tagName || document.webkitFullscreenElement?.tagName || null;

  // 6. Peek at one subtitle file if one was seen (same-origin cookies, read-only GET)
  const sub = report.mediaRequests.find(e => /\.vtt|webvtt|ttml|subtit|sous/i.test(e.name));
  if (sub) {
    try {
      const full = res.find(e => e.name.startsWith(sub.name.replace('…', '')))?.name || sub.name;
      const r = await fetch(full, { credentials: 'include' });
      const ct = r.headers.get('content-type');
      const buf = await r.arrayBuffer();
      const head = new TextDecoder().decode(buf.slice(0, 400));
      report.subtitleSample = { status: r.status, contentType: ct, bytes: buf.byteLength, head };
    } catch (e) { report.subtitleSample = { error: String(e) }; }
  }

  const json = JSON.stringify(report, null, 2);
  window.__canalRecon = json;
  // The site may silence console.log, so show the report in a selectable textarea instead.
  const ta = document.createElement('textarea');
  ta.value = json;
  ta.style.cssText = 'position:fixed;inset:10%;z-index:2147483647;font:12px monospace;background:#fff;color:#000';
  document.body.appendChild(ta);
  ta.select();
  return 'Report shown in a text box on the page: press ⌘C to copy it, reload the page to remove it.';
})();
