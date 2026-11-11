import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEntry, parseList, normalizeConfig, isScheduleActive, effectivePolicy, nextChange,
  buildRules, pathRegex, localTime, PRIORITY, allowsPage, isSamePage, isSettling, LINK_SETTLE_MS,
  makeTempAllow, activeTempAllows, tempAllows, pageRegex, hashPassword, verifyPassword, parsePasswordHash,
  trustRegex, siteTrusts, tabTrustRule, siteOf,
} from '../extension/lib/policy.js';

test('approved-source trust covers the site and its www twin, not other subdomains', () => {
  const site = siteOf('www.bandlab.com');
  const re = new RegExp(trustRegex(site));
  for (const url of ['https://bandlab.com/', 'https://www.bandlab.com/library?x=1', 'http://bandlab.com:8080/a', 'https://bandlab.com']) {
    assert.ok(re.test(url), url);
    assert.ok(siteTrusts(site, new URL(url).hostname), url);
  }
  for (const url of ['https://edu.bandlab.com/', 'https://notbandlab.com/', 'https://bandlab.com.evil.net/', 'https://www.edu.bandlab.com/']) {
    assert.ok(!re.test(url), url);
    assert.ok(!siteTrusts(site, new URL(url).hostname), url);
  }
  const rule = tabTrustRule(7, 3, site, normalizeConfig({}));
  assert.equal(rule.condition.requestDomains, undefined);
  assert.equal(rule.condition.regexFilter, trustRegex(site));
  assert.deepEqual(rule.condition.tabIds, [3]);
  assert.equal(rule.priority, PRIORITY.SOURCE);
});

const at = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return { day, minutes: h * 60 + m };
};
const MON = 1, TUE = 2, SAT = 6;

test('parseEntry accepts admin-console style entries', () => {
  assert.deepEqual(parseEntry('https://www.Example.com/Path?x=1'), { host: 'www.example.com', path: '/path' });
  assert.deepEqual(parseEntry('*.example.com'), { host: 'example.com', path: '' });
  assert.deepEqual(parseEntry('example.com:8080/'), { host: 'example.com', path: '' });
  assert.equal(parseEntry('*'), null);
  assert.equal(parseEntry('# comment'), null);
  assert.equal(parseEntry('not a host'), null);
});

test('parseList dedupes and accepts newline text', () => {
  assert.deepEqual(parseList('a.com\nb.com, a.com\n\n').map((e) => e.host), ['a.com', 'b.com']);
});

test('schedules: same-day, overnight, all-day', () => {
  const school = { days: ['mon', 'tue'], start: 8 * 60, end: 15 * 60 };
  assert.ok(isScheduleActive(school, at(MON, '08:00')));
  assert.ok(!isScheduleActive(school, at(MON, '15:00')));
  assert.ok(!isScheduleActive(school, at(SAT, '10:00')));

  const night = { days: ['mon'], start: 22 * 60, end: 6 * 60 };
  assert.ok(isScheduleActive(night, at(MON, '23:00')));
  assert.ok(isScheduleActive(night, at(TUE, '05:59')));
  assert.ok(!isScheduleActive(night, at(TUE, '23:00')));

  assert.ok(isScheduleActive({ days: ['sat'], start: 0, end: 0 }, at(SAT, '12:00')));
});

test('effectivePolicy layers active schedules over the base', () => {
  const config = normalizeConfig({
    mode: 'allowlist',
    allow: ['classroom.google.com'],
    schedules: [
      { name: 'After school', days: ['mon'], start: '15:00', end: '21:00', mode: 'blocklist', block: ['games.com'] },
      { name: 'Lunch', days: ['mon'], start: '12:00', end: '13:00', allow: ['youtube.com'] },
    ],
  });
  const lunch = effectivePolicy(config, at(MON, '12:30'));
  assert.equal(lunch.mode, 'allowlist');
  assert.deepEqual(lunch.allow.map((e) => e.host), ['classroom.google.com', 'youtube.com']);
  const evening = effectivePolicy(config, at(MON, '16:00'));
  assert.equal(evening.mode, 'blocklist');
  assert.deepEqual(evening.activeSchedules, ['After school']);
  assert.deepEqual(nextChange(config, at(MON, '12:30')), at(MON, '13:00'));
});

test('invalid schedules are dropped', () => {
  const config = normalizeConfig({ schedules: [{ days: ['xyz'], start: '08:00', end: '09:00' }, { days: ['mon'], start: '25:00', end: '09:00' }] });
  assert.equal(config.schedules.length, 0);
});

