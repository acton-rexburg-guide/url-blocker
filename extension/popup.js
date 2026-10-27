const $ = (id) => document.getElementById(id);
const SOURCES = { admin: 'Google Admin console', developer: 'Local test config', none: 'Not configured (nothing blocked)', pending: 'Waiting for policy to load…' };

async function render() {
  const { status, tabs = {} } = await chrome.storage.session.get(['status', 'tabs']);
  $('source').textContent = SOURCES[status?.source] ?? '…';
  $('mode').textContent = status?.mode ?? '—';
  $('schedules').textContent = status?.activeSchedules?.length ? status.activeSchedules.join(', ') : 'None';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const trusted = Object.keys(tabs[tab?.id]?.rules ?? {});
  $('trusted').textContent = trusted.length ? `Opened from an approved source: ${trusted.join(', ')}` : 'Normal rules';
  $('error').hidden = !status?.error;
  $('error').textContent = status?.error ? `Couldn't apply rules: ${status.error}` : '';
}

if (!('update_url' in chrome.runtime.getManifest())) {
  $('dev').hidden = false;
  chrome.storage.local.get('devConfig').then(({ devConfig }) => {
    $('devConfig').value = JSON.stringify(devConfig ?? { mode: 'allowlist', allow: ['wikipedia.org'] }, null, 2);
  });
  $('saveDev').addEventListener('click', async () => {
    try {
      await chrome.storage.local.set({ devConfig: JSON.parse($('devConfig').value) });
      setTimeout(render, 500);
    } catch (e) {
      $('error').hidden = false;
      $('error').textContent = `Invalid JSON: ${e.message}`;
    }
  });
}

render();
