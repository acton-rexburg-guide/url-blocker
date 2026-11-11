// Pure policy logic shared by the service worker, extension pages, and tests.
// Nothing in this file touches chrome.* APIs.

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Rule priorities: a higher number wins when several rules match a request.
// Allow beats block, the same way Chrome's own URLAllowlist beats URLBlocklist.
export const PRIORITY = { CATCH_ALL: 1, BLOCK: 2, ALLOW: 3, SOURCE: 4, TEMP: 4, ESSENTIAL: 5 };

// Pages a person has to be able to open in a tab (or an embedded frame) to
// sign in and keep their Google account working, even when "google.com" is
// blocked. ChromeOS system traffic (updates, policy sync, time, Play, etc.)
// is not listed here because this extension never filters it: it only acts
// on pages opened in tabs and frames.
export const ESSENTIAL_ENTRIES = [
  'accounts.google.com',
  'accounts.youtube.com',
  'gds.google.com',
  'apis.google.com',
  'content.googleapis.com',
  'ogs.google.com',
  'www.recaptcha.net',
  'www.google.com/recaptcha',
];

export const DEFAULTS = Object.freeze({
  mode: 'blocklist',
  allow: [],
  block: [],
  approvedSources: [],
  approvedSourceScope: 'site',
  schedules: [],
  protectEssentials: true,
  blockEmbeds: false,
  timezone: '',
  blockMessage: '',
  overridePassword: '',
});

const CATCH_ALL = '^(https?://.*)$';

// "https://www.Example.com/path?q" -> { host: 'www.example.com', path: '/path' }
export function parseEntry(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').replace(/^\./, '');
  const cut = s.search(/[/?#]/);
  let host = cut === -1 ? s : s.slice(0, cut);
  let path = cut === -1 ? '' : s.slice(cut).replace(/[?#].*$/, '');
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return null;
  if (path === '/') path = '';
  return { host, path };
}

export function parseList(list) {
  const items = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[\n,]/) : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const entry = parseEntry(item);
    if (!entry) continue;
    const key = entry.host + entry.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function formatEntry(entry) {
  return entry.host + entry.path;
}

// "08:30" -> 510. "24:00" is accepted so a window can run to midnight.
export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minutes <= 1440 ? minutes : null;
}

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = (Array.isArray(raw.days) ? raw.days : [])
    .map((d) => String(d).toLowerCase().slice(0, 3))
    .filter((d) => DAYS.includes(d));
  const start = parseTime(raw.start);
  const end = parseTime(raw.end);
  if (!days.length || start === null || end === null || start === 1440) return null;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Schedule',
    days: [...new Set(days)],
    start,
    end,
    mode: raw.mode === 'allowlist' || raw.mode === 'blocklist' ? raw.mode : '',
    allow: parseList(raw.allow),
    block: parseList(raw.block),
  };
}

export function normalizeConfig(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: raw.mode === 'allowlist' ? 'allowlist' : 'blocklist',
    allow: parseList(raw.allow),
    block: parseList(raw.block),
    approvedSources: parseList(raw.approvedSources),
    approvedSourceScope: raw.approvedSourceScope === 'link' ? 'link' : 'site',
    schedules: (Array.isArray(raw.schedules) ? raw.schedules : []).map(normalizeSchedule).filter(Boolean),
    protectEssentials: raw.protectEssentials !== false,
    blockEmbeds: raw.blockEmbeds === true,
    timezone: isValidTimezone(raw.timezone) ? raw.timezone : '',
    blockMessage: typeof raw.blockMessage === 'string' ? raw.blockMessage.slice(0, 500) : '',
    overridePassword: parsePasswordHash(raw.overridePassword) ? raw.overridePassword.trim() : '',
  };
}

// Day of week (0 = Sunday) and minutes since midnight, in `timezone` if given,
// otherwise in the device's own time zone.
export function localTime(date, timezone) {
  if (!isValidTimezone(timezone)) return { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3)), minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

// A window whose end is earlier than its start runs past midnight; its days
// are the days it starts on. start === end means all day.
export function isScheduleActive(schedule, now) {
  const today = schedule.days.includes(DAYS[now.day]);
  const { start, end } = schedule;
  if (start === end) return today;
  if (start < end) return today && now.minutes >= start && now.minutes < end;
  const yesterday = schedule.days.includes(DAYS[(now.day + 6) % 7]);
  return (today && now.minutes >= start) || (yesterday && now.minutes < end);
}

function merge(...lists) {
  const seen = new Set();
  return lists.flat().filter((e) => {
    const key = formatEntry(e);
    return !seen.has(key) && seen.add(key);
  });
}

export function effectivePolicy(config, now) {
  const active = config.schedules.filter((s) => isScheduleActive(s, now));
  let mode = config.mode;
  for (const s of active) if (s.mode) mode = s.mode;
  return {
    mode,
    allow: merge(config.allow, ...active.map((s) => s.allow)),
    block: merge(config.block, ...active.map((s) => s.block)),
    activeSchedules: active.map((s) => s.name),
  };
}

