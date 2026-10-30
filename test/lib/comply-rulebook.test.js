import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import pdfParse from 'pdf-parse';
import { server } from '../mocks/server';
import { generateCompletedNotice, generateNoticePdf } from '../../lib/comply-agent';
import { MUNICIPALITY_ADDENDA, STATE_BASELINE_LEGAL, resolveComplyRules } from '../../lib/notice-rules';

// The notice rulebook API (POV-app /api/rules/resolve) is mocked; nothing real is called.

const API = 'https://rules.test';
const env = { RULES_API_URL: API, RULES_API_SECRET: 'test-rules-secret' };

const STATE = {
  tenantName: 'John Doe',
  propertyName: 'Test Apartments',
  propertyAddress: '123 Main St',
  unitNumber: '204',
  propertyState: 'WA',
  propertyZip: '98101',
  section1: 'Section 1 text.',
  section2: 'Section 2 text.',
  section3: 'Section 3 text.',
};

const RULEBOOK_CITIES = { Seattle: 'seattle', Burien: 'burien', SeaTac: 'seatac' };

/** What the rulebook answers once the comply text (migration 0026) is approved. */
function rulebookAnswer(city, { approvedCities = Object.keys(RULEBOOK_CITIES), withBaseline = true } = {}) {
  const known = approvedCities.includes(city);
  const legends = [];
  if (withBaseline) {
    legends.push({
      ruleKey: 'wa.comply_or_vacate.baseline',
      versionId: 'v-baseline',
      placement: 'inside_notice',
      renderedParagraphs: [STATE_BASELINE_LEGAL],
    });
  }
  if (known) {
    legends.push({
      ruleKey: `${RULEBOOK_CITIES[city]}.comply_or_vacate.addendum`,
      versionId: `v-${RULEBOOK_CITIES[city]}`,
      placement: 'separate_page',
      renderedParagraphs: [MUNICIPALITY_ADDENDA[city]],
    });
  }
  return {
    ok: true,
    state: 'WA',
    city,
    noticeType: 'comply_or_vacate',
    jurisdiction: known || city === 'Vancouver' ? { slug: city.toLowerCase(), name: city } : null,
    fallback: known ? null : 'statewide',
    noticeDays: 10,
    legends,
    ruleVersionIds: ['v-regime', ...legends.map((l) => l.versionId)],
  };
}

let calls;
function mockRulebook(answer) {
  server.use(
    http.get(`${API}/api/rules/resolve`, ({ request }) => {
      const url = new URL(request.url);
      calls.push({
        city: url.searchParams.get('city'),
        noticeType: url.searchParams.get('notice_type'),
        auth: request.headers.get('authorization'),
      });
      return answer(url.searchParams.get('city'));
    })
  );
}

const textOf = async (buf) => (await pdfParse(buf)).text;
const squash = (s) => s.replace(/\s+/g, ' ').trim();

