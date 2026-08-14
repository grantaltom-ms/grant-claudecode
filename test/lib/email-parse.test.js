import { describe, it, expect } from 'vitest';
import { parseAuthResults, isAuthFailure } from '../../lib/email-parse';

describe('parseAuthResults', () => {
  it('extracts spf/dkim/dmarc verdicts from an Authentication-Results header', () => {
    const headers = [
      {
        name: 'Authentication-Results',
        value: 'spf=fail (sender IP is 203.0.113.9) smtp.mailfrom=fake.com; dkim=none; dmarc=fail action=quarantine header.from=fake.com',
      },
    ];
    expect(parseAuthResults(headers)).toEqual({ spf: 'fail', dkim: 'none', dmarc: 'fail' });
  });

  it('is case-insensitive on the header name', () => {
    const headers = [{ name: 'authentication-results', value: 'spf=pass; dkim=pass; dmarc=pass' }];
    expect(parseAuthResults(headers)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('returns nulls when the header is absent', () => {
    expect(parseAuthResults([])).toEqual({ spf: null, dkim: null, dmarc: null });
    expect(parseAuthResults(undefined)).toEqual({ spf: null, dkim: null, dmarc: null });
  });

  it('picks the first Authentication-Results header when there are several hops', () => {
    const headers = [
      { name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' },
      { name: 'Authentication-Results', value: 'spf=fail; dkim=fail; dmarc=fail' },
    ];
    expect(parseAuthResults(headers)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });
});

describe('isAuthFailure', () => {
  it('flags spf=fail', () => {
    expect(isAuthFailure({ spf: 'fail', dkim: 'pass', dmarc: 'pass' })).toBe(true);
  });

  it('flags dmarc=fail', () => {
    expect(isAuthFailure({ spf: 'pass', dkim: 'pass', dmarc: 'fail' })).toBe(true);
  });

  it('does not flag dkim=fail alone', () => {
    expect(isAuthFailure({ spf: 'pass', dkim: 'fail', dmarc: 'pass' })).toBe(false);
  });

  it('does not flag a clean pass', () => {
    expect(isAuthFailure({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })).toBe(false);
  });

  it('does not flag missing headers', () => {
    expect(isAuthFailure({ spf: null, dkim: null, dmarc: null })).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});
