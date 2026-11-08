# English Subtitles for CANAL+ (Safari)

A Mac app with a Safari extension that translates the French subtitles of CANAL+ shows into **English**, or shows **French and English together** for learning French. Translation is free and happens on your Mac with Apple's built-in translator. You can switch to Claude for more natural dialogue.

> **Not affiliated with CANAL+.** CANAL+ is a trademark of Groupe CANAL+. This is an independent, unofficial tool for personal use with your own subscription. It does not bypass DRM and never touches the video. It only reads the subtitle text CANAL+ already sends to your browser. You are responsible for complying with CANAL+'s terms of use. No warranty.

## Features
- **English, or French + English:** an extra subtitle track that Safari draws itself, so it works in fullscreen and Picture-in-Picture. CANAL+'s own subtitle menu lists it as **"Anglais"**.
- **Free, private translation by default:** Apple's on-device translator. Nothing leaves your Mac, and it works offline once the languages are downloaded.
- **Optional Claude:** more natural dialogue and slang, using the preceding lines as context. Uses Claude Haiku with your own Anthropic API key, about $0.01 per episode.
- **Whole-episode pre-translation:** when an episode starts, its subtitles are downloaded and translated in the background, so subtitles are ready wherever you jump.
- **Picks the useful French track:**
  - On many French originals, the plain "Français" track only covers dialogue in other languages. The extension uses the deaf and hard-of-hearing track instead and removes its sound descriptions ("(Rires)", "Musique intrigante", ♪, speaker labels).
  - On dubbed or VOST content, the plain track is complete and is used.
- **Translations are cached,** so rewatching is instant, and switching translators back and forth doesn't redo work.

## Install
You need a Mac with **macOS 26 or later**, a CANAL+ subscription, and about 15 minutes the first time. The app is built on your Mac with Xcode, because distributing a ready-made Safari extension app needs a paid Apple developer account.