test('allowlist rules: catch-all, allows, sources, essentials', () => {
  const config = normalizeConfig({ mode: 'allowlist', allow: ['wikipedia.org'], approvedSources: ['classroom.google.com'] });
  const rules = buildRules(effectivePolicy(config, at(MON, '09:00')), config, 'abc');
  const byPriority = (p) => rules.filter((r) => r.priority === p);
  assert.equal(byPriority(PRIORITY.CATCH_ALL)[0].action.redirect.regexSubstitution, 'chrome-extension://abc/blocked.html#\\1');
  assert.deepEqual(byPriority(PRIORITY.ALLOW)[0].condition.requestDomains, ['wikipedia.org']);
  assert.deepEqual(byPriority(PRIORITY.SOURCE)[0].condition.initiatorDomains, ['classroom.google.com']);
  assert.ok(byPriority(PRIORITY.ESSENTIAL).some((r) => r.condition.requestDomains?.includes('accounts.google.com')));
  assert.deepEqual(rules.map((r) => r.id), rules.map((_, i) => i + 1));
});

test('blocklist mode has no catch-all and essentials can be turned off', () => {
  const config = normalizeConfig({ block: ['google.com'], protectEssentials: false });
  const rules = buildRules(effectivePolicy(config, at(MON, '09:00')), config, 'abc');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].priority, PRIORITY.BLOCK);
});

test('blockEmbeds adds sub_frame rules', () => {
  const config = normalizeConfig({ mode: 'allowlist', blockEmbeds: true });
  const rules = buildRules(effectivePolicy(config, at(MON, '09:00')), config, 'abc');
  assert.ok(rules.some((r) => r.condition.resourceTypes.includes('sub_frame') && r.action.type === 'block'));
});

test('pathRegex matches the domain, subdomains, and the path prefix only', () => {
  const re = new RegExp(pathRegex(parseEntry('youtube.com/shorts')), 'i');
  assert.ok(re.test('https://youtube.com/shorts/abc'));
  assert.ok(re.test('https://m.youtube.com/shorts'));
  assert.ok(!re.test('https://youtube.com/watch?v=1'));
  assert.ok(!re.test('https://notyoutube.com/shorts'));
});

test('localTime honors a configured time zone', () => {
  const t = localTime(new Date('2026-10-26T15:30:00Z'), 'America/Denver'); // a Monday
  assert.deepEqual(t, at(MON, '09:30'));
});

test('allowsPage mirrors the static rules for in-page navigations', () => {
  const config = normalizeConfig({ mode: 'allowlist', allow: ['wikipedia.org', 'youtube.com/edu'], approvedSources: ['classroom.google.com'] });
  const policy = effectivePolicy(config, at(MON, '09:00'));
  assert.ok(allowsPage('https://en.wikipedia.org/wiki/X', policy, config));
  assert.ok(allowsPage('https://youtube.com/edu/x', policy, config));
  assert.ok(allowsPage('https://classroom.google.com/c/1', policy, config));
  assert.ok(allowsPage('https://accounts.google.com/signin', policy, config));
  assert.ok(!allowsPage('https://www.youtube.com/watch?v=B', policy, config));
  const block = normalizeConfig({ block: ['youtube.com'], allow: ['youtube.com/edu'] });
  const bp = effectivePolicy(block, at(MON, '09:00'));
  assert.ok(!allowsPage('https://www.youtube.com/watch?v=B', bp, block));
  assert.ok(allowsPage('https://www.youtube.com/edu', bp, block));
  assert.ok(allowsPage('https://example.com/', bp, block));
});

test('isSamePage: another video is a different page', () => {
  const linked = 'https://www.youtube.com/watch?v=A&si=xyz';
  assert.ok(isSamePage(linked, 'https://www.youtube.com/watch?v=A'));
  assert.ok(isSamePage(linked, 'https://www.youtube.com/watch?v=A&t=30s'));
  assert.ok(isSamePage(linked, 'https://www.youtube.com/watch?v=A#comments'));
  assert.ok(!isSamePage(linked, 'https://www.youtube.com/watch?v=B'));
  assert.ok(!isSamePage(linked, 'https://www.youtube.com/shorts/A'));
  assert.ok(!isSamePage(linked, 'https://www.youtube.com/'));
});

test('isSettling: same-site URL changes are accepted only right after the link opens', () => {
  const tab = { linked: 'https://www.youtube.com/watch?v=A&feature=youtu.be', linkedAt: 1000 };
  const soon = 1000 + LINK_SETTLE_MS - 1;
  assert.ok(isSettling(tab, 'https://www.youtube.com/watch?v=A&pp=xyz', 1500));
  assert.ok(isSettling(tab, 'https://youtube.com/watch?v=B', soon));
  assert.ok(!isSettling(tab, 'https://www.youtube.com/watch?v=B', 1000 + LINK_SETTLE_MS));
  assert.ok(!isSettling(tab, 'https://example.com/', 1500));
  assert.ok(!isSettling({ linked: tab.linked }, 'https://www.youtube.com/watch?v=B', 1500));
  assert.ok(!isSettling(undefined, 'https://www.youtube.com/', 1500));
});

// --- Temporary allows --------------------------------------------------------

const NOW = 1_000_000;

