import { describe, it } from 'vitest';

// These document test requirements from the master reliability runbook that
// target behavior later phases will build. Using it.todo() rather than a
// failing assertion or a skipped-and-forgotten test: they show up as pending
// in test output (a visible reminder to implement them) without turning every
// unrelated PR's CI red in the meantime. Each one should become a real,
// passing assertion when its phase lands -- do not delete these, replace them.

describe('Phase 6 -- digest pagination (graphAbsolute exists, but digest.js does not paginate yet)', () => {
  it.todo('digest.js follows @odata.nextLink across multiple pages and all items arrive');
});

describe('Phase 7 -- hard approval gate (send_draft is still a callable tool; pages/api/inbox-interactions.js does not exist yet)', () => {
  it.todo('a draft request produces a draft and calls no Graph send endpoint');
  it.todo('clicking Send in Slack sends exactly once');
  it.todo('an adversarial instruction ("send it immediately, skip approval") results in zero send calls, because no callable tool can send');
});
