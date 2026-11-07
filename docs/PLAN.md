# CANAL+ → English subtitles: Safari extension plan

## Goal
Read the French subtitle track that CANAL+ already ships, translate it to English, and show the English text in sync with the video, including in fullscreen. The extension never touches the video or the DRM, only subtitle text and timing.

## What the research established

**CANAL+ player**
- canalplus.com runs on **RxPlayer**, CANAL+'s open-source engine, with an app layer on top called "OnePlayer". The RxPlayer maintainers confirmed this for Chrome and Firefox (rx-player issue #1398).
- **In Safari, RxPlayer plays HLS natively** ("DirectFile" mode, with FairPlay DRM). In that mode subtitles are the browser's own `video.textTracks`, and their cues can be read from page JavaScript. If canalplus.com works this way in Safari, it is the easiest case: no network interception and no format parsing.
- Other subtitle paths we may still meet:
  - In "html" mode, RxPlayer draws subtitles as DOM elements: `.rxp-texttrack-region > p > span` for TTML.
  - Some streams carry subtitles inside MP4 segments (`stpp` = TTML, `wvtt` = WebVTT).
- The player instance is **not** exposed on `window`. `window.__RX_PLAYER_DEBUG_MODE__ = true` turns on verbose logs, including the transport mode and the subtitle URLs.
- Subtitles are a separate text track, not burned into the picture. Many titles have French subtitles for deaf and hard-of-hearing viewers (SME), and some also have a dyslexia-friendly French track.

