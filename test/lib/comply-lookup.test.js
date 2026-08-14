import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { lookupTenant, addressSearchHints, unitFilter } from '../../lib/comply-agent';

const WILLOW_TENANT = {
  tenant_name: 'Jane Tenant',
  unit: 'B - 06',
  email: 'jane@example.com',
  phone: '206-555-0199',
  lease_to: '2027-06-01',
  property_name: 'Willow Lake Apartments',
  property_address: '3002 S 208th St',
  property_city: 'SeaTac',
  property_state: 'WA',
  property_zip: '98198',
};

function parseUrl(request) {
  return new URL(request.url);
}

describe('addressSearchHints', () => {
  it('strips city/state/zip so a pasted full address can match a street-only column', () => {
    const hints = addressSearchHints('3002 S 208th St Seatac Wa 98198');
    expect(hints[0]).toBe('3002 S 208th St Seatac Wa 98198');
    expect(hints).toEqual(expect.arrayContaining(['3002 S 208th St']));
  });

  it('does not strip the second word of a property name like Willow Lake', () => {
    const hints = addressSearchHints('Willow Lake');
    expect(hints).toEqual(['Willow Lake']);
    expect(hints).not.toContain('Willow');
  });
});

describe('unitFilter', () => {
  it('expands B06 into hyphenated and spaced AppFolio-style variants with PostgREST quoting', () => {
    const decoded = decodeURIComponent(unitFilter('B06'));
    expect(decoded).toContain('"B06"');
    expect(decoded).toContain('"B-06"');
    expect(decoded).toContain('"B - 06"');
  });
});

describe('lookupTenant — address + unit matching (Willow Lake regression)', () => {
  it('finds a tenant when the manager pastes a full street address (city/state/zip included)', async () => {
    // Reproduce: name search misses, properties-by-name is empty, address fallback must still run.
    // Previously returned property_not_found before ever querying by property_address.
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/tenant_directory', ({ request }) => {
        const url = parseUrl(request);
        const nameFilter = url.searchParams.get('property_name');
        const addrFilter = url.searchParams.get('property_address');

        if (nameFilter) return HttpResponse.json([]);
        if (addrFilter && addrFilter.toLowerCase().includes('3002')) {
          return HttpResponse.json([WILLOW_TENANT]);
        }
        return HttpResponse.json([]);
      }),
      http.get('https://test-project.supabase.co/rest/v1/properties', () => HttpResponse.json([]))
    );

    const result = await lookupTenant('3002 S 208th St Seatac Wa 98198', 'B06');

    expect(result.error).toBeUndefined();
    expect(result.tenants).toHaveLength(1);
    expect(result.propertyName).toBe('Willow Lake Apartments');
    expect(result.propertyAddress).toBe('3002 S 208th St');
    expect(result.city).toBe('SeaTac');
  });

  it('matches unit formats B06 / B-06 / B - 06 interchangeably', async () => {
    const seenUnitFilters = [];
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/tenant_directory', ({ request }) => {
        const url = parseUrl(request);
        const orFilter = url.searchParams.get('or') || '';
        seenUnitFilters.push(orFilter);

        const decoded = decodeURIComponent(orFilter);
        if (decoded.includes('B - 06') || decoded.includes('B-06')) {
          return HttpResponse.json([WILLOW_TENANT]);
        }
        return HttpResponse.json([]);
      })
    );

    const result = await lookupTenant('Willow Lake', 'B06');

    expect(result.error).toBeUndefined();
    expect(result.tenants[0].unit).toBe('B - 06');
    const decoded = seenUnitFilters.map((f) => decodeURIComponent(f)).join(' | ');
    expect(decoded).toMatch(/B-06|B - 06/);
  });

  it('when the property exists but the unit does not, returns unit_not_found (not property_not_found)', async () => {
    server.use(
      http.get('https://test-project.supabase.co/rest/v1/tenant_directory', ({ request }) => {
        const url = parseUrl(request);
        const nameFilter = url.searchParams.get('property_name') || '';
        const orFilter = url.searchParams.get('or');

        if (!nameFilter.toLowerCase().includes('willow')) return HttpResponse.json([]);

        // Name-only probe (no unit filter) returns rows so we can diagnose unit mismatch
        if (!orFilter) {
          return HttpResponse.json([
            { ...WILLOW_TENANT, unit: 'B - 06' },
            { ...WILLOW_TENANT, unit: 'A - 12', tenant_name: 'Other Tenant' },
          ]);
        }
        return HttpResponse.json([]);
      }),
      http.get('https://test-project.supabase.co/rest/v1/properties', () => HttpResponse.json([]))
    );

    const result = await lookupTenant('Willow Lake', 'Z99');

    expect(result.error).toBe('unit_not_found');
    expect(result.propertyName).toBe('Willow Lake Apartments');
    expect(result.sampleUnits).toEqual(expect.arrayContaining(['B - 06', 'A - 12']));
  });
});
