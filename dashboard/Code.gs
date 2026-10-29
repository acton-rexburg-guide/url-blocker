// URL Filter admin dashboard. Runs as the admin who opens it, so every change
// is made with that admin's own Google Workspace permissions.

const POLICY_API = 'https://chromepolicy.googleapis.com/v1/customers/my_customer/';
const CONFIG_SCHEMA = 'chrome.users.apps.ManagedConfiguration';
const INSTALL_SCHEMA = 'chrome.users.apps.InstallType';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('URL Filter Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// --- Setup -------------------------------------------------------------------

// Run this from the Apps Script editor (pick "diagnose" next to Run) to check
// each thing the dashboard needs. Results appear in the Execution log.
function diagnose() {
  const step = (name, fn) => {
    try { console.log('OK    ' + name + ': ' + fn()); }
    catch (e) { console.log('FAIL  ' + name + ': ' + e.message); }
  };
  step('Signed-in user', () => Session.getActiveUser().getEmail() || '(blank: not a Workspace account in this domain?)');
  step('Saved extension ID', () => getExtensionId() || '(none saved)');
  step('Admin SDK: org units', () => listOrgUnits().length + ' found');
  step('Admin SDK: groups', () => listGroups().length + ' found');
  step('Chrome Policy API', () => {
    const root = listOrgUnits().find((u) => u.path === '/');
    if (!root) return 'skipped (no org units listed)';
    return resolve({ type: 'ou', id: root.id }, CONFIG_SCHEMA, !!getExtensionId()).length + ' policies read';
  });
}

function getExtensionId() {
  return PropertiesService.getScriptProperties().getProperty('EXTENSION_ID') || '';
}

function setExtensionId(id) {
  id = String(id || '').trim();
  if (!/^[a-p]{32}$/.test(id)) throw new Error('An extension ID is 32 letters between a and p.');
  PropertiesService.getScriptProperties().setProperty('EXTENSION_ID', id);
  return id;
}

function getBootstrap() {
  return {
    user: Session.getActiveUser().getEmail(),
    extensionId: getExtensionId(),
    orgUnits: listOrgUnits(),
    groups: listGroups(),
  };
}

function listOrgUnits() {
  const units = AdminDirectory.Orgunits.list('my_customer', { type: 'all' }).organizationUnits || [];
  const out = units.map((u) => ({ id: u.orgUnitId.replace(/^id:/, ''), path: u.orgUnitPath, name: u.name }));
  // The root OU isn't listed; its ID is the parent ID of any top-level OU.
  const top = units.find((u) => u.parentOrgUnitPath === '/');
  if (top) out.push({ id: top.parentOrgUnitId.replace(/^id:/, ''), path: '/', name: 'Whole organization' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function listGroups() {
  const out = [];
  let pageToken;
  do {
    const page = AdminDirectory.Groups.list({ customer: 'my_customer', maxResults: 200, pageToken });
    (page.groups || []).forEach((g) => out.push({ id: g.id, email: g.email, name: g.name }));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

// --- Chrome Policy API -------------------------------------------------------

function policyApi(path, body) {
  const res = UrlFetchApp.fetch(POLICY_API + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const text = res.getContentText();
  const json = text ? JSON.parse(text) : {};
  if (res.getResponseCode() >= 300) throw new Error((json.error && json.error.message) || text);
  return json;
}

function targetKey(target, withApp) {
  if (!target || !/^[A-Za-z0-9_-]+$/.test(target.id || '')) throw new Error('Pick an organizational unit or group first.');
  const key = { targetResource: (target.type === 'group' ? 'groups/' : 'orgunits/') + target.id };
  if (withApp) {
    const id = getExtensionId();
    if (!id) throw new Error('Save the extension ID in Setup first.');
    key.additionalTargetKeys = { app_id: 'chrome:' + id };
  }
  return key;
}

function resolve(target, schemaFilter, withApp) {
  return policyApi('policies:resolve', { policySchemaFilter: schemaFilter, policyTargetKey: targetKey(target, withApp) }).resolvedPolicies || [];
}

// Returns the settings that apply to this target, and whether they're set
// here or inherited from a parent OU.
function loadTargetConfig(target) {
  const own = targetKey(target, false).targetResource;
  const [cfg] = resolve(target, CONFIG_SCHEMA, true);
  const [install] = resolve(target, INSTALL_SCHEMA, true);
  let config = null;
  let setHere = false;
  if (cfg) {
    const value = cfg.value.value.managedConfiguration;
    config = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    setHere = cfg.sourceKey && cfg.sourceKey.targetResource === own;
  }
  return {
    config,
    setHere,
    installType: install ? install.value.value.appInstallType : 'NOT_INSTALLED',
  };
}

function saveTargetConfig(target, config, forceInstall) {
  const clean = cleanConfig(config);
  const key = targetKey(target, true);
  const requests = [];
  if (forceInstall) {
    requests.push({
      policyTargetKey: key,
      policyValue: { policySchema: INSTALL_SCHEMA, value: { appInstallType: 'FORCED' } },
      updateMask: 'appInstallType',
    });
  }
  requests.push({
    policyTargetKey: key,
    policyValue: { policySchema: CONFIG_SCHEMA, value: { managedConfiguration: JSON.stringify(clean) } },
    updateMask: 'managedConfiguration',
  });
  policyApi(target.type === 'group' ? 'policies/groups:batchModify' : 'policies/orgunits:batchModify', { requests });
  return clean;
}

// Removes this target's own settings so it inherits from its parent OU again
// (or, for a group, falls back to the user's OU).
function clearTargetConfig(target) {
  const request = { policyTargetKey: targetKey(target, true), policySchema: CONFIG_SCHEMA };
  policyApi(target.type === 'group' ? 'policies/groups:batchDelete' : 'policies/orgunits:batchInherit', { requests: [request] });
}

// Reads the Admin console's own URL blocking lists for this target so they
// can be copied into the extension's settings.
function importNativeLists(target) {
  const allow = [];
  const block = [];
  resolve(target, 'chrome.users.Url*', false).forEach((p) => {
    const value = (p.value && p.value.value) || {};
    Object.keys(value).forEach((k) => {
      const list = Array.isArray(value[k]) ? value[k] : typeof value[k] === 'string' ? value[k].split(',') : [];
      if (/allowlist/i.test(k)) allow.push.apply(allow, list);
      else if (/blocklist/i.test(k)) block.push.apply(block, list);
    });
  });
  return { allow, block };
}

// --- Check a user ------------------------------------------------------------

// Walks the chain for one user: their OU and groups, whether the extension is
// force-installed for them, and which settings reach them. Each check is
// { ok: true | false | null (info), label, detail }.
function checkUser(email) {
  email = String(email || '').trim();
  if (!email) throw new Error('Enter a user email.');
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail: detail || '' });

  const extId = getExtensionId();
  add(!!extId, 'Extension ID saved in Setup', extId || 'Save it in section 1 first.');
  if (!extId) return { email, checks };

  let user;
  try {
    user = AdminDirectory.Users.get(email);
  } catch (e) {
    add(false, 'User found', e.message);
    return { email, checks };
  }
  add(true, 'User found', user.primaryEmail + (user.suspended ? ' (suspended)' : ''));

  const units = listOrgUnits();
  const pathOf = (resource) => {
    const id = String(resource || '').replace(/^orgunits\//, '');
    const u = units.find((x) => x.id === id);
    return u ? u.path : resource;
  };
  const ou = units.find((u) => u.path === user.orgUnitPath);
  add(!!ou, 'Organizational unit', user.orgUnitPath);
  if (!ou) return { email, checks };

  const groups = [];
  let pageToken;
  do {
    const page = AdminDirectory.Groups.list({ userKey: user.primaryEmail, pageToken });
    (page.groups || []).forEach((g) => groups.push(g));
    pageToken = page.nextPageToken;
  } while (pageToken);
  add(null, 'Groups', groups.length ? groups.map((g) => g.email).join(', ') : 'none');

  const ouResult = describeTarget({ type: 'ou', id: ou.id }, pathOf);
  add(ouResult.installType === 'FORCED', 'Extension force-installed (OU ' + ou.path + ')',
    ouResult.installType === 'FORCED' ? 'yes' : 'Install type is ' + ouResult.installType + '. See README Step 1b.');
  add(!!ouResult.config, 'Settings from OU', ouResult.config ? 'set on ' + ouResult.source : 'none found for ' + ou.path);

  const groupResults = groups.map((g) => ({ g, r: describeTarget({ type: 'group', id: g.id }, pathOf) }));
  groupResults.forEach(({ g, r }) => {
    if (r.error) add(null, 'Group ' + g.email, 'could not read: ' + r.error);
    else if (r.config || r.installType !== 'NOT_INSTALLED') {
      add(null, 'Group ' + g.email, 'install type ' + r.installType + (r.config ? ', has settings (these override the OU)' : ', no settings'));
    }
  });

  const winner = groupResults.find(({ r }) => r.config);
  const effective = winner ? winner.r : ouResult;
  if (winner && groupResults.filter(({ r }) => r.config).length > 1) {
    add(null, 'Several groups have settings', 'The highest-ranked group in the Admin console wins; showing ' + winner.g.email + '.');
  }
  return {
    email,
    checks,
    effectiveFrom: winner ? 'group ' + winner.g.email : effective.config ? 'OU ' + effective.source : null,
    config: effective.config,
    rawValue: effective.rawValue,
  };
}

function describeTarget(target, pathOf) {
  try {
    const own = targetKey(target, false).targetResource;
    const [cfg] = resolve(target, CONFIG_SCHEMA, true);
    const [install] = resolve(target, INSTALL_SCHEMA, true);
    const out = { installType: install ? install.value.value.appInstallType : 'NOT_INSTALLED', config: null };
    if (cfg) {
      out.rawValue = cfg.value.value.managedConfiguration;
      out.config = typeof out.rawValue === 'string' ? JSON.parse(out.rawValue || '{}') : out.rawValue;
      const src = cfg.sourceKey && cfg.sourceKey.targetResource;
      out.source = src === own ? 'this ' + target.type : pathOf(src);
    }
    return out;
  } catch (e) {
    return { installType: 'UNKNOWN', config: null, error: e.message };
  }
}

// --- Validation (mirrors extension/schema.json) ------------------------------

function cleanList(list) {
  const items = Array.isArray(list) ? list : String(list || '').split(/[\n,]/);
  return items.map((s) => String(s).trim()).filter((s) => s && s !== '*').slice(0, 5000);
}

function cleanTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m || Number(m[2]) > 59 || Number(m[1]) * 60 + Number(m[2]) > 1440) throw new Error('Times must look like 08:00 or 15:30 (got "' + t + '").');
  return ('0' + Number(m[1])).slice(-2) + ':' + m[2];
}

function cleanConfig(c) {
  c = c || {};
  const out = {
    mode: c.mode === 'allowlist' ? 'allowlist' : 'blocklist',
    allow: cleanList(c.allow),
    block: cleanList(c.block),
    approvedSources: cleanList(c.approvedSources),
    approvedSourceScope: c.approvedSourceScope === 'link' ? 'link' : 'site',
    protectEssentials: c.protectEssentials !== false,
    blockEmbeds: c.blockEmbeds === true,
    timezone: String(c.timezone || '').trim(),
    blockMessage: String(c.blockMessage || '').slice(0, 500),
    schedules: (c.schedules || []).map((s, i) => {
      const days = (s.days || []).filter((d) => DAYS.indexOf(d) !== -1);
      if (!days.length) throw new Error('Schedule ' + (i + 1) + ' needs at least one day.');
      return {
        name: String(s.name || 'Schedule ' + (i + 1)).trim(),
        days,
        start: cleanTime(s.start),
        end: cleanTime(s.end),
        mode: s.mode === 'allowlist' || s.mode === 'blocklist' ? s.mode : '',
        allow: cleanList(s.allow),
        block: cleanList(s.block),
      };
    }),
  };
  if (out.timezone && !isValidTimezone(out.timezone)) throw new Error('Unknown time zone "' + out.timezone + '". Use a name like America/Denver.');
  return out;
}

function isValidTimezone(tz) {
  try {
    Utilities.formatDate(new Date(), tz, 'HH');
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(tz) || tz === 'UTC';
  } catch (e) {
    return false;
  }
}
