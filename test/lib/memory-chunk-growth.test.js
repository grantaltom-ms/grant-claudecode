import { describe, it, expect } from 'vitest';
import { chunkLongText } from '../../pages/api/backfill-memory-chunks';

// "Memory growth proportional to new content, not run count" (repeated-use
// test from the runbook) is really a chunking-correctness property at the
// unit level: the same input always produces the same chunk count (so
// re-running maintenance on unchanged content doesn't grow the chunk count),
// and a longer input produces proportionally more chunks (so real new
// content is actually captured, not truncated to a fixed number of chunks).

describe('chunkLongText growth proportionality', () => {
  it('short text below the chunk size produces exactly one chunk', () => {
    const chunks = chunkLongText('A short paragraph of email body text.');
    expect(chunks).toHaveLength(1);
  });

  it('is deterministic: chunking the same text twice yields the same chunk count', () => {
    const text = 'Sentence number. '.repeat(400);
    const first = chunkLongText(text);
    const second = chunkLongText(text);
    expect(second).toHaveLength(first.length);
    expect(second).toEqual(first);
  });

  it('chunk count grows with input length rather than staying fixed', () => {
    const short = chunkLongText('Sentence number. '.repeat(50));
    const medium = chunkLongText('Sentence number. '.repeat(400));
    const long = chunkLongText('Sentence number. '.repeat(1200));

    expect(medium.length).toBeGreaterThan(short.length);
    expect(long.length).toBeGreaterThan(medium.length);
  });

  it('consecutive chunks overlap so no sentence is fully lost at a boundary', () => {
    const text = 'Sentence number. '.repeat(400);
    const chunks = chunkLongText(text, 2200, 200);
    for (let i = 1; i < chunks.length; i++) {
      const tailOfPrevious = chunks[i - 1].slice(-50);
      expect(chunks[i].includes(tailOfPrevious.slice(-20)) || chunks[i - 1].length < 2200).toBe(true);
    }
  });

  it('empty input produces a single empty-string chunk rather than throwing', () => {
    expect(chunkLongText('')).toEqual(['']);
    expect(chunkLongText(undefined)).toEqual(['']);
  });
});
