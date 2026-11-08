# English Subtitles for CANAL+ (Safari)

A Safari Web Extension that translates the French subtitles of CANAL+ shows into **English**, or shows **French and English together** for learning French, using **Apple's free on-device translator** (Mac app version) or **Claude** through your own Anthropic API key.

> **Not affiliated with CANAL+.** CANAL+ is a trademark of Groupe CANAL+. This is an independent, unofficial tool for personal use with your own subscription. It does not bypass DRM and never touches the video. It only reads the subtitle text CANAL+ already sends to your browser. You are responsible for complying with CANAL+'s terms of use. No warranty.

## Features
- **English, or French + English:** an extra subtitle track that Safari draws itself, so it works in fullscreen and Picture-in-Picture. CANAL+'s own subtitle menu lists it as **"Anglais"**.
- **Whole-episode pre-translation:** when an episode starts, its subtitles are downloaded and translated in the background, so subtitles are ready wherever you jump.
- **Picks the useful French track:**
  - On many French originals, the plain "Français" track only covers dialogue in other languages. The extension uses the deaf and hard-of-hearing track instead and strips its sound descriptions ("(Rires)", "[Musique]", ♪, speaker labels).
  - On dubbed or VOST content, the plain track is complete and is used.
- **Two translators:**
  - **Apple** (Mac app version): free, private, offline. Each line is translated on its own.
  - **Claude**: the most natural dialogue. Batches of about 60 lines are sent with the preceding lines as context.
- **Translations are cached in the browser,** so rewatching costs nothing.

## Requirements
- macOS 26 or later with Safari 26 or later, Node.js 18 or later, and a CANAL+ subscription.
- For the Mac app (permanent install, free Apple translator): Xcode, with your Apple ID added. A free account works.
- For Claude: an **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com). API usage is prepaid and separate from a claude.ai subscription.
  - Rough cost per 50-minute episode: Opus 5.5 about $0.30–0.60, Haiku 5.5 about $0.01.

## Install
```bash
git clone https://github.com/dwbakker/canalplus-english-subtitles.git && cd canalplus-english-subtitles
npm install
```

### Option A: Mac app (permanent, free Apple translator)
1. In Xcode, open Settings → Accounts and add your Apple ID.
2. Run:
   ```bash
   apple/build.sh
   ```
   This builds the extension and the app, installs the app in `~/Applications`, and opens it.
3. The app window walks you through the rest:
   - turn on the extension in Safari, and allow it on `canalplus.com`, `akamaized.net` and, for Claude, `api.anthropic.com`;
   - download French and English for Apple's translator (once, about 100 MB).
4. In the extension's popup, choose **Apple** or **Claude**. On CANAL+, pick **"Anglais"** in the "Langues et sous-titres" menu.

To update, pull and run `apple/build.sh` again.

### Option B: temporary extension (no Xcode, Claude only)
1. Run `npm run build`; the unpacked extension is in `dist/`.
2. In Safari, open Settings → Advanced and enable **"Show features for web developers"**.
3. Open Settings → Developer → **Add Temporary Extension…** and select the `dist` folder.
4. Open Settings → Extensions → *English Subtitles for CANAL+* → **Edit Websites**, and allow `canalplus.com`, `akamaized.net` (CANAL+'s video and subtitle server) and `api.anthropic.com`.
5. Click the toolbar icon, paste your API key, and click **Save**.
6. Reload CANAL+, start a show, and pick **"Anglais"** in the "Langues et sous-titres" menu.

Safari removes temporary extensions when it quits, or after 24 hours. Re-add the `dist` folder when that happens; your settings and cache are kept. After rebuilding, the popup's **Reload** button picks up the new files.

## Settings
| Setting | Options |
|---|---|
| Translator | **Claude** (Opus 5.5 best, Sonnet 5.5, Haiku 5.5 cheapest) · **Apple** (free, on-device; Mac app only). The cache is per translator and model. |
| Show | **English** · **FR + EN** (two rows: French on one line, English below it smaller, in italics) · **Overlay** (both lines drawn over the page; doesn't show in Safari's native fullscreen) |
| From French subtitles | **Automatic** (most complete track) · Standard · Deaf & HoH |

The CANAL+ menu works as the switch:
- **Anglais** shows the extension's track.
- **Français** shows CANAL+'s own French subtitles.
- **Off** shows nothing.

## How it works
In Safari, CANAL+ plays HLS natively with FairPlay DRM. The subtitles are separate, **unencrypted WebVTT** tracks.

1. **Background script** (`src/background.js`):
   - reads the stream's master playlist from the video's URL;
   - downloads every French subtitle track and picks one (`chooseRendition`);
   - strips sound descriptions from deaf and hard-of-hearing text (`stripSdh`);
   - translates with the Anthropic SDK, using structured JSON output and 60 lines per request, starting from the current position;
   - caches results in `storage.local`, keyed by the French text.
2. **Content script** (`src/content.js`):
   - adds an "English (auto)" `TextTrack` to the `<video>` and fills it with the translated timeline;
   - aligns the timing using the French lines Safari exposes (`computeOffset`);
   - follows the CANAL+ subtitle menu;
   - starts over when the player loads a new episode.

Two findings drove this design. Safari only hands subtitle lines to the page about 2 seconds before they're shown, and stops entirely for hidden tracks after a seek. So the extension downloads the subtitle files itself instead of relying on those lines. The full investigation is in [docs/PLAN.md](docs/PLAN.md).

## Privacy
- Your API key is stored only in Safari's extension storage, and is sent only to `api.anthropic.com`.
- With Claude, subtitle text is sent to the Anthropic API for translation. With Apple, it never leaves your Mac.
- No other data is collected or sent anywhere.

## Development
```bash
npm test         # builds, then runs unit and end-to-end tests (Node's test runner)
npm run watch    # rebuilds dist/ on change
```
- `test/background.e2e.test.mjs` runs the real bundled background script against a mocked CDN and a mocked Anthropic API.
- `test/harness/index.html` runs the content script on a local clip with mocked extension APIs. Serve the repo root over HTTP, e.g. `python3 -m http.server`, and open `/test/harness/index.html?hls=1`.
- `apple/` is the Xcode project for the Mac app. Its extension uses the files in `dist/`, so run `npm run build` before building in Xcode (`apple/build.sh` does both). The native side is `SafariWebExtensionHandler.swift`, which answers `browser.runtime.sendNativeMessage` with Apple's Translation framework.
- `tools/make-icons.swift` draws the icons: `swift tools/make-icons.swift`.
- `test/harness/popup.html` shows the popup with mocked storage.
- `recon/` holds diagnostic snippets for inspecting the CANAL+ player from Web Inspector.
- To debug on canalplus.com, paste `document.documentElement.dataset.canalSubs` into the page's console. CANAL+ silences `console.log`, so the extension publishes its state there instead. Background logs are under Develop → Web Extension Background Content.

## Limitations
- Safari only. Chrome and Firefox get DASH from CANAL+, which this extension doesn't handle.
- Live channels have no complete subtitle file, so lines are translated as they arrive and can appear late.
- Translating back to English from the French subtitles of an English-language film approximates the original dialogue; it won't recover the exact lines.

## License
MIT. See [LICENSE](LICENSE).