describe('comply bot reads its legal text from the notice rulebook', () => {
  let errorSpy;
  beforeEach(() => {
    calls = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  for (const city of ['Seattle', 'Burien', 'SeaTac']) {
    it(`${city}: prints the rulebook's city addendum, identical to the text it printed before`, async () => {
      mockRulebook((c) => HttpResponse.json(rulebookAnswer(c)));

      const { pdfBuffer, rules, reviewNote } = await generateCompletedNotice({ ...STATE, city }, { env });
      const text = squash(await textOf(pdfBuffer));
      const before = squash(await textOf(await generateNoticePdf({ ...STATE, city })));

      expect(rules.source).toBe('rulebook');
      expect(text).toBe(before);
      expect(text).toContain('MUNICIPALITY ADDENDUM');
      expect(calls).toEqual([{ city, noticeType: 'comply_or_vacate', auth: 'Bearer test-rules-secret' }]);
      expect(reviewNote).toContain(`${city} city addendum`);
      expect(reviewNote).toContain(`\`v-${RULEBOOK_CITIES[city]}\``);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  }

  it('"Sea-Tac" spelled with a hyphen is asked for as SeaTac', async () => {
    mockRulebook((c) => HttpResponse.json(rulebookAnswer(c)));
    const { rules } = await generateCompletedNotice({ ...STATE, city: 'Sea-Tac' }, { env });
    expect(calls[0].city).toBe('SeaTac');
    expect(rules.addendumText).toBe(MUNICIPALITY_ADDENDA.SeaTac);
  });

  it('a city with no approved rule gets statewide language and the reviewer is told', async () => {
    mockRulebook((c) => HttpResponse.json(rulebookAnswer(c)));
    const { pdfBuffer, rules, reviewNote } = await generateCompletedNotice({ ...STATE, city: 'Vancouver' }, { env });
    const text = await textOf(pdfBuffer);

    expect(rules.statewideFallback).toBe(true);
    expect(text).not.toContain('MUNICIPALITY ADDENDUM');
    expect(text).toContain('Eviction Defense Screening Line');
    expect(reviewNote).toMatch(/Statewide language only/);
    expect(reviewNote).toContain('Vancouver');
    expect(reviewNote).toContain('`v-regime`');
  });

  it('when the rulebook is down, it uses the bundled copy, logs loudly, and warns the reviewer', async () => {
    mockRulebook(() => HttpResponse.json({ error: 'boom' }, { status: 503 }));
    const { pdfBuffer, rules, reviewNote } = await generateCompletedNotice({ ...STATE, city: 'Seattle' }, { env });

    expect(rules.source).toBe('bundled_fallback');
    expect(await textOf(pdfBuffer)).toContain('Renting in Seattle Helpline');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('RULEBOOK FALLBACK'));
    expect(reviewNote).toMatch(/could not be used/);
    expect(reviewNote).toContain('HTTP 503');
  });

  it('when the rulebook cannot be reached at all, it falls back the same way', async () => {
    mockRulebook(() => HttpResponse.error());
    const { rules, reviewNote } = await generateCompletedNotice({ ...STATE, city: 'Burien' }, { env });
    expect(rules.source).toBe('bundled_fallback');
    expect(rules.addendumText).toBe(MUNICIPALITY_ADDENDA.Burien);
    expect(reviewNote).toMatch(/unreachable/);
  });

  it('without RULES_API_URL / RULES_API_SECRET configured, it falls back and says why', async () => {
    const rules = await resolveComplyRules({ city: 'Seattle', state: 'WA' }, { env: {} });
    expect(rules.source).toBe('bundled_fallback');
    expect(rules.fallbackReason).toMatch(/not set/);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('never prints a notice without the statewide language, even if the rulebook has none yet', async () => {
    mockRulebook((c) => HttpResponse.json(rulebookAnswer(c, { withBaseline: false })));
    const { pdfBuffer, rules } = await generateCompletedNotice({ ...STATE, city: 'Seattle' }, { env });
    expect(rules.source).toBe('bundled_fallback');
    expect(rules.fallbackReason).toMatch(/no approved statewide/);
    expect(await textOf(pdfBuffer)).toContain('Eviction Defense Screening Line');
  });

  it('several notices in a row each ask the rulebook fresh — a rule approved mid-day applies to the next notice', async () => {
    let approved = ['Seattle'];
    mockRulebook((c) => HttpResponse.json(rulebookAnswer(c, { approvedCities: approved })));

    const sequence = ['Seattle', 'Burien', 'Seattle', 'Burien', 'Vancouver', 'Seattle'];
    const results = [];
    for (const [i, city] of sequence.entries()) {
      if (i === 3) approved = ['Seattle', 'Burien']; // Conor approves Burien between notices
      const { rules } = await generateCompletedNotice({ ...STATE, city, tenantName: `Tenant ${i}` }, { env });
      results.push([city, rules.statewideFallback, rules.addendumText ? 'addendum' : 'none']);
    }

    expect(calls.map((c) => c.city)).toEqual(sequence);
    expect(results).toEqual([
      ['Seattle', false, 'addendum'],
      ['Burien', true, 'none'],
      ['Seattle', false, 'addendum'],
      ['Burien', false, 'addendum'],
      ['Vancouver', true, 'none'],
      ['Seattle', false, 'addendum'],
    ]);
  });
});
