// Tests for the admin dashboard (dashboard/). Code.gs runs here in a sandbox
// with fake Google services; Index.html is checked for the problems that
// stop it from running inside Apps Script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeConfig } from '../extension/lib/policy.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const CODE = read('dashboard/Code.gs');
const INDEX = read('dashboard/Index.html');
const SCHEMA = JSON.parse(read('extension/schema.json'));
const EXT_ID = 'chnnefiligaknogfjhfhbmiahinkldmf';

const scriptOf = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const idsIn = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// A fake Workspace: one root OU with a Students sub-OU, one group, and Chrome
// policies keyed by "schema target". Records every Chrome Policy API request.
function fakeWorkspace({ policies = {}, groups = [], props = {} } = {}) {
  const requests = [];
  const store = { ...props };
  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] ?? null, setProperty: (k, v) => (store[k] = v) }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'admin@school.org' }) },
    ScriptApp: { getOAuthToken: () => 'token' },
    Utilities: { formatDate: (d, tz) => { new Intl.DateTimeFormat('en', { timeZone: tz }); return '00'; } },
    AdminDirectory: {
      Orgunits: { list: () => ({ organizationUnits: [
        { orgUnitId: 'id:students', orgUnitPath: '/Students', name: 'Students', parentOrgUnitPath: '/', parentOrgUnitId: 'id:root' },
      ] }) },
      Groups: { list: (opts) => ({ groups: opts.userKey ? groups : groups }) },
      Users: { get: (email) => {
        if (email !== 'kid@school.org') throw new Error('Resource Not Found: userKey');
        return { primaryEmail: email, orgUnitPath: '/Students', suspended: false };
      } },
    },
    UrlFetchApp: { fetch: (url, opts) => {
      const body = JSON.parse(opts.payload);
      requests.push({ url, body });
      let out = {};
      if (url.endsWith('policies:resolve')) {
        const key = body.policySchemaFilter + ' ' + body.policyTargetKey.targetResource;
        out = { resolvedPolicies: policies[key] ? [policies[key]] : [] };
      }
      return { getContentText: () => JSON.stringify(out), getResponseCode: () => 200 };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { gs: ctx, requests, store };
}

const configPolicy = (config, source) => ({
  value: { value: { managedConfiguration: JSON.stringify(config) } },
  sourceKey: { targetResource: source },
});
const installPolicy = (type) => ({ value: { value: { appInstallType: type } } });

// --- Index.html --------------------------------------------------------------

test('Index.html script has no template literals (Apps Script breaks them)', () => {
  // HtmlService rewrites page scripts and treats "//" inside a template literal
  // as a comment, which kills the whole page. Plain strings are safe.
  assert.ok(!scriptOf(INDEX).includes('`'), 'Use plain strings with + instead of `backtick` strings.');
});

test('Index.html script parses', () => {
  assert.doesNotThrow(() => new Function(scriptOf(INDEX)));
});

test('Index.html only looks up elements that exist', () => {
  const ids = idsIn(INDEX);
  const missing = [...scriptOf(INDEX).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).filter((id) => !ids.has(id));
  assert.deepEqual([...new Set(missing)], []);
});

test('Index.html only calls server functions that exist in Code.gs', () => {
  const { gs } = fakeWorkspace();
  const names = [...scriptOf(INDEX).matchAll(/call\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length > 5);
  for (const name of names) assert.equal(typeof gs[name], 'function', name + ' is not defined in Code.gs');
});

// --- Code.gs -----------------------------------------------------------------

test('setExtensionId validates and stores the ID', () => {
  const { gs, store } = fakeWorkspace();
  assert.throws(() => gs.setExtensionId('not-an-id'), /32 letters/);
  assert.equal(gs.setExtensionId('  ' + EXT_ID + ' '), EXT_ID);
  assert.equal(store.EXTENSION_ID, EXT_ID);
  assert.equal(gs.getBootstrap().extensionId, EXT_ID);
});

test('getBootstrap lists the root OU as the whole organization', () => {
  const { gs } = fakeWorkspace();
  const paths = plain(gs.getBootstrap()).orgUnits.map((o) => o.path + '=' + o.id);
  assert.deepEqual(paths, ['/=root', '/Students=students']);
});

test('cleanConfig writes exactly the keys in the extension schema', () => {
  const { gs } = fakeWorkspace();
  const clean = gs.cleanConfig({ mode: 'allowlist', allow: ['a.com'], schedules: [{ days: ['mon'], start: '8:00', end: '15:00' }] });
  assert.deepEqual(Object.keys(clean).sort(), Object.keys(SCHEMA.properties).sort());
  assert.deepEqual(Object.keys(clean.schedules[0]).sort(), Object.keys(SCHEMA.properties.schedules.items.properties).sort());
});

test('what the dashboard saves, the extension reads the same way', () => {
  const { gs } = fakeWorkspace();
  const saved = JSON.parse(JSON.stringify(gs.cleanConfig({
    mode: 'allowlist', allow: ['classroom.google.com'], block: ['youtube.com/shorts'], approvedSources: ['classroom.google.com'],
    timezone: 'America/Denver', blockMessage: 'Ask', schedules: [{ name: 'Lunch', days: ['mon', 'fri'], start: '11:45', end: '12:30', allow: ['youtube.com'] }],
  })));
  const read = normalizeConfig(saved);
  assert.equal(read.mode, 'allowlist');
  assert.deepEqual(read.allow, [{ host: 'classroom.google.com', path: '' }]);
  assert.deepEqual(read.block, [{ host: 'youtube.com', path: '/shorts' }]);
  assert.equal(read.timezone, 'America/Denver');
  assert.equal(read.schedules.length, 1, 'schedule was dropped by the extension');
  assert.deepEqual(read.schedules[0].days, ['mon', 'fri']);
});

test('cleanConfig rejects bad input with a readable message', () => {
  const { gs } = fakeWorkspace();
  assert.throws(() => gs.cleanConfig({ schedules: [{ days: [], start: '08:00', end: '09:00' }] }), /needs at least one day/);
  assert.throws(() => gs.cleanConfig({ schedules: [{ days: ['mon'], start: '8am', end: '09:00' }] }), /Times must look like/);
  assert.throws(() => gs.cleanConfig({ timezone: 'Mars/Base' }), /Unknown time zone/);
});

test('saveTargetConfig writes the settings for this extension on the OU', () => {
  const { gs, requests } = fakeWorkspace({ props: { EXTENSION_ID: EXT_ID } });
  gs.saveTargetConfig({ type: 'ou', id: 'students' }, { mode: 'allowlist', allow: ['a.com'] }, false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /policies\/orgunits:batchModify$/);
  const [req] = requests[0].body.requests;
  assert.deepEqual(req.policyTargetKey, { targetResource: 'orgunits/students', additionalTargetKeys: { app_id: 'chrome:' + EXT_ID } });
  assert.equal(req.policyValue.policySchema, 'chrome.users.apps.ManagedConfiguration');
  assert.equal(JSON.parse(req.policyValue.value.managedConfiguration).mode, 'allowlist');
});

test('saveTargetConfig refuses before the extension ID is saved', () => {
  const { gs, requests } = fakeWorkspace();
  assert.throws(() => gs.saveTargetConfig({ type: 'ou', id: 'students' }, {}, false), /Save the extension ID/);
  assert.equal(requests.length, 0);
});

// --- Check a user ------------------------------------------------------------

const failed = (r) => plain(r).checks.filter((c) => c.ok === false).map((c) => c.label);
// Results made inside the sandbox are copied out so deepEqual compares plain values.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('checkUser passes when the extension is installed and settings reach the user', () => {
  const { gs } = fakeWorkspace({
    props: { EXTENSION_ID: EXT_ID },
    policies: {
      'chrome.users.apps.ManagedConfiguration orgunits/students': configPolicy({ mode: 'allowlist' }, 'orgunits/root'),
      'chrome.users.apps.InstallType orgunits/students': installPolicy('FORCED'),
    },
  });
  const r = plain(gs.checkUser('kid@school.org'));
  assert.deepEqual(failed(r), []);
  assert.equal(r.config.mode, 'allowlist');
  assert.equal(r.effectiveFrom, 'OU /');
});

