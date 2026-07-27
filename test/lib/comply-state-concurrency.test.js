import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { loadState, saveState } from '../../lib/comply-agent';

// A minimal in-memory stand-in for the thread_state table's actual CAS
// semantics (unique-key insert, version-gated update), precise enough to
// exercise the real race: two callers who both loaded the row at version N
// racing to write -- the second writer must retry against the row the first
// writer actually left behind, not silently clobber it.
function fakeThreadStateTable() {
  const rows = new Map();

  return [
    http.post('https://test-project.supabase.co/rest/v1/thread_state', async ({ request }) => {
      const body = await request.json();
      if (rows.has(body.thread_ts)) {
        return HttpResponse.json([]); // ignore-duplicates: conflict, no row returned
      }
      rows.set(body.thread_ts, { state: body.state, version: body.version });
      return HttpResponse.json([{ state: body.state, version: body.version }], { status: 201 });
    }),

    http.patch('https://test-project.supabase.co/rest/v1/thread_state', async ({ request }) => {
      const url = new URL(request.url);
      const threadTs = url.searchParams.get('thread_ts')?.replace('eq.', '');
      const expectedVersion = Number(url.searchParams.get('version')?.replace('eq.', ''));
      const body = await request.json();

      const row = rows.get(threadTs);
      if (!row || row.version !== expectedVersion) {
        return HttpResponse.json([]); // version mismatch -- CAS fails
      }
      rows.set(threadTs, { state: body.state, version: body.version });
      return HttpResponse.json([{ state: body.state, version: body.version }]);
    }),

    http.get('https://test-project.supabase.co/rest/v1/thread_state', ({ request }) => {
      const url = new URL(request.url);
      const threadTs = url.searchParams.get('thread_ts')?.replace('eq.', '');
      const row = rows.get(threadTs);
      return HttpResponse.json(row ? [{ state: row.state, version: row.version }] : []);
    }),

    rows,
  ];
}

describe('comply-agent thread_state optimistic concurrency', () => {
  let rows;

  beforeEach(() => {
    const handlers = fakeThreadStateTable();
    rows = handlers.pop();
    server.use(...handlers);
  });

  it('two saves against a brand-new thread both land (insert then version-gated update)', async () => {
    const threadTs = '1700000000.000001';

    const first = await loadState(threadTs);
    expect(first.version).toBeNull();
    await saveState(threadTs, { tenantName: 'John Doe' }, first.version, first.state);

    const second = await loadState(threadTs);
    expect(second.version).toBe(1);
    await saveState(threadTs, { section1: 'Section 1 text.' }, second.version, second.state);

    const final = await loadState(threadTs);
    expect(final.state).toEqual({ tenantName: 'John Doe', section1: 'Section 1 text.' });
    expect(final.version).toBe(2);
  });

  it('a version conflict (simulating two near-simultaneous approve clicks) retries and merges rather than losing data', async () => {
    const threadTs = '1700000000.000002';
    rows.set(threadTs, { state: { tenantName: 'John Doe', section1: 'Section 1 text.' }, version: 1 });

    // Both "clicks" load the same version 1 state before either writes.
    const clickA = await loadState(threadTs);
    const clickB = await loadState(threadTs);
    expect(clickA.version).toBe(1);
    expect(clickB.version).toBe(1);

    // Click A (approves section 2) writes first and wins outright.
    await saveState(threadTs, { section2: 'Section 2 text.' }, clickA.version, clickA.state);
    expect(rows.get(threadTs)).toEqual({
      state: { tenantName: 'John Doe', section1: 'Section 1 text.', section2: 'Section 2 text.' },
      version: 2,
    });

    // Click B (approves section 3) still has the stale version=1 in hand --
    // its first write attempt must fail the CAS check and retry against the
    // row Click A actually left, merging on top rather than overwriting it.
    await saveState(threadTs, { section3: 'Section 3 text.' }, clickB.version, clickB.state);

    const final = rows.get(threadTs);
    expect(final.version).toBe(3);
    // Both approvals survive -- neither click's section was lost.
    expect(final.state).toEqual({
      tenantName: 'John Doe',
      section1: 'Section 1 text.',
      section2: 'Section 2 text.',
      section3: 'Section 3 text.',
    });
  });
});