// First moment after `now` at which the set of active schedules changes,
// as { day, minutes } in the same clock as `now`, or null if it never does.
export function nextChange(config, now) {
  const signature = (t) => config.schedules.map((s) => (isScheduleActive(s, t) ? 1 : 0)).join('');
  const current = signature(now);
  let t = { ...now };
  for (let i = 0; i < 7 * 1440; i++) {
    t = t.minutes === 1439 ? { day: (t.day + 1) % 7, minutes: 0 } : { day: t.day, minutes: t.minutes + 1 };
    if (signature(t) !== current) return t;
  }
  return null;
}

export function formatClock(t) {
  const h = String(Math.floor(t.minutes / 60)).padStart(2, '0');
  const m = String(t.minutes % 60).padStart(2, '0');
  return `${DAY_NAMES[t.day]} ${h}:${m}`;
}

export function hostMatches(host, entries) {
  return entries.some((e) => host === e.host || host.endsWith('.' + e.host));
}

export function siteOf(host) {
  return host.replace(/^www\./, '');
}

export function frameTypes(config) {
  return config.blockEmbeds ? ['main_frame', 'sub_frame'] : ['main_frame'];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pathRegex(entry) {
  return `^(https?://([^/?#]*\\.)?${escapeRegex(entry.host)}(:[0-9]+)?${escapeRegex(entry.path)}.*)$`;
}

// Builds the declarativeNetRequest dynamic rules for one effective policy.
export function buildRules(policy, config, extensionId, temps = []) {
  const rules = [];
  const add = (priority, action, condition) => rules.push({ id: rules.length + 1, priority, action, condition });
  const frames = frameTypes(config);
  const redirect = { type: 'redirect', redirect: { regexSubstitution: `chrome-extension://${extensionId}/blocked.html#\\1` } };
  const split = (entries) => ({
    domains: entries.filter((e) => !e.path).map((e) => e.host),
    paths: entries.filter((e) => e.path),
  });

  const block = (priority, entries) => {
    const { domains, paths } = split(entries);
    if (domains.length) {
      add(priority, redirect, { regexFilter: CATCH_ALL, requestDomains: domains, resourceTypes: ['main_frame'] });
      if (config.blockEmbeds) add(priority, { type: 'block' }, { requestDomains: domains, resourceTypes: ['sub_frame'] });
    }
    for (const p of paths) {
      add(priority, redirect, { regexFilter: pathRegex(p), resourceTypes: ['main_frame'] });
      if (config.blockEmbeds) add(priority, { type: 'block' }, { urlFilter: `||${p.host}${p.path}`, resourceTypes: ['sub_frame'] });
    }
  };

  const allow = (priority, entries) => {
    const { domains, paths } = split(entries);
    if (domains.length) add(priority, { type: 'allow' }, { requestDomains: domains, resourceTypes: frames });
    for (const p of paths) add(priority, { type: 'allow' }, { urlFilter: `||${p.host}${p.path}`, resourceTypes: frames });
  };

  if (policy.mode === 'allowlist') {
    add(PRIORITY.CATCH_ALL, redirect, { regexFilter: CATCH_ALL, resourceTypes: ['main_frame'] });
    if (config.blockEmbeds) add(PRIORITY.CATCH_ALL, { type: 'block' }, { urlFilter: '|http', resourceTypes: ['sub_frame'] });
  }
  block(PRIORITY.BLOCK, policy.block);
  allow(PRIORITY.ALLOW, policy.allow);

  const sources = [...new Set(config.approvedSources.map((e) => e.host))];
  if (sources.length) {
    // Anything opened from an approved source, and the source itself.
    add(PRIORITY.SOURCE, { type: 'allow' }, { initiatorDomains: sources, resourceTypes: frames });
    add(PRIORITY.SOURCE, { type: 'allow' }, { requestDomains: sources, resourceTypes: frames });
  }
  for (const t of temps) {
    if (t.scope === 'site') add(PRIORITY.TEMP, { type: 'allow' }, { requestDomains: [t.site], resourceTypes: frames });
    else add(PRIORITY.TEMP, { type: 'allow' }, { regexFilter: pageRegex(t.url), resourceTypes: ['main_frame'] });
  }
  if (config.protectEssentials) allow(PRIORITY.ESSENTIAL, parseList(ESSENTIAL_ENTRIES));
  return rules;
}

// A site reached from an approved source is trusted in its tab: every page on
// that host and its "www." twin, but not other subdomains. A link to
// www.bandlab.com trusts bandlab.com and www.bandlab.com, not edu.bandlab.com.
// (Block and allow list entries still cover subdomains; this is only the trust.)
export function trustRegex(site) {
  return `^https?://(www\\.)?${escapeRegex(site)}(:[0-9]+)?([/?#].*)?$`;
}

export function siteTrusts(site, host) {
  return siteOf(String(host).toLowerCase()) === site;
}

// Session rule that keeps a site reached from an approved source open in that one tab.
export function tabTrustRule(id, tabId, site, config) {
  return { id, priority: PRIORITY.SOURCE, action: { type: 'allow' }, condition: { tabIds: [tabId], regexFilter: trustRegex(site), resourceTypes: frameTypes(config) } };
}

// Whether the rules from buildRules() let `url` load as a top-level page on
// their own, without counting the page that opened it. Used for in-page
// navigations (history.pushState), which never reach declarativeNetRequest.
export function allowsPage(url, policy, config, temps = []) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (temps.some((t) => tempAllows(t, url))) return true;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const matches = (entries) => entries.some((e) => hostMatches(host, [e]) && path.startsWith(e.path));
  if (config.protectEssentials && matches(parseList(ESSENTIAL_ENTRIES))) return true;
  if (hostMatches(host, config.approvedSources)) return true;
  if (matches(policy.allow)) return true;
  if (matches(policy.block)) return false;
  return policy.mode !== 'allowlist';
}

