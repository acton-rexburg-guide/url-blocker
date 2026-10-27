// Pure policy logic shared by the service worker, extension pages, and tests.
// Nothing in this file touches chrome.* APIs.

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Rule priorities: a higher number wins when several rules match a request.
// Allow beats block, the same way Chrome's own URLAllowlist beats URLBlocklist.
export const PRIORITY = { CATCH_ALL: 1, BLOCK: 2, ALLOW: 3, SOURCE: 4, ESSENTIAL: 5 };

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
export function buildRules(policy, config, extensionId) {
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
  if (config.protectEssentials) allow(PRIORITY.ESSENTIAL, parseList(ESSENTIAL_ENTRIES));
  return rules;
}

// Session rule that keeps a site reached from an approved source open in that one tab.
export function tabTrustRule(id, tabId, site, config) {
  return { id, priority: PRIORITY.SOURCE, action: { type: 'allow' }, condition: { tabIds: [tabId], requestDomains: [site], resourceTypes: frameTypes(config) } };
}
