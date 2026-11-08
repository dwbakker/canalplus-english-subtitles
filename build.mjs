// Builds the unpacked extension into dist/ (load that folder in Safari).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const f of ['manifest.json', 'popup.html', 'popup.css', 'popup.js']) cpSync(`src/${f}`, `dist/${f}`);
// Icons go at the top level: Xcode copies extension resources into one flat folder.
for (const f of readdirSync('src/icons')) cpSync(`src/icons/${f}`, `dist/${f}`);

const opts = {
  entryPoints: ['src/background.js', 'src/content.js'],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'safari17',
  minify: !watch,
  logLevel: 'info',
};
// Safari may decode extension scripts as Latin-1, turning raw UTF-8 like "À" or "…" into two
// characters (that broke a regex character class). Escape every non-ASCII char as \uXXXX,
// which means the same thing in strings, template literals and regex literals.
const asciiOnly = {
  name: 'ascii-only',
  setup(b) {
    b.onEnd(result => {
      for (const f of result.outputFiles ?? []) {
        if (!f.path.endsWith('.js')) continue;
        const text = f.text.replace(/[^\x00-\x7f]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
        writeFileSync(f.path, text);
      }
    });
  },
};
opts.charset = 'ascii';
opts.write = false;
opts.plugins = [asciiOnly];

if (watch) await (await context(opts)).watch();
else await build(opts);
