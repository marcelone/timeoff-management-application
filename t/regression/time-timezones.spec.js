'use strict';

/*
 * Timezone configuration — block 1 regressions.
 *
 * Covers: centre > company > UTC inheritance (and its display), server-side IANA
 * validation, permissions, cross-company isolation, weekly resolution in zones
 * ahead of UTC (Monday must stay first), DST handling, and the rule that changing
 * the configuration never rewrites recorded UTC instants.
 */

const assert = require('assert');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login } = H;

const scheduleUtil = require('../../lib/modules/time/schedule');

async function seedWeek({ companyId, scopeType, scopeId, days }) {
  await db.WorkScheduleDay.destroy({ where: { companyId, scopeType, scopeId } });
  await db.WorkScheduleDay.bulkCreate(days.map((d) => ({
    companyId,
    scopeType,
    scopeId,
    weekday: d.weekday,
    isWorkingDay: !d.off,
    startTime: d.off ? null : d.start,
    endTime: d.off ? null : d.end,
  })));
}

describe('timezone configuration — block 1', () => {

  describe('inheritance: centre > company > UTC', () => {
    it('resolves the source of the effective timezone', () => {
      assert.deepStrictEqual(
        scheduleUtil.resolveTimezoneInfo({ workCenter: { timezone: 'Europe/Lisbon' }, company: { timezone: 'Europe/Madrid' } }),
        { timezone: 'Europe/Lisbon', source: 'workCenter' }
      );
      assert.deepStrictEqual(
        scheduleUtil.resolveTimezoneInfo({ workCenter: { timezone: null }, company: { timezone: 'Europe/Madrid' } }),
        { timezone: 'Europe/Madrid', source: 'company' }
      );
      assert.deepStrictEqual(
        scheduleUtil.resolveTimezoneInfo({ workCenter: null, company: { timezone: null } }),
        { timezone: 'UTC', source: 'UTC' }
      );
      // Backwards-compatible string accessor.
      assert.strictEqual(
        scheduleUtil.resolveTimezone({ workCenter: { timezone: 'Europe/Lisbon' }, company: { timezone: 'Europe/Madrid' } }),
        'Europe/Lisbon'
      );
    });

    it('uses the employee\'s centre on /time and states where the zone comes from', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      await db.Company.update({ timezone: 'Europe/Madrid' }, { where: { id: user.companyId } });
      const centre = await db.WorkCenter.create({
        companyId: user.companyId, name: 'Lisbon office', timezone: 'Europe/Lisbon',
      });
      await db.User.update({ workCenterId: centre.id }, { where: { id: emp.user.id } });

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('Europe/Lisbon'), 'centre zone shown');
      assert.ok(/work centre/i.test(page.text), 'origin is stated');

      // Removing the centre zone falls back to the company, and says so.
      await db.WorkCenter.update({ timezone: null }, { where: { id: centre.id } });
      const fallback = await empAg.get('/time/');
      assert.ok(fallback.text.includes('Europe/Madrid'), 'company zone shown');
      assert.ok(/\(company\)/i.test(fallback.text), 'company origin is stated');
    });

    it('falls back to UTC when neither centre nor company has a zone', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      await db.Company.update({ timezone: null }, { where: { id: user.companyId } });

      const page = await ag.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('UTC'), 'UTC fallback shown');
      assert.ok(/fallback/i.test(page.text), 'fallback origin is stated');
    });
  });

  describe('work centre configuration', () => {
    it('creates a centre that inherits, then sets an IANA zone, then inherits again', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);

      let res = await postForm(ag, '/settings/workcenters/', {
        name: 'HQ', address: 'Main street 1', timezone: '',
      });
      assert.ok([302, 303].includes(res.status));
      let centre = await db.WorkCenter.findOne({ where: { companyId: user.companyId, name: 'HQ' } });
      assert.ok(centre, 'centre created');
      assert.strictEqual(centre.timezone, null, 'empty value means inherit');

      res = await postForm(ag, '/settings/workcenters/' + centre.id + '/', {
        name: 'HQ', address: 'Main street 1', timezone: 'Pacific/Auckland',
      });
      assert.ok([302, 303].includes(res.status));
      centre = await db.WorkCenter.findByPk(centre.id);
      assert.strictEqual(centre.timezone, 'Pacific/Auckland');

      res = await postForm(ag, '/settings/workcenters/' + centre.id + '/', {
        name: 'HQ', address: 'Main street 1', timezone: 'inherit',
      });
      assert.ok([302, 303].includes(res.status));
      centre = await db.WorkCenter.findByPk(centre.id);
      assert.strictEqual(centre.timezone, null, '"inherit" clears the zone again');
    });

    it('rejects an invalid IANA zone on the centre and keeps the stored value', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const centre = await db.WorkCenter.create({
        companyId: user.companyId, name: 'Madrid', timezone: 'Europe/Madrid',
      });

      for (const bad of ['Mars/Olympus', 'Europe/Atlantis', 'not a zone', '../../etc/passwd']) {
        const res = await postForm(ag, '/settings/workcenters/' + centre.id + '/', {
          name: 'Madrid', address: '', timezone: bad,
        });
        assert.ok([302, 303].includes(res.status), 'handled with a redirect');
        const after = await db.WorkCenter.findByPk(centre.id);
        assert.strictEqual(after.timezone, 'Europe/Madrid', 'invalid zone "' + bad + '" not stored');
      }

      // And creating a new centre with an invalid zone must not create anything.
      const before = await db.WorkCenter.count({ where: { companyId: user.companyId } });
      await postForm(ag, '/settings/workcenters/', { name: 'Bad', timezone: 'Mars/Olympus' });
      assert.strictEqual(await db.WorkCenter.count({ where: { companyId: user.companyId } }), before);
    });

    it('keeps the company timezone validation working with the same IANA list', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const before = (await db.Company.findByPk(user.companyId)).timezone;

      const res = await postForm(ag, '/settings/company/', {
        name: 'Co', country: 'es', date_format: 'YYYY-MM-DD',
        timezone: 'Mars/Olympus', carry_over: '0',
      });
      assert.ok([302, 303].includes(res.status));
      const after = (await db.Company.findByPk(user.companyId)).timezone;
      assert.strictEqual(after, before, 'invalid company zone rejected');

      const ok = await postForm(ag, '/settings/company/', {
        name: 'Co', country: 'es', date_format: 'YYYY-MM-DD',
        timezone: 'Pacific/Kiritimati', carry_over: '0',
      });
      assert.ok([302, 303].includes(ok.status));
      assert.strictEqual((await db.Company.findByPk(user.companyId)).timezone, 'Pacific/Kiritimati');
    });

    it('is guarded by permissions: employees cannot read or write centres', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const page = await empAg.get('/settings/workcenters/');
      assert.ok([302, 303].includes(page.status), 'redirected away');

      const before = await db.WorkCenter.count({ where: { companyId: user.companyId } });
      const post = await postForm(empAg, '/settings/workcenters/', {
        name: 'Sneaky', timezone: 'Europe/Madrid',
      });
      assert.ok([302, 303].includes(post.status));
      assert.strictEqual(await db.WorkCenter.count({ where: { companyId: user.companyId } }), before,
        'employee cannot create a centre');
    });

    it('rejects unauthenticated access', async () => {
      const anon = agent();
      const page = await anon.get('/settings/workcenters/');
      assert.ok([302, 303].includes(page.status));
    });

    it('isolates companies: no listing and no writes across tenants', async () => {
      const aAg = agent();
      const A = await registerAdmin(aAg, { company: 'TzA' });
      const aCentre = await db.WorkCenter.create({
        companyId: A.user.companyId, name: 'A-only', timezone: 'Europe/Madrid',
      });

      const bAg = agent();
      const B = await registerAdmin(bAg, { company: 'TzB' });

      const page = await bAg.get('/settings/workcenters/');
      assert.strictEqual(page.status, 200);
      assert.ok(!page.text.includes('A-only'), 'B does not list A\'s centre');

      // B tries to edit A's centre by id.
      const res = await postForm(bAg, '/settings/workcenters/' + aCentre.id + '/', {
        name: 'hijacked', timezone: 'Pacific/Auckland',
      });
      assert.ok([302, 303].includes(res.status));
      const after = await db.WorkCenter.findByPk(aCentre.id);
      assert.strictEqual(after.name, 'A-only', 'name untouched');
      assert.strictEqual(after.timezone, 'Europe/Madrid', 'zone untouched');
      assert.strictEqual(after.companyId, A.user.companyId);
      assert.ok(B.user.companyId !== A.user.companyId);
    });
  });

  describe('weekly resolution in zones ahead of UTC', () => {
    it('keeps Monday first and Sunday last for Pacific/Auckland and Pacific/Kiritimati', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const companyId = user.companyId;

      // Distinct hours per weekday so a shifted day is detectable.
      const days = [
        { weekday: 1, start: '08:00', end: '12:00' },
        { weekday: 2, start: '09:00', end: '13:00' },
        { weekday: 3, start: '10:00', end: '14:00' },
        { weekday: 4, start: '11:00', end: '15:00' },
        { weekday: 5, start: '12:00', end: '16:00' },
        { weekday: 6, start: '13:00', end: '17:00' },
        { weekday: 7, start: '14:00', end: '18:00' },
      ];
      await seedWeek({ companyId, scopeType: 'company', scopeId: companyId, days });

      const freshUser = await db.User.findByPk(emp.user.id);

      for (const zone of ['Pacific/Auckland', 'Pacific/Kiritimati', 'UTC', 'America/New_York']) {
        const week = await scheduleUtil.resolveWeekForUser({ models: db, user: freshUser, timezone: zone });
        assert.strictEqual(week.length, 7, zone + ': seven days');
        assert.deepStrictEqual(
          week.map((d) => d && d.weekday),
          [1, 2, 3, 4, 5, 6, 7],
          zone + ': index order must follow Monday..Sunday'
        );
        assert.strictEqual(week[0].startTime, '08:00', zone + ': Monday keeps Monday hours');
        assert.strictEqual(week[6].startTime, '14:00', zone + ': Sunday keeps Sunday hours');
      }
    });
  });

  describe('daylight saving time', () => {
    it('renders the Madrid DST switch correctly (CET -> CEST)', () => {
      // 2026-03-29: 02:00 local becomes 03:00 (01:00 UTC).
      const beforeSwitch = new Date('2026-03-29T00:30:00Z');
      const afterSwitch = new Date('2026-03-29T01:30:00Z');
      assert.strictEqual(scheduleUtil.formatTimeInZone(beforeSwitch, 'Europe/Madrid'), '01:30');
      assert.strictEqual(scheduleUtil.formatTimeInZone(afterSwitch, 'Europe/Madrid'), '03:30');
    });

    it('measures real elapsed time across the switch, not wall-clock difference', () => {
      const start = new Date('2026-03-29T00:30:00Z');
      const end = new Date('2026-03-29T01:30:00Z');
      // One real hour, even though the local clock jumps from 01:30 to 03:30.
      assert.strictEqual(scheduleUtil.elapsedMinutes(start, end), 60);
      assert.strictEqual(scheduleUtil.formatTimeInZone(start, 'Europe/Madrid'), '01:30');
      assert.strictEqual(scheduleUtil.formatTimeInZone(end, 'Europe/Madrid'), '03:30');
    });

    it('resolves the weekday correctly on the DST changeover day', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await seedWeek({
        companyId: user.companyId, scopeType: 'company', scopeId: user.companyId,
        days: [{ weekday: 7, start: '09:00', end: '17:00' }],
      });

      const freshUser = await db.User.findByPk(emp.user.id);
      const sundayDuringSwitch = new Date('2026-03-29T01:30:00Z'); // Sunday in Madrid
      const resolved = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: sundayDuringSwitch, timezone: 'Europe/Madrid',
      });
      assert.ok(resolved, 'Sunday schedule resolved');
      assert.strictEqual(resolved.weekday, 7);
    });
  });

  describe('configuration changes never rewrite recorded entries', () => {
    it('keeps the stored UTC instant when the company timezone changes', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      await db.Company.update({ timezone: 'UTC' }, { where: { id: user.companyId } });
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const res = await postForm(empAg, '/time/start', { modality: 'office' });
      assert.ok([302, 303].includes(res.status));

      const before = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });
      const instantBefore = new Date(before.startedAt).getTime();

      // Change configuration through the real settings route.
      const upd = await postForm(ag, '/settings/company/', {
        name: 'Co', country: 'es', date_format: 'YYYY-MM-DD',
        timezone: 'Pacific/Kiritimati', carry_over: '0',
      });
      assert.ok([302, 303].includes(upd.status));

      const after = await db.TimeEntry.findByPk(before.id);
      assert.strictEqual(new Date(after.startedAt).getTime(), instantBefore, 'instant is unchanged');
      assert.strictEqual(after.status, 'open', 'state unchanged');
      const events = await db.TimeEntryEvent.count({ where: { timeEntryId: before.id } });
      assert.strictEqual(events, 1, 'events unchanged');

      const page = await empAg.get('/time/');
      assert.ok(page.text.includes('Pacific/Kiritimati'), 'display uses the new zone');
    });
  });
});