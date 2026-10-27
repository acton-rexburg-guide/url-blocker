import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEntry, parseList, normalizeConfig, isScheduleActive, effectivePolicy, nextChange,
  buildRules, pathRegex, localTime, PRIORITY,
} from '../extension/lib/policy.js';

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
