import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { loadState, updateState, stateChangesFromAgent } from '../../lib/comply-agent';

const BASE = 'https://test-project.supabase.co/rest/v1/thread_state';

// An in-memory thread_state table with the database's real rules: insert is
// ignored if the row exists, and an update only applies if the version matches.
function fakeThreadStateTable({ beforeWrite } = {}) {
  const rows = new Map();
  const threadOf = (url) => url.searchParams.get('thread_ts')?.replace(/^eq\./, '');
  server.use(
    http.get(BASE, ({ request }) => {
      const row = rows.get(threadOf(new URL(request.url)));
      return HttpResponse.json(row ? [{ state: row.state, version: row.version }] : []);
    }),
    http.post(BASE, async ({ request }) => {
      const body = await request.json();
      await beforeWrite?.(body.thread_ts);
      if (rows.has(body.thread_ts)) return HttpResponse.json([]);
      rows.set(body.thread_ts, { state: body.state, version: body.version });
      return HttpResponse.json([{ state: body.state }], { status: 201 });
    }),
    http.patch(BASE, async ({ request }) => {
      const url = new URL(request.url);
      const ts = threadOf(url);
      await beforeWrite?.(ts);
      const expected = Number(url.searchParams.get('version')?.replace(/^eq\./, ''));
      const body = await request.json();
      const row = rows.get(ts);
      if (!row || row.version !== expected) return HttpResponse.json([]);
      rows.set(ts, { state: body.state, version: body.version });
      return HttpResponse.json([{ state: body.state }]);
    })
  );
  return rows;
}

describe('comply bot saves progress without losing a concurrent approval', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('builds the changes from one agent turn', () => {
    expect(
      stateChangesFromAgent({
        managerName: 'Pat',
        tenantData: { tenantName: 'John Doe', city: 'Seattle' },
        sectionApprovals: [{ section_number: 2, content: 'S2' }],
      })
    ).toEqual({ managerName: 'Pat', tenantName: 'John Doe', city: 'Seattle', section2: 'S2' });
    expect(stateChangesFromAgent({ sectionApprovals: [] })).toEqual({});
  });

  it('first save creates the thread, later saves add to it', async () => {
    const rows = fakeThreadStateTable();
    await updateState('t1', { tenantName: 'John Doe' });
    const merged = await updateState('t1', { section1: 'S1' });
    expect(merged).toEqual({ tenantName: 'John Doe', section1: 'S1' });
    expect(rows.get('t1').version).toBe(2);
    expect(await loadState('t1')).toEqual({ tenantName: 'John Doe', section1: 'S1' });
  });

  it('two approve clicks that land at the same moment both keep their section', async () => {
    // Pause each write until both clicks have read the same version, the race
    // that used to let the second click erase the first click's section.
    let reads = 0;
    let release;
    const bothRead = new Promise((r) => (release = r));
    const rows = fakeThreadStateTable({
      beforeWrite: async () => {
        reads += 1;
        if (reads === 2) release();
        await bothRead;
      },
    });
    rows.set('t2', { state: { tenantName: 'John Doe', section1: 'S1' }, version: 3 });

    const [a, b] = await Promise.all([updateState('t2', { section2: 'S2' }), updateState('t2', { section3: 'S3' })]);

    expect(rows.get('t2')).toEqual({
      state: { tenantName: 'John Doe', section1: 'S1', section2: 'S2', section3: 'S3' },
      version: 5,
    });
    // Whichever click saved second sees all three sections, so the PDF is built from complete progress.
    expect([a, b].some((s) => s.section1 && s.section2 && s.section3)).toBe(true);
  });

  it('two brand-new threads racing to be created do not overwrite each other', async () => {
    let writes = 0;
    let release;
    const both = new Promise((r) => (release = r));
    const rows = fakeThreadStateTable({
      beforeWrite: async () => {
        writes += 1;
        if (writes === 2) release();
        await both;
      },
    });
    await Promise.all([updateState('t3', { tenantName: 'John Doe' }), updateState('t3', { managerName: 'Pat' })]);
    expect(rows.get('t3').state).toEqual({ tenantName: 'John Doe', managerName: 'Pat' });
  });

  it('a save that keeps colliding gives up with a clear message instead of silently dropping data', async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([{ state: {}, version: 1 }])),
      http.patch(BASE, () => HttpResponse.json([]))
    );
    await expect(updateState('t4', { section1: 'S1' })).rejects.toThrow(/please try that step again/);
  });

  it('a database error while saving is reported, not swallowed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.get(BASE, () => HttpResponse.json([])),
      http.post(BASE, () => HttpResponse.json({ message: 'boom' }, { status: 500 }))
    );
    await expect(updateState('t5', { section1: 'S1' })).rejects.toThrow(/Could not save the notice progress \(HTTP 500\)/);
  });
});
