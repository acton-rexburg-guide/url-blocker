import { normalizeConfig, localTime, nextChange, formatClock, siteOf } from './lib/policy.js';
import { readSettings } from './lib/settings.js';

// The redirect rule appends the original URL, unencoded, after the "#".
const blockedUrl = location.hash.slice(1);
document.getElementById('url').textContent = blockedUrl;

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});
document.getElementById('retry').addEventListener('click', () => {
  if (/^https?:/.test(blockedUrl)) location.replace(blockedUrl);
});

const $ = (id) => document.getElementById(id);
const form = $('allowForm');

function showForm(show) {
  form.hidden = !show;
  $('tempAllow').hidden = show;
  $('allowError').hidden = true;
  if (show) $('password').focus();
}
$('tempAllow').addEventListener('click', () => showForm(true));
$('allowCancel').addEventListener('click', () => showForm(false));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('allowSubmit').disabled = true;
  $('allowError').hidden = true;
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'tempAllow',
      url: blockedUrl,
      password: $('password').value,
      scope: form.querySelector('input[name=scope]:checked').value,
      minutes: Number($('minutes').value),
    });
    if (r?.ok) {
      location.replace(blockedUrl);
      return;
    }
    $('allowError').textContent = r?.error ?? 'Something went wrong. Try again.';
  } catch (err) {
    $('allowError').textContent = String(err?.message ?? err);
  }
  $('allowError').hidden = false;
  $('password').value = '';
  $('password').focus();
  $('allowSubmit').disabled = false;
});

(async () => {
  const config = normalizeConfig((await readSettings()).raw ?? {});
  if (config.overridePassword && /^https?:/.test(blockedUrl)) {
    $('tempAllow').hidden = false;
    $('siteName').textContent = siteOf(new URL(blockedUrl).hostname);
  }
  if (config.blockMessage) document.getElementById('message').textContent = config.blockMessage;
  const next = config.schedules.length ? nextChange(config, localTime(new Date(), config.timezone)) : null;
  if (next) {
    const el = document.getElementById('next');
    el.textContent = `Access rules next change ${formatClock(next)}.`;
    el.hidden = false;
  }
})();