**1. Get the tools (once)**
- **Xcode**, free from the [App Store](https://apps.apple.com/app/id497799835). Open it once after installing.
- **Node.js** LTS from [nodejs.org](https://nodejs.org), or `brew install node`.
- Your **Apple ID in Xcode**: Xcode → Settings… → Accounts → **+** → Apple Account. A free account works; it signs the app for your own Mac.

**2. Install**
```bash
git clone https://github.com/dwbakker/canalplus-english-subtitles.git
cd canalplus-english-subtitles
./install.sh
```
The script checks each requirement and tells you exactly what to do if something is missing; fix it and run it again. The first time, it may ask you to accept Xcode's license and to pick your team in Xcode (one click).

It builds the app, installs it in `~/Applications`, and opens it.

**3. Finish in the app and Safari**
1. **Quit and reopen Safari.**
2. The app window walks you through two steps:
   - turning on the extension in Safari, and allowing it on `canalplus.com` and `akamaized.net` (CANAL+'s video and subtitle server);
   - downloading French and English for Apple's translator, once.
3. On canalplus.com, start a show and pick **"Anglais"** in the "Langues et sous-titres" menu.

**Update:** in the folder, run `git pull`, then `./install.sh`, then quit and reopen Safari.

**Uninstall:** delete *English Subtitles for CANAL+* from `~/Applications`.

## Settings
Click the **EN** icon in Safari's toolbar.

| Setting | Options |
|---|---|
| Translator | **Apple** (default: free, on your Mac) · **Claude** (Haiku 5.5 with your API key, about $0.01 an episode). To use Claude, also allow `api.anthropic.com` for the extension in Safari, and get a key at [console.anthropic.com](https://console.anthropic.com) (prepaid, separate from a claude.ai subscription). |
| Show | **English** · **FR + EN** (French on one line, English below it smaller, in italics) |
| From French subtitles | **Automatic** (the most complete track) · Standard · Deaf & HoH |

The CANAL+ subtitle menu is the switch:
- **Anglais** shows the extension's track.
- **Français** shows CANAL+'s own French subtitles.
- **Off** shows nothing.

## Troubleshooting
- **Nothing gets translated after installing or updating:** quit and reopen Safari.
- **The extension appears twice in Safari:** remove any temporary copy under Safari → Settings → Developer. `./install.sh` never leaves a second copy behind.
- **"Download French and English first":** open the app and click **Download** in step 2.
- **To see what the extension is doing:** open the page's console (Develop → Show JavaScript Console) and paste `document.documentElement.dataset.canalSubs`.

## How it works
In Safari, CANAL+ plays HLS natively with FairPlay DRM. The subtitles are separate, **unencrypted WebVTT** tracks.

1. **Background script** (`src/background.js`):
   - reads the stream's master playlist from the video's URL;
   - downloads every French subtitle track and picks one (`chooseRendition`);
   - strips sound descriptions from deaf and hard-of-hearing text (`stripSdh`);
   - translates 60 lines at a time, starting from the current position:
     - **Apple:** through `browser.runtime.sendNativeMessage` to the app's extension (`SafariWebExtensionHandler.swift`), which uses Apple's Translation framework in its low-latency mode;
     - **Claude:** through the Anthropic SDK with structured JSON output, sending the preceding lines as context;
   - caches results in `storage.local`, keyed by translator and French text.
2. **Content script** (`src/content.js`):
   - adds an "English (auto)" `TextTrack` to the `<video>` and fills it with the translated timeline;
   - aligns the timing using the French lines Safari exposes (`computeOffset`);
   - follows the CANAL+ subtitle menu;
   - starts over when the player loads a new episode.

Two findings drove this design. Safari only hands subtitle lines to the page about 2 seconds before they're shown, and stops entirely for hidden tracks after a seek. So the extension downloads the subtitle files itself instead of relying on those lines. The full investigation is in [docs/PLAN.md](docs/PLAN.md).

## Privacy
- With Apple (the default), subtitle text never leaves your Mac.
- With Claude, subtitle text is sent to the Anthropic API. Your API key is stored only in Safari's extension storage and sent only to `api.anthropic.com`.
- No other data is collected or sent anywhere.

## Development
```bash
npm install
npm test         # builds dist/, then runs unit and end-to-end tests (Node's test runner)
npm run watch    # rebuilds dist/ on change
apple/build.sh   # builds and installs the app from the current sources
```
- `src/` is the web extension. `npm run build` bundles it into `dist/`, which the Xcode project in `apple/` uses directly.
- `apple/` is the Xcode project: a SwiftUI setup app and the extension's native handler, `SafariWebExtensionHandler.swift`.
- For quick iteration without the app, load `dist/` as a temporary extension: Safari → Settings → Developer → Add Temporary Extension. Apple translation needs the app, so use Claude there. Remove the temporary copy afterwards.
- `test/background.e2e.test.mjs` runs the real bundled background script against a mocked CDN, Anthropic API and native app.
- `test/harness/` has pages that run the content script and the popup with mocked extension APIs. Serve the repo root (`python3 -m http.server`) and open `/test/harness/index.html?hls=1` or `/test/harness/popup.html`.
- `tools/make-icons.swift` draws the icons: `swift tools/make-icons.swift`.
- `recon/` holds diagnostic snippets for inspecting the CANAL+ player from Web Inspector. CANAL+ silences `console.log`, so the extension publishes its state in `document.documentElement.dataset.canalSubs`.

## Limitations
- Safari on macOS only. Chrome and Firefox get DASH from CANAL+, which this extension doesn't handle.
- Apple's translator handles each line on its own, so slang and lines split across subtitles can come out literal. Claude does better there.
- Live channels have no complete subtitle file, so lines are translated as they arrive and can appear late.
- Translating back to English from the French subtitles of an English-language film approximates the original dialogue; it won't recover the exact lines.

## License
MIT. See [LICENSE](LICENSE).
