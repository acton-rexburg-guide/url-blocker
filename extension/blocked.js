import { normalizeConfig, localTime, nextChange, formatClock } from './lib/policy.js';
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

(async () => {
  const config = normalizeConfig((await readSettings()).raw ?? {});
  if (config.blockMessage) document.getElementById('message').textContent = config.blockMessage;
  const next = config.schedules.length ? nextChange(config, localTime(new Date(), config.timezone)) : null;
  if (next) {
    const el = document.getElementById('next');
    el.textContent = `Access rules next change ${formatClock(next)}.`;
    el.hidden = false;
  }
})();
