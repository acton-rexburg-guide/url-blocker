import { readManaged } from './lib/settings.js';

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
  $('updated').textContent = status?.updatedAt ? new Date(status.updatedAt).toLocaleTimeString() : '—';
  $('version').textContent = chrome.runtime.getManifest().version;
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

// Everything needed to see where the chain breaks on this device, as text the
// admin can paste into a support request.
async function diagnostics() {
  const manifest = chrome.runtime.getManifest();
  const { status } = await chrome.storage.session.get('status');
  const managed = await readManaged();
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return {
    extensionId: chrome.runtime.id,
    version: manifest.version,
    updateUrl: manifest.update_url ?? '(unpacked)',
    browser: navigator.userAgent,
    deviceTime: new Date().toString(),
    deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    status: status ? { ...status, updatedAt: new Date(status.updatedAt).toString() } : null,
    managedSettings: managed ?? '(Chrome did not answer within 5 seconds)',
    activeRules: rules.length,
    rules: rules.map((r) => ({ id: r.id, priority: r.priority, action: r.action.type, condition: r.condition })),
  };
}

$('copyDiag').addEventListener('click', async () => {
  const text = JSON.stringify(await diagnostics(), null, 2);
  $('diagNote').hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    $('diagNote').textContent = 'Copied. Paste it wherever you need it.';
  } catch {
    $('diagText').hidden = false;
    $('diagText').value = text;
    $('diagText').select();
    $('diagNote').textContent = "Couldn't copy automatically. Select the text below and copy it.";
  }
});

render();
