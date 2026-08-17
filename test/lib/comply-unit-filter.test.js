import { describe, it, expect } from 'vitest';
import { unitFilter } from '../../lib/comply-agent';

// unitFilter returns a PostgREST or=(...) string. Pull the quoted equality values back out so
// the assertions read in terms of the unit spellings actually searched for.
function equalityVariants(unitNumber) {
  const decoded = decodeURIComponent(unitFilter(unitNumber));
  return [...decoded.matchAll(/unit\.eq\."((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

describe('unitFilter unit spelling expansion', () => {
  // Willow Lake stores "C - 02"; Stonehaven stores "A 102". A manager typing a dash has to
  // reach both, and before this the plain-space spelling was never generated at all.
  it('reaches both dashed and plain-space storage from a dashed input', () => {
    const variants = equalityVariants('A-102');
    expect(variants).toContain('A 102');
    expect(variants).toContain('A - 102');
    expect(variants).toContain('A-102');
    expect(variants).toContain('A102');
  });

  it('still reaches the spaced-dash spelling that Willow Lake uses', () => {
    expect(equalityVariants('C-02')).toContain('C - 02');
  });

  it('expands an unseparated unit into the separated spellings', () => {
    const variants = equalityVariants('B06');
    expect(variants).toEqual(expect.arrayContaining(['B06', 'B-06', 'B - 06', 'B 06']));
  });

  it('tries both zero-padded and unpadded numbers', () => {
    const variants = equalityVariants('C-2');
    expect(variants).toEqual(expect.arrayContaining(['C - 02', 'C - 2']));
  });

  it('handles a number-then-letter unit like Legacy Place stores', () => {
    expect(equalityVariants('01-A')).toContain('01 - A');
  });

  it('handles a building-prefixed unit like Isherwood stores', () => {
    expect(equalityVariants('3614-101')).toContain('3614-101');
  });

  // The guard that makes the above safe: splitting a bare number would expand "101" into
  // "1" + "01" and from there into spellings like "11", silently matching unrelated units.
  it('never splits a bare number into spellings that match other units', () => {
    const variants = equalityVariants('101');
    expect(variants).toEqual(['101']);
    expect(variants).not.toContain('11');
    expect(variants).not.toContain('1 01');
  });

  it('leaves a lone letter-number unit case-insensitive but otherwise intact', () => {
    expect(equalityVariants('a102')).toContain('A102');
  });
});