**Existing extensions**
- **Podstr** (MIT licence) is the best reference.
  - It patches `fetch` and XHR inside the page, and passes the captured data to the extension with a nonce-checked `postMessage`.
  - Its parsers cover VTT, SRT, TTML, HLS and DASH.
  - It translates the whole cue list up front, 50 cues per batch, as JSON `[{id, src}] → [{id, tr}]`, and caches results gzipped.
  - Its overlay attaches to a "stable container" (the nearest ancestor that is roughly the video's width), which keeps it visible in fullscreen. A `requestAnimationFrame` loop keeps it synced to `video.currentTime`.
- **Subadub** (MIT licence) injects its page script with `<script src=…>` as a web-accessible resource. Forum reports say this is more reliable in Safari than `world: "MAIN"` content scripts.
- No existing extension translates CANAL+ subtitles. CANAL+ SubStyler only restyles them.

**Safari constraints**
- **Safari 26+ can load an unpacked extension folder with no Xcode:** Settings → Developer → "Add Temporary Extension…". The extension is removed when Safari quits, or after 24 hours. That is fine for development.
- **Xcode is needed only to package the extension permanently or to call native code.** Calling native code would let us use Apple's on-device Translation framework. (The development Mac had only the Command Line Tools, not Xcode.)
- `webRequest` in Safari can only observe requests and cannot read response bodies. Any interception has to happen inside the page.
- Safari's native video fullscreen hides every DOM overlay. The workaround is to **add our English cues as a real text track** (`video.addTextTrack` + `VTTCue`): Safari draws it natively, fullscreen included. Picture-in-Picture should work the same way.
- Safari has no built-in web translation API. The options are a cloud API called from the extension's background script, or Apple Translation through the Xcode-packaged native handler.

## Architecture

```
page (MAIN world, injected <script src>)      content script (isolated)          background script
───────────────────────────────────────      ─────────────────────────          ─────────────────
SubtitleSource adapters:                      collects cues {id,start,end,fr}    translation queue
  A. video.textTracks reader  (primary)  ──►  dedupes, sends batches        ──►  provider (Claude / DeepL)
  B. fetch/XHR hook for .m3u8/.vtt (lookahead)                                   cache (storage.local)
  C. DOM MutationObserver     (fallback)      ◄── English cues
                                              Renderer:
                                                1. extra TextTrack "English (auto)"  ← works in native fullscreen/PiP
                                                2. optional DOM overlay (styling, dual FR/EN mode)
```

- **Source A (`textTracks`).** Find the active French track and set its mode to `hidden`, so cues load but Safari doesn't draw them. Then read `track.cues` as they arrive. HLS buffers ahead of playback, so cues usually show up tens of seconds early, which gives us time to translate.
- **Source B (lookahead).** Capture the subtitle media playlist (`.m3u8`) from the page's own requests, then fetch every VTT segment so the whole film can be translated as soon as playback starts. We only build this if A turns out to deliver cues too late.
- **Source C (DOM).** Only for the case where OnePlayer draws its own subtitles. It translates each line as it appears, with some delay, so it is a last resort.
- **Translation.**
  - Send batches of about 50 cues, each with the previous few lines as context, and keep cue IDs so timing never drifts.
  - Cache results by hash of the French text, so a rewatch or a cue shared across episodes costs nothing.
  - Providers sit behind one interface: `translate(cues[], context) → cues[]`.
- **Lifecycle.** Watch for single-page navigation (patch `history` and listen to `popstate`) and for the player swapping its `<video>` element. Reset state on each new title.
- **Popup.** On/off toggle, provider choice and API key, display mode (English only or French + English), text size, and a manual offset slider.

## Phases

### Phase 0: live recon in your logged-in Safari (≈15 min, needs you)
I can't log in to CANAL+, so this step needs you.
1. I write `recon.js`, one snippet that dumps a JSON report:
   - native HLS vs MSE, and `currentSrc`
   - the `textTracks` inventory, with cue samples
   - any `.rxp-*` or subtitle DOM nodes
   - manifest and subtitle URLs from `performance.getEntriesByType('resource')`
   - whether Web Workers are in use
2. You play three titles in Safari with French subtitles on: a French series, a VOST film, and a live channel. On each one, paste the snippet into Web Inspector's console and send me the output.
3. The output decides which subtitle source becomes primary. **This is the main unknown in the whole plan.**

### Phase 1: MVP as a temporary extension (no Xcode)
> **Status, 2026-11-07:** scaffolded. Source A (`textTracks`), the native-track renderer, the FR+EN overlay, Claude translation with caching, and the popup are written. Tested in a local harness with a mocked translator. Still untested on canalplus.com and against the real API. The page script (source B) is deferred until Phase 0 shows it's needed: with native HLS, Safari fetches the subtitle segments itself, so a hook on the page's own requests would never see them.

- MV3 manifest:
  - host permissions for `*.canalplus.com`, plus the translation API's domain
  - a background script listed under `"scripts"`, not `service_worker`, because of a Safari debugging bug
- The page script is injected with `<script src>`, and the bridge uses `postMessage` with a nonce.
- Whichever source Phase 0 points to, the renderer as an extra text track, and a translation provider.
- Done when: a CANAL+ episode plays with English subtitles in sync, in windowed and fullscreen mode, and the cache survives a reload.

> **Recon results, 2026-11-07** (Singapura episode):
> - Native HLS with FairPlay: `currentSrc` is an `akamaized.net` `.m3u8` URL.
> - Subtitle tracks are `French` (subtitles, `fra`) and `French - DST` (captions). Cues are `VTTCue`s with CRLF line breaks.
> - CANAL+ doesn't draw any subtitle DOM.
> - Cue lead time is only **~1.9 s**, so source A alone is too late for a Claude round trip.
> - A page-context fetch of the Akamai playlist is blocked by CORS.
> - The page has a muted preview `<video>` (`srcObject`) about the same size as the player.
>
> **Consequences, implemented in v0.2.0:**
> - Source B became "whole-episode pre-translation from the background script", with CDN host permissions.
> - The cache is keyed by French text, so the two sources need no timing alignment.
> - `pickVideo` now prefers the video that has subtitle tracks.

### Phase 2: robustness and comfort
- Fallback sources, single-page navigation and `<video>` swaps, live-channel rolling cues
- Dual FR/EN DOM overlay, styling and offset controls
- Retry and backoff on API errors

### Phase 3 (optional): permanent install and on-device translation
- Install Xcode, then wrap the extension with `xcrun safari-web-extension-packager`.
- Add a native handler that calls Apple's `TranslationSession(installedSource:target:)`. That gives free, offline translation, with somewhat lower quality.
- Without a paid developer account, "Allow unsigned extensions" has to be re-ticked every time Safari launches. With an account ($99/year), the extension can be signed for a truly permanent install.

## Decisions needed
1. ~~Translation provider for the MVP~~ → **Decided: Claude through your own API key.** The key is stored in `storage.local` and is never committed. The provider stays pluggable, so DeepL can be added later.
2. **Source language caveat.** On VOST films (English audio with French subtitles), translating the French back to English won't give the original dialogue. It's still readable, but it's an approximation. Fine?

## Risks
- **OnePlayer may not use native HLS in Safari.** Mitigation: sources B and C; Phase 0 tells us early.
- **Subtitle requests may run in a Web Worker, where the page-level hook can't see them.** Mitigation: rely on `textTracks` or the DOM instead.
- **CANAL+ may update its player and break the selectors.** Mitigation: source A depends only on web standards, not on CANAL+'s own code.
- **Temporary extensions disappear when Safari quits.** That's acceptable during development; Phase 3 fixes it.

## References
- Podstr: https://github.com/aveleazer/podstr (MIT)
- Subadub: https://github.com/rsimmons/subadub (MIT)
- RxPlayer: https://github.com/canalplus/rx-player (issues #1398 and #1150, Safari DirectFile docs)
- Apple, running a Safari web extension (temporary install): https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension
- Safari web extension compatibility: https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility
