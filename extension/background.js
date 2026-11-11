import {
  normalizeConfig, effectivePolicy, buildRules, localTime, hostMatches, siteOf, siteTrusts, tabTrustRule, allowsPage, isSamePage, isSettling, LINK_SETTLE_MS,
  activeTempAllows, makeTempAllow, verifyPassword,
} from './lib/policy.js';
import { readSettings } from './lib/settings.js';

const dnr = chrome.declarativeNetRequest;

let configPromise = null;
function getConfig() {
  return (configPromise ??= loadConfig());
}

async function loadConfig() {
  const { raw, source } = await readSettings();
  return { config: raw ? normalizeConfig(raw) : null, source };
}

// Event handlers run one at a time so storage read-modify-writes never interleave.
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch((e) => console.error(e));
  return queue;
}

async function applyRules() {
  const { config, source } = await getConfig();
  if (source === 'pending') {
    // Policy hasn't loaded yet: keep the rules already in place and retry.
    configPromise = null;
    setTimeout(() => serial(applyRules), 10000);
    return;
  }
  const now = Date.now();
  const { temps, expired } = await loadTempAllows(now);
  const status = { source, mode: null, activeSchedules: [], tempAllows: temps, error: null, updatedAt: now };
  let rules = [];
  if (config) {
    const policy = effectivePolicy(config, localTime(new Date(), config.timezone));
    rules = buildRules(policy, config, chrome.runtime.id, temps);
    status.mode = policy.mode;
    status.activeSchedules = policy.activeSchedules;
  }
  const key = JSON.stringify(rules);
  const { appliedKey } = await chrome.storage.session.get('appliedKey');
  let changed = false;
  if (key !== appliedKey) {
    try {
      const existing = await dnr.getDynamicRules();
      await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
      await chrome.storage.session.set({ appliedKey: key });
      changed = true;
    } catch (e) {
      status.error = String(e?.message ?? e);
    }
  }
  await chrome.storage.session.set({ status });
  // New rules only stop new requests. A schedule starting, a policy change, or
  // a temporary allow running out also has to reach pages already open.
  if (config && (changed || expired.length)) await closeBlockedTabs(config, temps);
  scheduleExpiry(temps, now);
}

async function init() {
  await rememberOpenTabs();
  // Tick on minute boundaries so schedules switch on time.
  const nextMinute = Math.ceil(Date.now() / 60000) * 60000 + 1000;
  await chrome.alarms.create('tick', { when: nextMinute, periodInMinutes: 1 });
  await applyRules();
}

// --- Temporary allows -------------------------------------------------------
// Granted from the blocked page with the admin password, for this browser only.
// Kept in storage.local so they survive a restart until they run out.

async function loadTempAllows(now) {
  const { tempAllows: stored = [] } = await chrome.storage.local.get('tempAllows');
  const temps = activeTempAllows(stored, now);
  const expired = stored.filter((t) => !temps.includes(t));
  if (expired.length) await chrome.storage.local.set({ tempAllows: temps });
  return { temps, expired };
}

// Wakes up when the next allow runs out. The minute alarm catches it too if
// the service worker was stopped in between.
let expiryTimer;
function scheduleExpiry(temps, now) {
  clearTimeout(expiryTimer);
  if (!temps.length) return;
  const next = Math.min(...temps.map((t) => t.until));
  expiryTimer = setTimeout(() => serial(applyRules), Math.min(next - now + 500, 2 ** 31 - 1));
}

// Sends open tabs whose page the current rules no longer allow to the blocked
// page. A site reached from an approved source stays open in its tab, the
// same as it would for a new request in that tab.
async function closeBlockedTabs(config, temps) {
  const now = Date.now();
  const policy = effectivePolicy(config, localTime(new Date(), config.timezone));
  const tabs = await getTabs();
  for (const t of await chrome.tabs.query({})) {
    const url = t.url ?? '';
    if (t.id === undefined || !/^https?:/.test(url)) continue;
    if (tabAllows(tabs[t.id], url, policy, config, temps, now)) continue;
    await chrome.tabs.update(t.id, { url: blockedPage(url) });
  }
}

const MAX_TRIES = 5;
const LOCKOUT_MS = 60000;

async function grantTempAllow({ password, url, scope, minutes }) {
  const { config } = await getConfig();
  if (!config?.overridePassword) return { ok: false, error: 'Temporary allow is turned off. An admin can turn it on in the dashboard.' };
  const now = Date.now();
  const { pwFails = { count: 0, lockedUntil: 0 } } = await chrome.storage.local.get('pwFails');
  if (pwFails.lockedUntil > now) {
    return { ok: false, error: `Too many wrong passwords. Try again in ${Math.ceil((pwFails.lockedUntil - now) / 1000)} seconds.` };
  }
  const temp = makeTempAllow(url, scope, minutes, now);
  if (!temp) return { ok: false, error: 'Enter a number of minutes from 1 to 1440.' };
  if (!(await verifyPassword(password, config.overridePassword))) {
    const count = pwFails.count + 1;
    const locked = count >= MAX_TRIES;
    await chrome.storage.local.set({ pwFails: { count: locked ? 0 : count, lockedUntil: locked ? now + LOCKOUT_MS : 0 } });
    return { ok: false, error: locked ? 'Too many wrong passwords. Try again in a minute.' : 'Wrong password.' };
  }
  await chrome.storage.local.remove('pwFails');
  const { temps } = await loadTempAllows(now);
  const same = (t) => t.scope === temp.scope && (t.scope === 'site' ? t.site === temp.site : t.url === temp.url);
  await chrome.storage.local.set({ tempAllows: [...temps.filter((t) => !same(t)), temp] });
  await applyRules();
  return { ok: true, until: temp.until };
}

