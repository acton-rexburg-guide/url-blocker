import { normalizeConfig, effectivePolicy, buildRules, localTime, hostMatches, siteOf, tabTrustRule } from './lib/policy.js';
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
  // Tick on minute boundaries so schedules switch on time.
  const nextMinute = Math.ceil(Date.now() / 60000) * 60000 + 1000;
  await chrome.alarms.create('tick', { when: nextMinute, periodInMinutes: 1 });
  await applyRules();
}

// --- Links opened from approved sources ------------------------------------
// The initiatorDomains rule in buildRules() lets the first page through. With
// approvedSourceScope "site", the destination site then stays open in that tab
// so the person can keep using it.

async function getTabs() {
  return (await chrome.storage.session.get('tabs')).tabs ?? {};
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

  const followedLink = details.transitionType === 'link' || details.transitionType === 'form_submit';
  if (config?.approvedSourceScope === 'site' && followedLink && from && hostMatches(hostOf(from), config.approvedSources)) {
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

async function forgetTab(tabId) {
  const tabs = await getTabs();
  const ids = Object.values(tabs[tabId]?.rules ?? {});
  if (ids.length) await dnr.updateSessionRules({ removeRuleIds: ids });
  delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
}

async function clearTabTrust() {
  const existing = await dnr.getSessionRules();
  await dnr.updateSessionRules({ removeRuleIds: existing.map((r) => r.id) });
  const tabs = await getTabs();
  for (const tab of Object.values(tabs)) tab.rules = {};
  await chrome.storage.session.set({ tabs });
}

// --- Events -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => serial(init));
chrome.runtime.onStartup.addListener(() => serial(init));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') serial(applyRules);
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
    const opener = tabs[details.sourceTabId]?.url;
    if (!opener) return;
    tabs[details.tabId] = { ...(tabs[details.tabId] ?? { rules: {} }), opener };
    await chrome.storage.session.set({ tabs });
  }),
);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && /^https?:/.test(details.url)) serial(() => onTopFrameCommitted(details));
});

chrome.tabs.onRemoved.addListener((tabId) => serial(() => forgetTab(tabId)));
