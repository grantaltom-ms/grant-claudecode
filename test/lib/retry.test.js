import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../lib/retry';

function errorWithStatus(status, extra = {}) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 429 twice then succeeds on the third attempt, with increasing delays', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw errorWithStatus(429);
      return 'ok';
    });

    const promise = withRetry(fn, { label: 'test', baseMs: 100 });
    // Let both backoff waits elapse (100ms then 200ms-plus-jitter -- 5s covers it).
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404 -- exactly one call', async () => {
    const fn = vi.fn(async () => {
      throw errorWithStatus(404);
    });

    await expect(withRetry(fn, { label: 'test' })).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry other 4xx errors either', async () => {
    const fn = vi.fn(async () => {
      throw errorWithStatus(401);
    });

    await expect(withRetry(fn, { label: 'test' })).rejects.toThrow('HTTP 401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx error', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw errorWithStatus(503);
      return 'ok';
    });

    const promise = withRetry(fn, { label: 'test', baseMs: 50 });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a plain network error with no status (status undefined counts as retryable)', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error('fetch failed');
      return 'ok';
    });

    const promise = withRetry(fn, { label: 'test', baseMs: 50 });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of attempts and throws the last error', async () => {
    const fn = vi.fn(async () => {
      throw errorWithStatus(500);
    });

    const promise = withRetry(fn, { label: 'test', attempts: 3, baseMs: 10 });
    const assertion = expect(promise).rejects.toThrow('HTTP 500');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After over the default exponential backoff', async () => {
    vi.useRealTimers();
    const waits = [];
    const realSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation((cb, ms) => {
      waits.push(ms);
      return realSetTimeout(cb, 0);
    });

    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw errorWithStatus(429, { retryAfterMs: 9000 });
      return 'ok';
    });

    await withRetry(fn, { label: 'test', baseMs: 100 });

    expect(waits[0]).toBe(9000);
  });
});