function blockedPage(url) {
  return `${chrome.runtime.getURL('blocked.html')}#${url}`;
}

// Whether `url` may stay open in this tab without a new request reaching
// declarativeNetRequest: the policy, a temporary allow, or approved-source trust.
function tabAllows(tab, url, policy, config, temps, now) {
  const host = hostOf(url);
  return (
    isSettling(tab, url, now) ||
    allowsPage(url, policy, config, temps) ||
    Object.keys(tab?.rules ?? {}).some((site) => siteTrusts(site, host)) ||
    !!(tab?.linked && isSamePage(tab.linked, url))
  );
}

// --- Links opened from approved sources ------------------------------------
// The initiatorDomains rule in buildRules() lets the first page through. With
// approvedSourceScope "site", the destination site then stays open in that tab
// so the person can keep using it. With "link", only that page stays allowed,
// after a short settling period while it loads (see LINK_SETTLE_MS in policy.js):
//   - in-page URL changes on the same site update the linked page, and
//   - a temporary session rule lets the site reload itself in that tab.
// Per-tab state in storage.session "tabs":
//   { url, opener?, rules: { site: ruleId }, linked?, linkedAt?, settleRule? }

async function getTabs() {
  return (await chrome.storage.session.get('tabs')).tabs ?? {};
}

// Session storage is wiped when the extension updates or Chrome restarts, but
// tabs (like an approved source the person already had open) stay open. Record
// the page each open tab is on so links clicked from them are still recognized.
async function rememberOpenTabs() {
  const tabs = await getTabs();
  for (const t of await chrome.tabs.query({})) {
    if (t.id === undefined || !/^https?:/.test(t.url ?? '')) continue;
    tabs[t.id] ??= { rules: {} };
    tabs[t.id].url ??= t.url;
  }
  await chrome.storage.session.set({ tabs });
}

// Our record of a tab's page, or Chrome's if we have none.
async function pageOf(tabs, tabId) {
  if (tabs[tabId]?.url) return tabs[tabId].url;
  try {
    return (await chrome.tabs.get(tabId)).url || undefined;
  } catch {
    return undefined;
  }
}