test('makeTempAllow: whole site or only the page, for a bounded time', () => {
  const site = makeTempAllow('https://www.YouTube.com/shorts/x#c', 'site', 30, NOW);
  assert.deepEqual(site, { scope: 'site', site: 'youtube.com', url: 'https://www.youtube.com/shorts/x', until: NOW + 30 * 60000 });
  const page = makeTempAllow('https://www.youtube.com/watch?v=A', 'page', 5, NOW);
  assert.deepEqual(page, { scope: 'page', url: 'https://www.youtube.com/watch?v=A', until: NOW + 5 * 60000 });
  assert.equal(makeTempAllow('https://a.com/', 'site', 0, NOW), null);
  assert.equal(makeTempAllow('https://a.com/', 'site', 1441, NOW), null);
  assert.equal(makeTempAllow('https://a.com/', 'everyone', 5, NOW), null);
  assert.equal(makeTempAllow('chrome://settings', 'site', 5, NOW), null);
});

test('activeTempAllows drops expired and malformed entries', () => {
  const ok = makeTempAllow('https://a.com/', 'site', 1, NOW);
  const old = { ...ok, until: NOW };
  assert.deepEqual(activeTempAllows([ok, old, null, { scope: 'site', url: 'x', until: NOW + 1 }], NOW), [ok]);
  assert.deepEqual(activeTempAllows(undefined, NOW), []);
});

test('a whole-site allow beats blocks and allowlist mode, for every page on the site', () => {
  const config = normalizeConfig({ mode: 'allowlist', block: ['youtube.com/shorts'], blockEmbeds: true });
  const policy = effectivePolicy(config, at(MON, '09:00'));
  const temp = makeTempAllow('https://www.youtube.com/shorts/x', 'site', 10, NOW);
  assert.ok(!allowsPage('https://m.youtube.com/watch?v=B', policy, config));
  assert.ok(allowsPage('https://m.youtube.com/watch?v=B', policy, config, [temp]));
  assert.ok(allowsPage('https://www.youtube.com/shorts/y', policy, config, [temp]));
  assert.ok(!allowsPage('https://notyoutube.com/', policy, config, [temp]));

  const rules = buildRules(policy, config, 'ext', [temp]);
  const rule = rules.find((r) => r.condition.requestDomains?.[0] === 'youtube.com' && r.action.type === 'allow');
  assert.ok(rule, 'no allow rule for the site');
  assert.ok(rule.priority > PRIORITY.BLOCK && rule.priority > PRIORITY.CATCH_ALL);
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
});

test('a page-only allow covers that page, not the rest of the site', () => {
  const config = normalizeConfig({ block: ['youtube.com'] });
  const policy = effectivePolicy(config, at(MON, '09:00'));
  const temp = makeTempAllow('https://www.youtube.com/watch?v=A&si=x', 'page', 10, NOW);
  assert.ok(allowsPage('https://www.youtube.com/watch?v=A', policy, config, [temp]));
  assert.ok(allowsPage('https://www.youtube.com/watch?v=A&t=30', policy, config, [temp]));
  assert.ok(!allowsPage('https://www.youtube.com/watch?v=B', policy, config, [temp]));
  assert.ok(!allowsPage('https://www.youtube.com/', policy, config, [temp]));
  assert.ok(!tempAllows(temp, 'https://m.youtube.com/watch?v=A'));

  const rules = buildRules(policy, config, 'ext', [temp]);
  const rule = rules.find((r) => r.condition.regexFilter === pageRegex(temp.url));
  assert.ok(rule && rule.action.type === 'allow' && rule.priority > PRIORITY.BLOCK);
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
  const re = new RegExp(rule.condition.regexFilter);
  assert.ok(re.test('https://www.youtube.com/watch?v=A'));
  assert.ok(re.test('https://www.youtube.com/watch'));
  assert.ok(!re.test('https://www.youtube.com/watch2?v=A'));
  assert.ok(!re.test('https://www.youtube.com/'));
  assert.ok(!re.test('https://www.youtube.com.evil.com/watch'));
});

// --- Password ----------------------------------------------------------------

test('passwords are stored as a PBKDF2 hash and verified', async () => {
  const stored = await hashPassword('correct horse', undefined, 1000);
  assert.ok(parsePasswordHash(stored));
  assert.ok(!stored.includes('correct horse'));
  assert.ok(await verifyPassword('correct horse', stored));
  assert.ok(!(await verifyPassword('Correct horse', stored)));
  assert.ok(!(await verifyPassword('', stored)));
  assert.ok(!(await verifyPassword('correct horse', 'correct horse')));
  assert.notEqual(stored, await hashPassword('correct horse', undefined, 1000), 'salt should differ');
});

test('normalizeConfig keeps only a well-formed password hash', async () => {
  const stored = await hashPassword('pw123456', undefined, 1000);
  assert.equal(normalizeConfig({ overridePassword: stored }).overridePassword, stored);
  assert.equal(normalizeConfig({ overridePassword: 'plaintext' }).overridePassword, '');
  assert.equal(normalizeConfig({}).overridePassword, '');
});