test('checkUser flags a missing install and missing settings', () => {
  const { gs } = fakeWorkspace({ props: { EXTENSION_ID: EXT_ID } });
  const r = gs.checkUser('kid@school.org');
  assert.deepEqual(failed(r), ['Extension force-installed (OU /Students)', 'Settings from OU']);
});

test('checkUser reports group settings as overriding the OU', () => {
  const { gs } = fakeWorkspace({
    props: { EXTENSION_ID: EXT_ID },
    groups: [{ id: 'g1', email: 'pilot@school.org' }],
    policies: {
      'chrome.users.apps.InstallType orgunits/students': installPolicy('FORCED'),
      'chrome.users.apps.ManagedConfiguration orgunits/students': configPolicy({ mode: 'blocklist' }, 'orgunits/students'),
      'chrome.users.apps.ManagedConfiguration groups/g1': configPolicy({ mode: 'allowlist' }, 'groups/g1'),
    },
  });
  const r = gs.checkUser('kid@school.org');
  assert.equal(r.effectiveFrom, 'group pilot@school.org');
  assert.equal(r.config.mode, 'allowlist');
});

test('checkUser explains an unknown user or missing extension ID', () => {
  assert.deepEqual(failed(fakeWorkspace().gs.checkUser('kid@school.org')), ['Extension ID saved in Setup']);
  assert.deepEqual(failed(fakeWorkspace({ props: { EXTENSION_ID: EXT_ID } }).gs.checkUser('nobody@school.org')), ['User found']);
});

// --- Extension pages ---------------------------------------------------------

test('extension pages only look up elements that exist', () => {
  for (const [html, js] of [['extension/popup.html', 'extension/popup.js'], ['extension/blocked.html', 'extension/blocked.js']]) {
    const ids = idsIn(read(html));
    const used = [...read(js).matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(used.filter((id) => !ids.has(id)))], [], js);
  }
});

test('every file the manifest names exists', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.storage.managed_schema,
    ...Object.values(manifest.icons), ...manifest.web_accessible_resources.flatMap((r) => r.resources)];
  for (const f of files) assert.doesNotThrow(() => readFileSync(new URL('../extension/' + f, import.meta.url)), f);
});
