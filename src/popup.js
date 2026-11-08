const api = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);
const APPLE = 'apple';
const CLAUDE_MODEL = 'claude-haiku-5-5';

let msgTimer;
function say(text) {
  $('msg').textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => ($('msg').textContent = ''), 2500);
}

// ---------- segmented controls ----------
const segs = Object.fromEntries([...document.querySelectorAll('.seg')].map(el => [el.dataset.key, el]));

function setSeg(key, value) {
  const el = segs[key];
  const buttons = [...el.querySelectorAll('button')];
  const active = buttons.find(b => b.dataset.v === value) || buttons[0];
  for (const b of buttons) b.setAttribute('aria-pressed', String(b === active));
  el.style.setProperty('--n', buttons.length);
  el.style.setProperty('--i', buttons.indexOf(active));
  return active.dataset.v;
}

const segValue = key => segs[key].querySelector('[aria-pressed="true"]')?.dataset.v;

function showProvider(provider) {
  $('claudeOpts').hidden = provider !== 'claude';
  $('appleOpts').hidden = provider !== APPLE;
}

for (const [key, el] of Object.entries(segs)) {
  el.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const v = setSeg(key, b.dataset.v);
    if (key === 'provider') {
      showProvider(v);
      await api.storage.local.set({ model: v === APPLE ? APPLE : CLAUDE_MODEL });
    } else {
      await api.storage.local.set({ [key]: v });
    }
    say('Applied');
  });
}

// ---------- load ----------
(async () => {
  const s = await api.storage.local.get(['enabled', 'apiKey', 'model', 'display', 'source']);
  const provider = s.model === APPLE ? APPLE : 'claude';
  $('enabled').checked = s.enabled ?? true;
  if (s.apiKey) $('apiKey').placeholder = 'Key saved (paste to replace)';
  setSeg('provider', provider);
  setSeg('display', s.display === 'overlay' ? 'track-dual' : s.display ?? 'track');
  setSeg('source', s.source ?? 'auto');
  showProvider(provider);
  // Animate only changes the user makes, not the initial placement.
  requestAnimationFrame(() => document.body.classList.add('ready'));
})();

// ---------- actions ----------
$('enabled').onchange = async () => {
  await api.storage.local.set({ enabled: $('enabled').checked });
  say($('enabled').checked ? 'On' : 'Off');
};

$('save').onclick = async () => {
  const key = $('apiKey').value.trim();
  if (!key) return say('Paste a key first');
  await api.storage.local.set({ apiKey: key });
  $('apiKey').value = '';
  $('apiKey').placeholder = 'Key saved (paste to replace)';
  say('Key saved');
};
$('apiKey').addEventListener('keydown', e => e.key === 'Enter' && $('save').click());

$('clear').onclick = async () => {
  const r = await api.runtime.sendMessage({ type: 'clearCache' });
  say(`Removed ${r?.removed ?? 0} lines`);
};

// For development: picks up a rebuilt dist/ without removing and re-adding the extension.
$('reload').onclick = () => api.runtime.reload();
