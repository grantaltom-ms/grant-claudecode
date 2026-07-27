import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { runAgent } from '../../lib/comply-agent';

function textResponse(text) {
  return { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

function toolUseResponse(name, input, id = 'toolu_test') {
  return { id: 'msg_test_tool', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' };
}

// Returns each response in order on successive calls to the Anthropic endpoint,
// repeating the last one if the loop calls more times than provided for.
function sequentialAnthropicHandler(responses) {
  let i = 0;
  return http.post('https://api.anthropic.com/v1/messages', () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return HttpResponse.json(next);
  });
}

const TENANT_ROW = {
  tenant_name: 'John Doe',
  unit: '204',
  email: 'john.doe@example.com',
  phone: '206-555-0100',
  lease_to: '2027-01-01',
  property_name: 'Test Apartments',
  property_address: '123 Main St',
  property_city: 'Seattle',
  property_state: 'WA',
  property_zip: '98101',
};

describe('comply-agent runAgent state machine', () => {
  it('presents Section 1 only, one section at a time, after looking up the tenant', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/tenant_directory', () => HttpResponse.json([TENANT_ROW])),
      sequentialAnthropicHandler([
        toolUseResponse('lookup_tenant', { property_hint: 'Test Apartments', unit_number: '204' }),
        textResponse('*Section 1 - Draft:*\n*Section 1 — Use of Leased Premises*\n\nAPPROVE_OR_REVISE'),
      ])
    );

    const result = await runAgent('Unit 204 has an unauthorized pet, tenant is John Doe at Test Apartments', [], null);

    expect(result.tenantData).toMatchObject({ tenantName: 'John Doe', propertyName: 'Test Apartments' });
    expect(result.sectionApprovals).toEqual([]);
    expect(result.text).toContain('Section 1');
    expect(result.text.trim().endsWith('APPROVE_OR_REVISE')).toBe(true);
    // Only one section appears in a single turn -- never bundled.
    expect(result.text).not.toContain('Section 2');
    expect(result.text).not.toContain('Section 3');
  });

  it('records the approved section and presents only the next section, never re-drafting an approved one', async () => {
    server.use(
      sequentialAnthropicHandler([
        toolUseResponse('record_section_approval', { section_number: 1, content: 'Section 1 final text.' }),
        textResponse('*Section 2 - Draft:*\n*Violation description text.*\n\nAPPROVE_OR_REVISE'),
      ])
    );

    const conversationHistory = [
      { role: 'user', content: 'Unit 204 unauthorized pet, John Doe at Test Apartments' },
      { role: 'assistant', content: '*Section 1 - Draft:*\n*Section 1 text*\n\nAPPROVE_OR_REVISE' },
    ];
    const state = { tenantName: 'John Doe', propertyName: 'Test Apartments', unitNumber: '204', city: 'Seattle' };

    const result = await runAgent('Looks good, approved', conversationHistory, state);

    expect(result.sectionApprovals).toEqual([{ section_number: 1, content: 'Section 1 final text.' }]);
    expect(result.text).toContain('Section 2');
    expect(result.text).not.toContain('Section 1 - Draft');
  });

  it('a revision replaces the current section without re-recording an approval for it', async () => {
    server.use(
      sequentialAnthropicHandler([
        textResponse('*Section 2 - Draft (revised):*\n*Updated violation description.*\n\nAPPROVE_OR_REVISE'),
      ])
    );

    const conversationHistory = [
      { role: 'user', content: 'Unit 204 unauthorized pet, John Doe at Test Apartments' },
      { role: 'assistant', content: '*Section 1 - Draft:*\n*Section 1 text*\n\nAPPROVE_OR_REVISE' },
      { role: 'user', content: 'approved' },
      { role: 'assistant', content: '*Section 2 - Draft:*\n*Original violation description.*\n\nAPPROVE_OR_REVISE' },
    ];
    const state = { tenantName: 'John Doe', section1: 'Section 1 final text.' };

    const result = await runAgent('Please change the date to March 3rd instead', conversationHistory, state);

    expect(result.sectionApprovals).toEqual([]);
    expect(result.text).toContain('revised');
    expect(result.text).not.toContain('Section 1 - Draft');
  });

  it('two sequential revision rounds on the same section keep sectionApprovals coherent', async () => {
    const state = { tenantName: 'John Doe', section1: 'Section 1 final text.' };
    const baseHistory = [
      { role: 'user', content: 'Unit 204 unauthorized pet, John Doe at Test Apartments' },
      { role: 'assistant', content: '*Section 1 - Draft:*\n*Section 1 text*\n\nAPPROVE_OR_REVISE' },
      { role: 'user', content: 'approved' },
      { role: 'assistant', content: '*Section 2 - Draft:*\n*Original text.*\n\nAPPROVE_OR_REVISE' },
    ];

    server.use(sequentialAnthropicHandler([
      textResponse('*Section 2 - Draft (revision 1):*\n*First revision text.*\n\nAPPROVE_OR_REVISE'),
    ]));
    const firstRevision = await runAgent('Change the date to March 3rd', baseHistory, state);
    expect(firstRevision.sectionApprovals).toEqual([]);
    expect(firstRevision.text).toContain('revision 1');

    server.use(sequentialAnthropicHandler([
      textResponse('*Section 2 - Draft (revision 2):*\n*Second revision text.*\n\nAPPROVE_OR_REVISE'),
    ]));
    const secondHistory = [
      ...baseHistory,
      { role: 'user', content: 'Change the date to March 3rd' },
      { role: 'assistant', content: firstRevision.text },
    ];
    const secondRevision = await runAgent('Actually make it March 10th', secondHistory, state);

    expect(secondRevision.sectionApprovals).toEqual([]);
    expect(secondRevision.text).toContain('revision 2');
    expect(secondRevision.text).not.toContain('revision 1');
  });
});