async function nextSessionRuleId() {
  const { sessionRuleId = 0 } = await chrome.storage.session.get('sessionRuleId');
  await chrome.storage.session.set({ sessionRuleId: sessionRuleId + 1 });
  return sessionRuleId + 1;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function onTopFrameCommitted(details) {
  const { config } = await getConfig();
  const tabs = await getTabs();
  const tab = tabs[details.tabId] ?? { rules: {} };
  const from = tab.opener ?? tab.url;
  const now = Date.now();
  const followedLink = details.transitionType === 'link' || details.transitionType === 'form_submit';
  const fromSource = followedLink && from && config && hostMatches(hostOf(from), config.approvedSources);
  if (config && !fromSource && (await outsideTempPage(tab, details.url, config, now))) {
    await chrome.tabs.update(details.tabId, { url: blockedPage(details.url) });
    return;
  }
  tab.url = details.url;
  delete tab.opener;
  if (fromSource) {
    // The page reached from an approved source; in-page navigations may stay on it.
    tab.linked = details.url;
    tab.linkedAt = now;
    if (config.approvedSourceScope === 'link') await startSettling(details.tabId, tab, config);
  } else if (isSettling(tab, details.url, now)) {
    // The linked page reloaded itself to a new URL while loading: keep it.
    tab.linked = details.url;
  } else {
    delete tab.linked;
    delete tab.linkedAt;
  }
  if (config?.approvedSourceScope === 'site' && fromSource) {
    const site = siteOf(hostOf(details.url));
    if (site && !tab.rules[site] && !hostMatches(site, config.approvedSources)) {
      const id = await nextSessionRuleId();
      await dnr.updateSessionRules({ addRules: [tabTrustRule(id, details.tabId, site, config)] });
      tab.rules[site] = id;
    }
  }
  tabs[details.tabId] = tab;
  await chrome.storage.session.set({ tabs });
}

// A "this page only" allow lets every URL with the same origin and path load
// (requests can't compare query parameters), so a different video on the same
// watch page gets here. Block it unless something else allows it.
async function outsideTempPage(tab, url, config, now) {
  const { temps } = await loadTempAllows(now);
  const u = new URL(url);
  const samePath = (t) => {
    const p = new URL(t.url);
    return p.origin === u.origin && p.pathname === u.pathname;
  };
  if (!temps.some((t) => t.scope === 'page' && samePath(t))) return false;
  const policy = effectivePolicy(config, localTime(new Date(), config.timezone));
  return !tabAllows(tab, url, policy, config, temps, now);
}

// Single-page sites like YouTube change pages with history.pushState, which
// declarativeNetRequest never sees. Check those URL changes here instead.
async function onTopFrameHistoryUpdated(details) {
  const { config } = await getConfig();
  if (!config) return;
  const tabs = await getTabs();
  const tab = (tabs[details.tabId] ??= { rules: {} });
  const now = Date.now();
  const { temps } = await loadTempAllows(now);
  const policy = effectivePolicy(config, localTime(new Date(), config.timezone));
  const settling = isSettling(tab, details.url, now);
  if (tabAllows(tab, details.url, policy, config, temps, now)) {
    // While settling, the site's rewritten URL becomes the linked page.
    if (settling) tab.linked = details.url;
    // Always record the page, so links clicked from single-page apps (like an
    // approved source) are recognized.
    tab.url = details.url;
    await chrome.storage.session.set({ tabs });
    return;
  }
  await chrome.tabs.update(details.tabId, { url: blockedPage(details.url) });
}

// Lets the linked site load fully in this tab (including reloads it does on
// its own) for LINK_SETTLE_MS, then removes that permission again.
async function startSettling(tabId, tab, config) {
  if (tab.settleRule) await dnr.updateSessionRules({ removeRuleIds: [tab.settleRule] });
  delete tab.settleRule;
  const site = siteOf(hostOf(tab.linked));
  if (!site || hostMatches(site, config.approvedSources)) return;
  const id = await nextSessionRuleId();
  await dnr.updateSessionRules({ addRules: [tabTrustRule(id, tabId, site, config)] });
  tab.settleRule = id;
  setTimeout(() => serial(() => endSettling(tabId, id)), LINK_SETTLE_MS);
}

async function endSettling(tabId, id) {
  await dnr.updateSessionRules({ removeRuleIds: [id] });
  const tabs = await getTabs();
  if (tabs[tabId]?.settleRule === id) {
    delete tabs[tabId].settleRule;
    await chrome.storage.session.set({ tabs });
  }
}

// Fallback in case the service worker stopped before endSettling() ran.
async function removeStaleSettleRules() {
  const tabs = await getTabs();
  const now = Date.now();
  const stale = [];
  for (const tab of Object.values(tabs)) {
    if (tab.settleRule && !(now - tab.linkedAt < LINK_SETTLE_MS)) {
      stale.push(tab.settleRule);
      delete tab.settleRule;
    }
  }
  if (!stale.length) return;
  await dnr.updateSessionRules({ removeRuleIds: stale });
  await chrome.storage.session.set({ tabs });
}

async function forgetTab(tabId) {
  const tabs = await getTabs();
  const ids = [...Object.values(tabs[tabId]?.rules ?? {}), tabs[tabId]?.settleRule].filter(Boolean);
  if (ids.length) await dnr.updateSessionRules({ removeRuleIds: ids });
  delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
}

async function clearTabTrust() {
  const existing = await dnr.getSessionRules();
  await dnr.updateSessionRules({ removeRuleIds: existing.map((r) => r.id) });
  const tabs = await getTabs();
  for (const tab of Object.values(tabs)) {
    tab.rules = {};
    delete tab.settleRule;
  }
  await chrome.storage.session.set({ tabs });
}

// --- Events -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => serial(init));
chrome.runtime.onStartup.addListener(() => serial(init));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'tick') return;
  // Re-read settings each minute in case a policy change event was missed.
  configPromise = null;
  serial(applyRules);
  serial(removeStaleSettleRules);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' || (area === 'local' && 'devConfig' in changes)) {
    configPromise = null;
    serial(async () => {
      await clearTabTrust();
      await applyRules();
    });
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) =>
  serial(async () => {
    const tabs = await getTabs();
    const opener = await pageOf(tabs, details.sourceTabId);
    if (!opener) return;
    tabs[details.tabId] = { ...(tabs[details.tabId] ?? { rules: {} }), opener };
    await chrome.storage.session.set({ tabs });
  }),
);

// Before a tab leaves a page we have no record of (for example one opened
// before an update), ask Chrome which page it is so a link from an approved
// source is still recognized.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  serial(async () => {
    const tabs = await getTabs();
    if (tabs[details.tabId]?.url) return;
    const url = await pageOf(tabs, details.tabId);
    if (!url || !/^https?:/.test(url) || url === details.url) return;
    tabs[details.tabId] = { ...(tabs[details.tabId] ?? { rules: {} }), url };
    await chrome.storage.session.set({ tabs });
  });
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && /^https?:/.test(details.url)) serial(() => onTopFrameCommitted(details));
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0 && /^https?:/.test(details.url)) serial(() => onTopFrameHistoryUpdated(details));
});

chrome.tabs.onRemoved.addListener((tabId) => serial(() => forgetTab(tabId)));

// From the blocked page's "Temporarily allow" form.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'tempAllow' || sender.id !== chrome.runtime.id) return false;
  serial(async () => {
    try {
      sendResponse(await grantTempAllow(msg));
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  });
  return true;
});
