import { describe, it, expect, vi } from 'vitest';
import {
  planBatches, triageOnce, mergeTriageReplies, runTriage,
  TRIAGE_MAX_TOKENS, TRIAGE_RETRY_MAX_TOKENS,
} from '../../lib/digest-triage';
import { responseText } from '../../lib/claude';

const quiet = { log: vi.fn(), warn: vi.fn() };
const ok = (text) => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], stop_reason: 'end_turn' });
const cut = () => ({ content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' });

describe('planBatches', () => {
  it('keeps up to 50 in one call', () => {
    expect(planBatches(0)).toEqual([]);
    expect(planBatches(1)).toEqual([{ start: 1, end: 1 }]);
    expect(planBatches(50)).toEqual([{ start: 1, end: 50 }]);
  });

  it('splits more than 50 into even batches of at most 40 that cover every number once', () => {
    expect(planBatches(51)).toEqual([{ start: 1, end: 26 }, { start: 27, end: 51 }]);
    expect(planBatches(80)).toEqual([{ start: 1, end: 40 }, { start: 41, end: 80 }]);
    expect(planBatches(81)).toEqual([{ start: 1, end: 27 }, { start: 28, end: 54 }, { start: 55, end: 81 }]);
    for (const n of [51, 77, 100, 163]) {
      const plan = planBatches(n);
      const covered = plan.flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, k) => start + k));
      expect(covered).toEqual(Array.from({ length: n }, (_, k) => k + 1));
      for (const b of plan) expect(b.end - b.start + 1).toBeLessThanOrEqual(40);
    }
  });
});

describe('triageOnce', () => {
  it('makes one call at the normal budget when it works', async () => {
    const callClaude = vi.fn().mockResolvedValue(ok('x'));
    const result = await triageOnce({ callClaude, responseText, request: { system: 's' }, log: quiet });
    expect(result).toMatchObject({ text: 'x', retried: false });
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(callClaude.mock.calls[0][0]).toMatchObject({ system: 's', maxTokens: TRIAGE_MAX_TOKENS });
  });

  it('retries once at double the budget after an empty max_tokens reply, and logs it', async () => {
    const callClaude = vi.fn().mockResolvedValueOnce(cut()).mockResolvedValueOnce(ok('y'));
    const log = { log: vi.fn(), warn: vi.fn() };
    const result = await triageOnce({ callClaude, responseText, request: { system: 's' }, log });
    expect(result).toMatchObject({ text: 'y', retried: true });
    expect(callClaude.mock.calls.map((c) => c[0].maxTokens)).toEqual([TRIAGE_MAX_TOKENS, TRIAGE_RETRY_MAX_TOKENS]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('retrying once'));
  });

  it('never retries more than once', async () => {
    const callClaude = vi.fn().mockResolvedValue(cut());
    const result = await triageOnce({ callClaude, responseText, request: {}, log: quiet });
    expect(result).toMatchObject({ text: '', stopReason: 'max_tokens', retried: true });
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it('does not retry a reply that has text, even if it was cut off', async () => {
    const callClaude = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' });
    const result = await triageOnce({ callClaude, responseText, request: {}, log: quiet });
    expect(result.retried).toBe(false);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });
});

describe('mergeTriageReplies', () => {
  it('combines batches into one reply, one header per bucket, dropping titles and out-of-batch numbers', () => {
    const merged = mergeTriageReplies([
      {
        range: { start: 1, end: 2 },
        text: '*Title*\n\n*🔴 Action Required*\n- [#1] A — a\n- [#7] Wrong — x\n\n*🟡 FYI / Needs Awareness*\n- [#2] B — b\n\n3 emails total',
      },
      {
        range: { start: 3, end: 4 },
        text: '*Another title*\n*🔴 Action Required*\n*Deal X*\n  ↳ [#3] C — c\n  ↳ [#1] Wrong — y\n*Deal Y*\n  ↳ [#2] Wrong — z\n\n*👀 Watching*\n- [#4] D — d (owner: Kelsey)',
      },
    ]);
    expect(merged).toBe([
      '*🔴 Action Required*',
      '- [#1] A — a',
      '*Deal X*',
      '  ↳ [#3] C — c',
      '',
      '*👀 Watching*',
      '- [#4] D — d (owner: Kelsey)',
      '',
      '*🟡 FYI / Needs Awareness*',
      '- [#2] B — b',
    ].join('\n'));
  });
});

describe('runTriage', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. email ${i + 1}`);

  it('uses one call (and the plain reply) for a normal day', async () => {
    const callClaude = vi.fn().mockResolvedValue(ok('*🔴 Action Required*\n- [#1] x'));
    const result = await runTriage({ callClaude, responseText, emailLines: lines(10), buildRequest: (list) => ({ list }), log: quiet });
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(callClaude.mock.calls[0][0].list).toBe(lines(10).join('\n'));
    expect(result).toMatchObject({ failed: false, batches: 1, retries: 0, text: '*🔴 Action Required*\n- [#1] x' });
  });

  it('hands each batch its own slice of the numbered list', async () => {
    const seenLists = [];
    const callClaude = vi.fn(async ({ list, batch }) => {
      seenLists.push(list);
      const first = Number(list.split('.')[0]);
      return ok(`*🔴 Action Required*\n- [#${first}] email ${first} (batch ${batch.index + 1}/${batch.total})`);
    });
    const result = await runTriage({
      callClaude, responseText, emailLines: lines(90), buildRequest: (list, batch) => ({ list, batch }), log: quiet,
    });
    expect(seenLists).toEqual([lines(90).slice(0, 30).join('\n'), lines(90).slice(30, 60).join('\n'), lines(90).slice(60).join('\n')]);
    expect(result.text).toBe('*🔴 Action Required*\n- [#1] email 1 (batch 1/3)\n- [#31] email 31 (batch 2/3)\n- [#61] email 61 (batch 3/3)');
  });

  it('fails as a whole when any batch fails after its retry', async () => {
    const callClaude = vi.fn(async ({ list }) => (list.startsWith('31.') ? cut() : ok('*🔴 Action Required*\n- [#1] x')));
    const result = await runTriage({ callClaude, responseText, emailLines: lines(90), buildRequest: (list) => ({ list }), log: quiet });
    expect(result).toMatchObject({ failed: true, text: '', stopReason: 'max_tokens', retries: 1 });
  });
});
