const api = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);

(async () => {
  const s = await api.storage.local.get(['enabled', 'apiKey', 'model', 'display', 'source']);
  $('enabled').checked = s.enabled ?? true;
  $('model').value = s.model ?? 'claude-opus-5-5';
  $('display').value = s.display ?? 'track';
  $('source').value = s.source ?? 'auto';
  if (s.apiKey) $('apiKey').placeholder = 'Saved (leave blank to keep)';
})();

$('save').onclick = async () => {
  const update = {
    enabled: $('enabled').checked,
    model: $('model').value,
    display: $('display').value,
    source: $('source').value,
  };
  const key = $('apiKey').value.trim();
  if (key) update.apiKey = key;
  await api.storage.local.set(update);
  $('apiKey').value = '';
  if (key) $('apiKey').placeholder = 'Saved (leave blank to keep)';
  $('msg').textContent = 'Saved.';
};

// Settings apply as soon as they change (no Save needed); Save is only for the API key.
$('enabled').onchange = () => api.storage.local.set({ enabled: $('enabled').checked });
for (const id of ['model', 'display', 'source']) {
  $(id).onchange = async () => {
    await api.storage.local.set({ [id]: $(id).value });
    $('msg').textContent = 'Applied.';
  };
}

$('clear').onclick = async () => {
  const r = await api.runtime.sendMessage({ type: 'clearCache' });
  $('msg').textContent = `Removed ${r?.removed ?? 0} cached lines.`;
};
