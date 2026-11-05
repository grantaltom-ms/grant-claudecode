import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { pacificParts, isPacificHour, samePacificDay, clampScore } from '../../lib/schedule';
import { digestGate } from '../../pages/api/digest';
import vercel from '../../vercel.json';

// 14:30 UTC is 7:30 AM in summer (PDT, UTC-7); 15:30 UTC is 7:30 AM in winter (PST, UTC-8).
const SUMMER_1430 = new Date('2026-09-30T14:30:00Z');
const SUMMER_1530 = new Date('2026-09-30T15:30:00Z');
const WINTER_1430 = new Date('2026-12-02T14:30:00Z');
const WINTER_1530 = new Date('2026-12-02T15:30:00Z');

describe('7:30 AM Pacific, Monday to Friday, year-round', () => {
  it('the digest cron fires at both UTC candidates, weekdays only', () => {
    const digest = vercel.crons.find((c) => c.path === '/api/digest');
    expect(digest.schedule).toBe('30 14,15 * * 1-5');
  });

  it('exactly one of the two fires is in the 7 AM hour, in summer and in winter', () => {
    expect([isPacificHour(SUMMER_1430, 7), isPacificHour(SUMMER_1530, 7)]).toEqual([true, false]);
    expect([isPacificHour(WINTER_1430, 7), isPacificHour(WINTER_1530, 7)]).toEqual([false, true]);
    expect(pacificParts(WINTER_1530)).toMatchObject({ hour: 7, minute: 30, date: '2026-12-02' });
    expect(pacificParts(SUMMER_1430)).toMatchObject({ hour: 7, minute: 30, date: '2026-09-30' });
  });

  it('the UTC hours 15 and 16 would never fire in the 7 AM hour during daylight saving', () => {
    // Guards the cron hours above: 15:30 UTC is 8:30 AM PDT and 16:30 UTC is
    // 9:30 AM PDT, so a "30 15,16" schedule would be skipped by the hour gate
    // every day from March to November.
    const summer1530 = new Date('2026-07-15T15:30:00Z');
    const summer1630 = new Date('2026-07-15T16:30:00Z');
    expect([isPacificHour(summer1530, 7), isPacificHour(summer1630, 7)]).toEqual([false, false]);
  });

  it('the Weekday One Priority post is gone', () => {
    expect(vercel.crons.map((c) => c.path)).toEqual(['/api/digest', '/api/memory-maintenance']);
  });

  it('samePacificDay uses the Seattle calendar day, not UTC', () => {
    // 11 PM Pacific on 9/29 is already 9/30 in UTC -- still "yesterday" at 7:30 AM on 9/30.
    expect(samePacificDay('2026-09-30T06:00:00Z', SUMMER_1430)).toBe(false);
    expect(samePacificDay('2026-09-30T14:31:00Z', SUMMER_1430)).toBe(true);
    expect(samePacificDay(null, SUMMER_1430)).toBe(false);
  });
});

describe('digestGate', () => {
  function lastPostedRun(runStartedAt) {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/digest_runs', () =>
        HttpResponse.json(runStartedAt ? [{ run_started_at: runStartedAt, status: 'posted' }] : [])
      )
    );
  }

  it('skips the off-hour fire', async () => {
    lastPostedRun(null);
    expect(await digestGate(false, SUMMER_1530)).toMatchObject({ run: false });
  });

  it('skips the 6:30 AM hour the digest used to run in', async () => {
    lastPostedRun(null);
    expect(await digestGate(false, new Date('2026-09-30T13:30:00Z'))).toMatchObject({ run: false });
  });

  it('runs at 7:30 when nothing has posted today', async () => {
    lastPostedRun('2026-09-29T14:31:00Z');
    expect(await digestGate(false, SUMMER_1430)).toMatchObject({ run: true });
  });

  it('never posts twice in one day (the 9/28 double digest)', async () => {
    lastPostedRun('2026-09-30T14:30:05Z');
    expect(await digestGate(false, new Date('2026-09-30T14:34:00Z'))).toEqual({ run: false, reason: 'already posted today' });
  });

  it('force=1 always runs, for a manual re-run', async () => {
    lastPostedRun('2026-09-30T14:30:05Z');
    expect(await digestGate(true, SUMMER_1530)).toMatchObject({ run: true });
  });
});

describe('clampScore (shared helper)', () => {
  it('keeps a score on the 1..5 scale', () => {
    expect(clampScore(7)).toBe(5);
    expect(clampScore(0)).toBe(1);
    expect(clampScore('4')).toBe(4);
    expect(clampScore(undefined)).toBe(null);
  });
});
