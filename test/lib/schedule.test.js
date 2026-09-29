import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { pacificParts, isPacificHour, samePacificDay, clampScore } from '../../lib/schedule';
import { digestGate } from '../../pages/api/digest';
import { formatSlackMessage } from '../../pages/api/weekday-one-priority';
import vercel from '../../vercel.json';

// 13:30 UTC is 6:30 AM in summer (PDT); 14:30 UTC is 6:30 AM in winter (PST).
const SUMMER_1330 = new Date('2026-09-30T13:30:00Z');
const SUMMER_1430 = new Date('2026-09-30T14:30:00Z');
const WINTER_1330 = new Date('2026-12-02T13:30:00Z');
const WINTER_1430 = new Date('2026-12-02T14:30:00Z');

describe('6:30 AM Pacific, year-round', () => {
  it('the digest cron fires at both UTC candidates', () => {
    const digest = vercel.crons.find((c) => c.path === '/api/digest');
    const priority = vercel.crons.find((c) => c.path === '/api/weekday-one-priority');
    expect(digest.schedule).toBe('30 13,14 * * *');
    expect(priority.schedule).toBe('25 13,14 * * 1-5');
  });

  it('exactly one of the two fires is in the 6 AM hour, in summer and in winter', () => {
    expect([isPacificHour(SUMMER_1330, 6), isPacificHour(SUMMER_1430, 6)]).toEqual([true, false]);
    expect([isPacificHour(WINTER_1330, 6), isPacificHour(WINTER_1430, 6)]).toEqual([false, true]);
    expect(pacificParts(WINTER_1430)).toMatchObject({ hour: 6, minute: 30, date: '2026-12-02' });
  });

  it('samePacificDay uses the Seattle calendar day, not UTC', () => {
    // 11 PM Pacific on 9/29 is already 9/30 in UTC -- still "yesterday" at 6:30 AM on 9/30.
    expect(samePacificDay('2026-09-30T06:00:00Z', SUMMER_1330)).toBe(false);
    expect(samePacificDay('2026-09-30T13:31:00Z', SUMMER_1330)).toBe(true);
    expect(samePacificDay(null, SUMMER_1330)).toBe(false);
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
    expect(await digestGate(false, SUMMER_1430)).toMatchObject({ run: false });
  });

  it('runs at 6:30 when nothing has posted today', async () => {
    lastPostedRun('2026-09-29T13:31:00Z');
    expect(await digestGate(false, SUMMER_1330)).toMatchObject({ run: true });
  });

  it('never posts twice in one day (the 9/28 double digest)', async () => {
    lastPostedRun('2026-09-30T13:30:05Z');
    expect(await digestGate(false, new Date('2026-09-30T13:34:00Z'))).toEqual({ run: false, reason: 'already posted today' });
  });

  it('force=1 always runs, for a manual re-run', async () => {
    lastPostedRun('2026-09-30T13:30:05Z');
    expect(await digestGate(true, SUMMER_1430)).toMatchObject({ run: true });
  });
});

describe('One Priority post', () => {
  it('never shows a confidence above 5 (the "7/5" bug)', () => {
    expect(clampScore(7)).toBe(5);
    expect(clampScore(0)).toBe(1);
    expect(clampScore('4')).toBe(4);
    expect(clampScore(undefined)).toBe(null);
    const text = formatSlackMessage({ title: 'T', activity: 'A', scoring: { confidence: 7 } }, '2026-09-30');
    expect(text).toContain('*Confidence:* 5/5');
    expect(text).not.toMatch(/[6-9]\/5/);
  });
});
