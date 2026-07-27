import { describe, it, expect } from 'vitest';
import pdfParse from 'pdf-parse';
import { generateNoticePdf } from '../../lib/comply-agent';

const BASE_STATE = {
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

async function textOf(pdfBuffer) {
  const parsed = await pdfParse(pdfBuffer);
  return parsed.text;
}

describe('generateNoticePdf municipality addendum', () => {
  it('generates a valid, non-empty PDF buffer', async () => {
    const pdfBuffer = await generateNoticePdf({ ...BASE_STATE, city: 'Renton' });
    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(0);
    expect(pdfBuffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('includes the Seattle addendum for a Seattle property', async () => {
    const text = await textOf(await generateNoticePdf({ ...BASE_STATE, city: 'Seattle' }));
    expect(text).toContain('MUNICIPALITY ADDENDUM');
    expect(text).toContain('Renting in Seattle Helpline');
  });

  it('includes the Burien addendum for a Burien property', async () => {
    const text = await textOf(await generateNoticePdf({ ...BASE_STATE, city: 'Burien' }));
    expect(text).toContain('MUNICIPALITY ADDENDUM');
    expect(text).toContain('Renting in Burien Handbook');
  });

  it.each(['SeaTac', 'Sea-Tac', 'Sea Tac'])('includes the SeaTac addendum for city spelling "%s"', async (city) => {
    const text = await textOf(await generateNoticePdf({ ...BASE_STATE, city }));
    expect(text).toContain('MUNICIPALITY ADDENDUM');
    expect(text).toContain('SMC 4.05.040');
  });

  it.each(['Renton', 'Des Moines', 'Tacoma'])('omits the addendum entirely for %s', async (city) => {
    const text = await textOf(await generateNoticePdf({ ...BASE_STATE, city }));
    expect(text).not.toContain('MUNICIPALITY ADDENDUM');
  });

  it('always includes the state baseline legal-help language regardless of city', async () => {
    const text = await textOf(await generateNoticePdf({ ...BASE_STATE, city: 'Tacoma' }));
    expect(text).toContain('Eviction Defense Screening Line');
  });
});