// Whether `url` is still the page `linked` points to: same origin and path,
// and no query parameter changed value (youtube.com/watch?v=A -> ?v=B is a
// different page; adding &t=30 or dropping a tracking parameter is not).
export function isSamePage(linked, url) {
  try {
    const a = new URL(linked);
    const b = new URL(url);
    if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
    for (const key of new Set(a.searchParams.keys())) {
      if (b.searchParams.has(key) && b.searchParams.getAll(key).join('\n') !== a.searchParams.getAll(key).join('\n')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// --- Settling period for "Allow only the linked page itself" ---------------
// Many sites change their own URL while a page loads: YouTube opens
// "watch?v=ID&feature=youtu.be" and then rewrites it. So for the first
// LINK_SETTLE_MS after a page opens from an approved source, any URL change
// on the same site is accepted and becomes the new "linked page". After that,
// only isSamePage() changes are allowed. The trade-off: a click to another
// page on that site within this window also gets through.
export const LINK_SETTLE_MS = 8000;

// tab: { linked: url opened from the approved source, linkedAt: ms timestamp }
export function isSettling(tab, url, now) {
  if (!tab?.linked || typeof tab.linkedAt !== 'number') return false;
  if (!(now - tab.linkedAt >= 0 && now - tab.linkedAt < LINK_SETTLE_MS)) return false;
  try {
    return siteOf(new URL(url).hostname) === siteOf(new URL(tab.linked).hostname);
  } catch {
    return false;
  }
}

// --- Temporary allows ("Temporarily allow" on the blocked page) -------------
// Someone who knows the admin password can allow a blocked site for a while,
// for the person using this browser only. Each allow is
//   { scope: 'site', site: 'example.com', url, until }  the whole site, or
//   { scope: 'page', url, until }                        only that page,
// where "that page" means what isSamePage() means: same origin and path, and
// no query parameter changed (youtube.com/watch?v=A, not ?v=B).

export const MAX_TEMP_MINUTES = 1440;

export function makeTempAllow(url, scope, minutes, now) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  minutes = Math.floor(Number(minutes));
  if (!(minutes >= 1 && minutes <= MAX_TEMP_MINUTES)) return null;
  const until = now + minutes * 60000;
  u.hash = '';
  if (scope === 'site') return { scope, site: siteOf(u.hostname.toLowerCase()), url: u.href, until };
  if (scope === 'page') return { scope, url: u.href, until };
  return null;
}

// Allows that haven't run out at `now`, ignoring anything malformed.
export function activeTempAllows(list, now) {
  return (Array.isArray(list) ? list : []).filter(
    (t) => t && typeof t.until === 'number' && t.until > now && typeof t.url === 'string' &&
      (t.scope === 'page' || (t.scope === 'site' && typeof t.site === 'string' && t.site)),
  );
}

export function tempAllows(temp, url) {
  if (temp.scope === 'page') return isSamePage(temp.url, url);
  try {
    return hostMatches(new URL(url).hostname.toLowerCase(), [{ host: temp.site }]);
  } catch {
    return false;
  }
}

// The declarativeNetRequest filter for a page allow: same origin and path, any
// query. Requests can't compare query parameters by name, so the service
// worker checks those once the page commits (see isSamePage).
export function pageRegex(url) {
  const u = new URL(url);
  return `^${escapeRegex(u.origin)}${escapeRegex(u.pathname)}([?#].*)?$`;
}

// --- Admin password --------------------------------------------------------
// The dashboard stores only "pbkdf2-sha256$<iterations>$<salt>$<hash>"
// (base64), never the password: managed settings are visible to anyone on the
// device at chrome://policy.

export const PASSWORD_ITERATIONS = 200000;

export function parsePasswordHash(value) {
  const m = /^pbkdf2-sha256\$(\d{4,7})\$([A-Za-z0-9+/]{16,}={0,2})\$([A-Za-z0-9+/]{40,}={0,2})$/.exec(typeof value === 'string' ? value.trim() : '');
  return m ? { iterations: Number(m[1]), salt: m[2], hash: m[3] } : null;
}

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD_ITERATIONS) {
  return `pbkdf2-sha256$${iterations}$${toB64(salt)}$${toB64(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password, stored) {
  const p = parsePasswordHash(stored);
  if (!p || typeof password !== 'string' || !password) return false;
  const got = await pbkdf2(password, fromB64(p.salt), p.iterations);
  const want = fromB64(p.hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
