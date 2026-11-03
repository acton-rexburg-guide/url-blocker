import { normalizeConfig, effectivePolicy, buildRules, localTime, hostMatches, siteOf, tabTrustRule, allowsPage, isSamePage, isSettling, LINK_SETTLE_MS } from './lib/policy.js';
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
  const status = { source, mode: null, activeSchedules: [], error: null, updatedAt: Date.now() };
  let rules = [];
  if (config) {
    const policy = effectivePolicy(config, localTime(new Date(), config.timezone));
    rules = buildRules(policy, config, chrome.runtime.id);
    status.mode = policy.mode;
    status.activeSchedules = policy.activeSchedules;
  }
  const key = JSON.stringify(rules);
  const { appliedKey } = await chrome.storage.session.get('appliedKey');
  if (key !== appliedKey) {
    try {
      const existing = await dnr.getDynamicRules();
      await dnr.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
      await chrome.storage.session.set({ appliedKey: key });
    } catch (e) {
      status.error = String(e?.message ?? e);
    }
  }
  await chrome.storage.session.set({ status });
}

async function init() {
  await rememberOpenTabs();
  // Tick on minute boundaries so schedules switch on time.
  const nextMinute = Math.ceil(Date.now() / 60000) * 60000 + 1000;
  await chrome.alarms.create('tick', { when: nextMinute, periodInMinutes: 1 });
  await applyRules();
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
  tab.url = details.url;
  delete tab.opener;

  const now = Date.now();
  const followedLink = details.transitionType === 'link' || details.transitionType === 'form_submit';
  const fromSource = followedLink && from && config && hostMatches(hostOf(from), config.approvedSources);
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

// Single-page sites like YouTube change pages with history.pushState, which
// declarativeNetRequest never sees. Check those URL changes here instead.
async function onTopFrameHistoryUpdated(details) {
  const { config } = await getConfig();
  if (!config) return;
  const tabs = await getTabs();
  const tab = (tabs[details.tabId] ??= { rules: {} });
  const host = hostOf(details.url);
  const policy = effectivePolicy(config, localTime(new Date(), config.timezone));
  const settling = isSettling(tab, details.url, Date.now());
  const allowed =
    settling ||
    allowsPage(details.url, policy, config) ||
    Object.keys(tab?.rules ?? {}).some((site) => hostMatches(host, [{ host: site }])) ||
    (tab?.linked && isSamePage(tab.linked, details.url));
  if (allowed) {
    // While settling, the site's rewritten URL becomes the linked page.
    if (settling) tab.linked = details.url;
    // Always record the page, so links clicked from single-page apps (like an
    // approved source) are recognized.
    tab.url = details.url;
    await chrome.storage.session.set({ tabs });
    return;
  }
  await chrome.tabs.update(details.tabId, { url: `${chrome.runtime.getURL('blocked.html')}#${details.url}` });
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
