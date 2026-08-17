// lib/comply-agent.js
// Shared logic for the Comply-or-Vacate Slack bot.
// Imported by pages/api/comply-vacate.js and pages/api/comply-interactions.js

import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import {
  slackPost as _slackPost,
  slackUpdateMessage as _slackUpdateMessage,
  getThreadHistory as _getThreadHistory,
  getBotUserId as _getBotUserId,
  uploadFileToSlack,
} from './slack';
import { callClaude } from './claude';

export const SLACK_BOT_TOKEN = process.env.COMPLY_SLACK_BOT_TOKEN;
export const SLACK_SIGNING_SECRET = process.env.COMPLY_SLACK_SIGNING_SECRET;
// The comply bot reads a different Supabase project than the rest of this app: its
// tenant_directory and thread_state tables live in augbrysfqwgekfhfokco, while the shared
// SUPABASE_URL addresses the project the digest writes to. Reading the shared variable
// pointed every query at a project that has no tenant_directory at all, and pairing it with
// this project's key produced a "Invalid API key" 401 that looked like a bad credential.
// So this deliberately does NOT fall back to SUPABASE_URL -- only to the correct project.
export const SUPABASE_URL = process.env.COMPLY_SUPABASE_URL || 'https://augbrysfqwgekfhfokco.supabase.co';

// A key is only valid for the project it was signed for, so the key must be chosen to match
// the URL above. COMPLY_SUPABASE_SERVICE_KEY is the one that always does; the shared
// variables remain as fallbacks for deployments where both point at the same project.
// Trimmed because a stray newline or space pasted into the Vercel dashboard makes the
// Authorization header invalid, which Supabase also reports only as "Invalid API key".
export const SUPABASE_SERVICE_KEY = (
  process.env.COMPLY_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim();

// Describes the configured key without printing it: which variable supplied it, its length,
// the `role` claim if it is a JWT, and the project the key and the URL each point at. A
// correct service_role key still 401s when it is signed for a different project than
// SUPABASE_URL addresses, and the ref/host pair is what makes that mismatch visible.
export function describeSupabaseKey() {
  const source = process.env.COMPLY_SUPABASE_SERVICE_KEY
    ? 'COMPLY_SUPABASE_SERVICE_KEY'
    : process.env.SUPABASE_SERVICE_KEY
      ? 'SUPABASE_SERVICE_KEY'
      : process.env.SUPABASE_SERVICE_ROLE_KEY
        ? 'SUPABASE_SERVICE_ROLE_KEY'
        : 'none';
  const urlHost = (() => {
    try {
      return new URL(SUPABASE_URL).host;
    } catch {
      return 'unparseable';
    }
  })();
  if (!SUPABASE_SERVICE_KEY) return { source, length: 0, role: null, keyRef: null, urlHost };

  let role = null;
  let keyRef = null;
  try {
    const payload = SUPABASE_SERVICE_KEY.split('.')[1];
    if (payload) {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      role = claims.role ?? null;
      keyRef = claims.ref ?? null;
    }
  } catch {
    role = 'unparseable';
  }
  return { source, length: SUPABASE_SERVICE_KEY.length, role, keyRef, urlHost };
}
export const COMPLY_CHANNEL_ID = 'C0BBG7ZB1MK';
export const CONOR_SLACK_ID = 'U03DB8GBSAH';

// ─── Lease section reference ───────────────────────────────────────────────
export const LEASE_SECTIONS = {
  unsanitary_hoarding: {
    section: 'Section 3.8 — Use of Leased Premises and Common Areas',
    text: 'Residents must keep the Leased Premises and areas reserved for private use clean and sanitary; trash must be disposed of at least weekly in appropriate receptacles.',
  },
  pest_infestation: {
    section: 'Section 3.8 — Use of Leased Premises and Common Areas; Bed Bug Addendum Section 5.1–5.4',
    text: 'Residents agree to maintain the Leased Premises in a manner that prevents the occurrence of any infestation of insects and vermin. Residents shall cooperate and comply with all pest control efforts.',
  },
  unauthorized_occupant: {
    section: 'Section 1.1 — Parties and Occupants',
    text: 'The apartment will be occupied exclusively by the resident(s) listed above. The Owner/Agent must approve unauthorized occupants living in the premises for longer than 7 consecutive days.',
  },
  criminal_drugs: {
    section: 'Section 2.2 — Zero Tolerance Crime Policy; Crime-Free Addendum Sections 6.1–6.5',
    text: 'Residents shall not engage in drug-related criminal activity on or near the Residential Community, including the illegal manufacture, sale, distribution, use, or possession of a controlled substance. Residents shall not facilitate, use, or permit the Leased Premises to be used for criminal activity.',
  },
  smoking: {
    section: 'Section 10 — Smoke-Free Addendum',
    text: 'All Residents/Occupants, guests and invitees must refrain from all types of smoking within the dwelling and all common areas of the property.',
  },
  unauthorized_pet: {
    section: 'Section 3.5 — Animals',
    text: 'No animals are permitted in the Leased Premises or the Residential Community without the prior written consent of Owner.',
  },
  property_damage: {
    section: 'Section 3.1 — Condition of Premises and Alterations',
    text: "Residents shall maintain the premises in good, clean and tenantable condition throughout the tenancy. Residents agree not to alter, damage, or remove Owner's property.",
  },
  noise_nuisance: {
    section: 'Section 2.1 — Community Policies or Rules',
    text: 'Residents agree not to harass, annoy, or endanger any other resident or person, or create or maintain a nuisance, or disturb the peace or solitude of any other resident.',
  },
  short_term_rental: {
    section: 'Section 2.8 — Short Term Rentals',
    text: 'Residents are prohibited from offering all or part of the Leased Premises for short-term rental, such as through AirBNB, VRBO or other such sites.',
  },
  insurance_lapse: {
    section: 'Section 1.7 — Insurance',
    text: 'Residents are required to purchase personal liability insurance with a minimum coverage amount of $100,000. Failure to maintain personal liability insurance is an incurable breach of this Lease Contract.',
  },
  mold: {
    section: 'Section 8.11 — Mold Addendum Agreement',
    text: 'Resident shall remove any visible moisture accumulation; keep the Leased Premises clean; and promptly notify management in writing of any water leaks, excessive moisture, or mold growth.',
  },
};

// ─── Slack helpers ──────────────────────────────────────────────────────────

export function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBase).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
  } catch {
    // timingSafeEqual throws on mismatched buffer lengths -- a malformed or
    // wrong-length signature header should fail closed, not crash the handler.
    return false;
  }
}

export async function slackPost(channel, text, thread_ts = null, blocks = null) {
  return _slackPost(SLACK_BOT_TOKEN, channel, text, thread_ts, blocks);
}

// Update an existing Slack message (used to collapse interactive buttons after click)
export async function slackUpdateMessage(channel, ts, text, blocks = null) {
  return _slackUpdateMessage(SLACK_BOT_TOKEN, channel, ts, text, blocks);
}

export async function getThreadHistory(channel, thread_ts) {
  return _getThreadHistory(SLACK_BOT_TOKEN, channel, thread_ts, 50);
}

export async function getBotUserId() {
  return _getBotUserId(SLACK_BOT_TOKEN);
}

// ─── Supabase helpers ───────────────────────────────────────────────────────

const TENANT_SELECT =
  'tenant_name,unit,email,phone,lease_to,property_name,property_address,property_city,property_state,property_zip';

function supabaseHeaders() {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
}

/**
 * Expand unit number into the formats AppFolio / tenant_directory actually store.
 * Managers type "B06"; the DB often has "B-06" or "B - 06".
 *
 * PostgREST requires double-quoted values when they contain spaces or reserved
 * characters, otherwise `or=(unit.eq.B - 06,...)` is a parse error and every
 * lookup silently returns empty.
 */
export function unitFilter(unitNumber) {
  const base = unitNumber.trim();
  const variants = new Set([base]);

  // Letter + optional separator + digits (B06, B-06, B - 06, B6, etc.)
  const m = base.match(/^([A-Za-z]+)\s*[-\s]?\s*(\d+)$/);
  if (m) {
    const letter = m[1].toUpperCase();
    const rawNum = m[2];
    const unpadded = String(parseInt(rawNum, 10));
    const padded = unpadded.padStart(Math.max(rawNum.length, 2), '0');
    for (const num of new Set([rawNum, unpadded, padded])) {
      variants.add(`${letter}${num}`);
      variants.add(`${letter}-${num}`);
      variants.add(`${letter} - ${num}`);
    }
  }

  const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
  const filters = [];
  for (const v of variants) {
    const enc = encodeURIComponent(quote(v));
    filters.push(`unit.eq.${enc}`);
    filters.push(`unit.ilike.${enc}`);
  }
  // Building-prefix forms like "BLDG-B06"
  filters.push(`unit.ilike.${encodeURIComponent(`*-${base}`)}`);

  return `or=(${[...new Set(filters)].join(',')})`;
}

/**
 * Managers often paste "3002 S 208th St Seatac Wa 98198" while property_address
 * is stored as just "3002 S 208th St". Produce progressively shorter street hints.
 *
 * Only strip a trailing "city" token after we've already stripped ZIP/state (or
 * saw a comma). Otherwise "Willow Lake" wrongly becomes "Willow".
 */
export function addressSearchHints(propertyHint) {
  const raw = propertyHint.trim();
  const hints = [];
  const push = (h) => {
    const t = (h || '').trim().replace(/\s+/g, ' ');
    if (t && !hints.some((x) => x.toLowerCase() === t.toLowerCase())) hints.push(t);
  };

  push(raw);

  // Prefer the portion before the first comma ("3002 S 208th St, SeaTac, WA 98198")
  if (raw.includes(',')) push(raw.split(',')[0]);

  let s = raw;
  let strippedLocation = raw.includes(',');

  const noZip = s.replace(/\b\d{5}(?:-\d{4})?\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (noZip !== s) {
    s = noZip;
    strippedLocation = true;
    push(s);
  }

  const noState = s.replace(/,?\s*\b[A-Za-z]{2}\b\s*$/i, '').trim();
  if (noState !== s) {
    s = noState;
    strippedLocation = true;
    push(s);
  }

  if (strippedLocation) {
    push(s.replace(/,?\s+[A-Za-z][A-Za-z.'-]+$/u, '').trim());
  }

  // If we still have a long string, also try first 4 tokens ("3002 S 208th St")
  const tokens = raw.split(/\s+/);
  if (tokens.length > 4) push(tokens.slice(0, 4).join(' '));

  return hints;
}

function formatTenantResult(tenants, unitNumber, overrides = {}) {
  const t = tenants[0];
  return {
    tenants,
    propertyName: overrides.propertyName || t.property_name,
    propertyAddress: overrides.propertyAddress || t.property_address,
    city: overrides.city || t.property_city,
    propertyState: overrides.propertyState || t.property_state,
    propertyZip: overrides.propertyZip || t.property_zip,
    unitNumber,
  };
}

async function fetchTenantsByName(propertyName, unitNumber) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_directory?property_name=ilike.*${encodeURIComponent(propertyName)}*&${unitFilter(unitNumber)}&tenant_type=eq.Financially+Responsible&select=${TENANT_SELECT}`,
    { headers: supabaseHeaders() }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error('fetchTenantsByName failed:', res.status, data);
    if (res.status === 401) console.error('supabase key config:', describeSupabaseKey());
    return [];
  }
  return Array.isArray(data) ? data : [];
}

async function fetchTenantsByAddress(addressHint, unitNumber) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_directory?property_address=ilike.*${encodeURIComponent(addressHint)}*&${unitFilter(unitNumber)}&tenant_type=eq.Financially+Responsible&select=${TENANT_SELECT}`,
    { headers: supabaseHeaders() }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error('fetchTenantsByAddress failed:', res.status, data);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

async function fetchTenantsByNameOnly(propertyName) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_directory?property_name=ilike.*${encodeURIComponent(propertyName)}*&tenant_type=eq.Financially+Responsible&select=${TENANT_SELECT}&limit=20`,
    { headers: supabaseHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchTenantsByAddressOnly(addressHint) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tenant_directory?property_address=ilike.*${encodeURIComponent(addressHint)}*&tenant_type=eq.Financially+Responsible&select=${TENANT_SELECT}&limit=20`,
    { headers: supabaseHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchPropertiesByName(hint) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?name=ilike.*${encodeURIComponent(hint)}*&managed_by_milestone=eq.true&is_group=eq.false&select=id,name,city,address`,
    { headers: supabaseHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchPropertiesByAddress(hint) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?address=ilike.*${encodeURIComponent(hint)}*&managed_by_milestone=eq.true&is_group=eq.false&select=id,name,city,address`,
    { headers: supabaseHeaders() }
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function unitNotFoundError(rows) {
  const sampleUnits = [...new Set(rows.map((r) => r.unit).filter(Boolean))].slice(0, 10);
  return {
    error: 'unit_not_found',
    propertyName: rows[0]?.property_name,
    propertyAddress: rows[0]?.property_address,
    city: rows[0]?.property_city,
    sampleUnits,
  };
}

export async function lookupTenant(propertyHint, unitNumber) {
  const hint = (propertyHint || '').trim();
  const unit = (unitNumber || '').trim();
  if (!hint || !unit) {
    return { error: 'missing_property_or_unit' };
  }

  // 1. Direct name + unit match in tenant_directory
  const byName = await fetchTenantsByName(hint, unit);
  if (byName.length > 0) return formatTenantResult(byName, unit);

  // 2. Resolve canonical name via properties table, then re-query tenants
  const propsByName = await fetchPropertiesByName(hint);
  for (const prop of propsByName) {
    const rows = await fetchTenantsByName(prop.name, unit);
    if (rows.length > 0) {
      return formatTenantResult(rows, unit, { propertyName: prop.name, city: prop.city });
    }
  }

  // 3. Address fallback — always runs, even when properties-by-name is empty.
  //    (Previously nested behind a non-empty properties result, so pasted street
  //    addresses like "3002 S 208th St Seatac Wa 98198" returned property_not_found.)
  const addrHints = addressSearchHints(hint);
  for (const addrHint of addrHints) {
    const byAddr = await fetchTenantsByAddress(addrHint, unit);
    if (byAddr.length > 0) return formatTenantResult(byAddr, unit);

    const propsByAddr = await fetchPropertiesByAddress(addrHint);
    for (const prop of propsByAddr) {
      const rows = await fetchTenantsByName(prop.name, unit);
      if (rows.length > 0) {
        return formatTenantResult(rows, unit, {
          propertyName: prop.name,
          city: prop.city,
          propertyAddress: prop.address || rows[0].property_address,
        });
      }
    }
  }

  // 4. Property/address exists but unit didn't match — return actionable error
  //    so the agent can ask the manager to confirm the unit format.
  const nameOnly = await fetchTenantsByNameOnly(hint);
  if (nameOnly.length > 0) return unitNotFoundError(nameOnly);

  for (const prop of propsByName) {
    const rows = await fetchTenantsByNameOnly(prop.name);
    if (rows.length > 0) return unitNotFoundError(rows);
  }

  for (const addrHint of addrHints) {
    const rows = await fetchTenantsByAddressOnly(addrHint);
    if (rows.length > 0) return unitNotFoundError(rows);
  }

  return { error: 'property_not_found' };
}

export async function loadState(thread_ts) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/thread_state?thread_ts=eq.${encodeURIComponent(thread_ts)}&select=state`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0].state : null;
}

export async function saveState(thread_ts, state) {
  await fetch(`${SUPABASE_URL}/rest/v1/thread_state`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ thread_ts, state, updated_at: new Date().toISOString() }),
  });
}

// ─── PDF generation ─────────────────────────────────────────────────────────

const STATE_BASELINE_LEGAL =
  'State law provides you the right to legal representation and the court may be able to appoint a lawyer to represent you without cost to you if you are a qualifying low-income renter. ' +
  'If you believe you are a qualifying low-income renter and would like an attorney appointed to represent you, please contact the Eviction Defense Screening Line at 855-657-8387 or apply online at https://nwjustice.org/apply-online. ' +
  'For additional resources, call 2-1-1 or the Northwest Justice Project CLEAR Hotline outside King County (888)201-1014 weekdays between 9:15 a.m. – 12:15 p.m., or (888) 387-7111 for seniors (age 60 and over). ' +
  'You may find additional information to help you at http://www.washingtonlawhelp.org. ' +
  'Free or low-cost mediation services to assist in nonpayment of rent disputes before any judicial proceedings occur are also available at dispute resolution centers throughout the state. ' +
  'You can find your nearest dispute resolution center at https://www.resolutionwa.org. ' +
  'State law also provides you the right to receive interpreter services at court.';

const MUNICIPALITY_ADDENDA = {
  seattle:
    'Additional information based on the location of your rental premises in the City of Seattle:\n\n' +
    'RIGHT TO LEGAL COUNSEL: CITY LAW PROVIDES RENTERS WHO ARE UNABLE TO PAY FOR AN ATTORNEY THE RIGHT TO FREE LEGAL REPRESENTATION IN AN EVICTION LAWSUIT.\n\n' +
    'If you need help understanding this notice or information about your renter rights, call the Renting in Seattle Helpline at (206) 684-5700 or visit the web site at www.seattle.gov/rentinginseattle.',
  burien:
    'Additional information based on the location of your rental premises in the City of Burien:\n\n' +
    'Landlords are required to attach Renting in Burien Handbook - Resources when serving this notice to a tenant in the City of Burien. ' +
    'The current version of the Renting in Burien Handbook - Resources can be found at https://www.burienwa.gov/city_hall/laws_regulations/renting_in_burien/information_for_landlords.',
  seatac:
    'Additional information based on the location of your rental premises in the City of SeaTac:\n\n' +
    'SeaTac city code SMC 4.05.040(B) requires that your landlord provides you with a copy of resources found at this web address: ' +
    'https://www.seatacwa.gov/government/city-departments/community-and-economic-development/rental-housing-resources/rental-housing-resources-information',
};

export function generateNoticePdf(state) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      bufferPages: true,
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const tenantNames = state.tenantName || '___________________________';
    const propertyName = state.propertyName || '___________________________';
    const propertyAddress = state.propertyAddress || null;
    const unitNumber = state.unitNumber || '___';
    const city = (state.city || '') || '___________________________';
    const propertyState = state.propertyState || 'WA';
    const propertyZip = state.propertyZip || '';

    doc.font('Helvetica-Bold').fontSize(16).text('Milestone Properties');
    doc.font('Helvetica').fontSize(10)
      .text('PO Box 18379, Seattle, WA 98118')
      .text('206-325-1166');
    doc.moveDown(0.5);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(13)
      .text('10-DAY NOTICE TO COMPLY OR VACATE THE PREMISES', { align: 'center' });
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10)
      .text(`TO: ${tenantNames}`)
      .text(`Premises: ${propertyName}, Unit ${unitNumber}`);
    if (propertyAddress) {
      doc.text(`${propertyAddress}, Unit ${unitNumber}`);
      doc.text(`${city}, ${propertyState} ${propertyZip}`.trim());
    } else {
      doc.text(`${city}, WA`);
    }
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10).text(
      'YOU ARE HEREBY NOTIFIED that you are in violation of your rental agreement as described in ' +
      'Exhibit A, attached hereto and incorporated herein by reference. You are required to comply ' +
      'with your rental agreement OR vacate the premises within TEN (10) DAYS from the date of ' +
      'service of this notice.',
      { lineGap: 2 }
    );
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10)
      .text('Date of Service: _______________________________')
      .text('Compliance Deadline: _______________________________  (10 days from date of service)');
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10)
      .text('Landlord/Agent: Milestone Properties')
      .text('PO Box 18379, Seattle, WA 98118')
      .text('206-325-1166');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text('Signature: _______________________________');
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(9).text(STATE_BASELINE_LEGAL, { lineGap: 2 });

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(13).text('EXHIBIT A', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10)
      .text('Section 1 — Rental Agreement, Lease, and/or Rules and Regulations:');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).text(state.section1 || '', { lineGap: 2 });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10)
      .text('Section 2 — Violation(s) of the Rental Agreement:');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).text(state.section2 || '', { lineGap: 2 });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10)
      .text('Section 3 — Required Action(s):');
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).text(state.section3 || '', { lineGap: 2 });

    const cityLower = (state.city || '').toLowerCase();
    let addendumText = null;
    if (cityLower.includes('seattle')) addendumText = MUNICIPALITY_ADDENDA.seattle;
    else if (cityLower.includes('burien')) addendumText = MUNICIPALITY_ADDENDA.burien;
    else if (cityLower.includes('seatac') || cityLower.includes('sea-tac') || cityLower.includes('sea tac'))
      addendumText = MUNICIPALITY_ADDENDA.seatac;

    if (addendumText) {
      doc.moveDown(1.5);
      doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).text('MUNICIPALITY ADDENDUM', { align: 'center' });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9).text(addendumText, { lineGap: 2 });
    }

    // ── Page 3: Declaration of Service ──────────────────────────────────────
    doc.addPage();

    const fullAddress = [
      propertyAddress ? `${propertyAddress}, Unit ${unitNumber}` : `Unit ${unitNumber}`,
      [city, propertyState, propertyZip].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ');

    doc.font('Helvetica-Bold').fontSize(13).text('DECLARATION OF SERVICE', { align: 'center' });
    doc.moveDown(0.25);
    doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(1);

    const managerName = state.managerName || null;
    const managerLine = managerName
      ? `I, ${managerName}, declare under penalty of perjury under the laws of the State of Washington that I am an adult over the age of 18, and that I served the following notice on the tenant(s) named below.`
      : 'I, _________________________________, declare under penalty of perjury under the laws of the State of Washington that I am an adult over the age of 18, and that I served the following notice on the tenant(s) named below.';
    doc.font('Helvetica').fontSize(10).text(managerLine, { lineGap: 2 });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10).text('Notice Type:');
    doc.font('Helvetica').fontSize(10).text('10-Day Notice to Comply or Vacate the Premises');
    doc.moveDown(0.75);

    doc.font('Helvetica-Bold').fontSize(10).text('Tenant(s):');
    doc.font('Helvetica').fontSize(10).text(tenantNames);
    doc.moveDown(0.75);

    doc.font('Helvetica-Bold').fontSize(10).text('Premises Address:');
    doc.font('Helvetica').fontSize(10).text(fullAddress);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10).text('Method of Service (check one):');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text(
      '[ ]  Personal Service — Delivered directly to the tenant(s) or a person of suitable age ' +
      'and discretion at the premises.',
      { lineGap: 2 }
    );
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text(
      '[ ]  Substituted Service — Left with a person of suitable age and discretion at the premises ' +
      'AND mailed a copy by first class mail to the tenant(s) at the premises address.',
      { lineGap: 2 }
    );
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text(
      '[ ]  Posting and Mail Service — Posted in a conspicuous place on the premises AND mailed a ' +
      'copy by first class mail to the tenant(s) at the premises address.',
      { lineGap: 2 }
    );
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(10).text('Date of Service:  ', { continued: true });
    doc.font('Helvetica').fontSize(10).text('_______________________________');
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(10).text('Time of Service:  ', { continued: true });
    doc.font('Helvetica').fontSize(10).text('_____________   [ ] AM   [ ] PM');
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(10).text('City of Signing:  ', { continued: true });
    doc.font('Helvetica').fontSize(10).text(city);
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(9).text(
      'I declare under penalty of perjury under the laws of the State of Washington that the foregoing ' +
      'is true and correct.',
      { lineGap: 2 }
    );
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(10).text('Signature: _______________________________');
    doc.moveDown(0.75);
    doc.font('Helvetica').fontSize(10).text(`Printed Name: ${managerName || '_______________________________'}`);
    doc.moveDown(0.75);
    doc.font('Helvetica').fontSize(10).text('Date: _______________________________');

    doc.end();
  });
}

export async function uploadPdfToSlack(pdfBuffer, filename, thread_ts) {
  return uploadFileToSlack(SLACK_BOT_TOKEN, COMPLY_CHANNEL_ID, pdfBuffer, filename, thread_ts);
}

// ─── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'long', day: 'numeric', year: 'numeric',
  });
  return `Today's date is ${today}. Use this as the current date when the manager references relative dates (e.g., "today", "this morning", "yesterday").

You are a Lease Compliance Assistant for Milestone Properties, a Seattle-area residential property management company. Your job is to help property managers create legally sound 10-Day Notice to Comply or Vacate notices.

You operate in a Slack channel. When a manager reports a lease violation, you:
1. Ask clarifying questions to fully understand the violation — ONE question at a time
2. Call lookup_tenant to find all Financially Responsible tenants for the unit. Pass whatever the manager provided as property_hint — it can be a property name ("Willow Lake"), a partial name, or a street address ("3002 S 208th St" or a full "3002 S 208th St Seatac Wa 98198"). Present the results — all tenant names plus full address (street, city, state, zip) — and ask the manager: "Please confirm these are the correct tenants and address for this unit before I proceed." Wait for their confirmation before moving to step 3.
   - If lookup_tenant returns error "unit_not_found", the property WAS found but the unit did not match. Tell the manager the property name/address you found and list the sample_units from the response (exact DB formats). Ask them to pick/confirm the correct unit — do NOT claim the property is missing.
   - If lookup_tenant returns error "property_not_found", ask for a different property name or street address.
3. Ask: "Which staff member should be listed on this notice as the serving party?" Once they answer, call record_manager_name with the full name they provide.
4. Draft each of the three Exhibit A sections ONE AT A TIME, getting approval before moving to the next
5. Once all three sections are approved, call record_section_approval for section 3 and announce the PDF is being generated

## Conversation rules — follow these strictly

**One question at a time.** Never ask more than one question per reply. If you need several pieces of information, ask the most important one first and collect the rest in subsequent turns. The manager will find it overwhelming if you ask multiple questions at once.

**Incomplete or bundled answers are fine.** If the manager's reply happens to answer multiple pending questions, extract everything useful from it and ask only what's still missing — one item at a time.

**If the manager's reply doesn't answer the question you asked**, respond with a short, polite redirect. Example: "I need [specific thing] to continue — [re-state the question simply]." Do not move on until you have that answer.

**If the manager's reply is ambiguous**, pick the most reasonable interpretation, state it clearly ("I'll take that as [X]"), and move on rather than re-asking.

**Do not repeat information back** at length or summarize what the manager said before asking your next question. Keep responses short and direct.

## Lease Section Reference
The following lease sections are available for Exhibit A, Section 1 citations. Use the exact section name and text — do not modify this language:

${Object.entries(LEASE_SECTIONS)
  .map(([key, val]) => `**${key}**: ${val.section}\n"${val.text}"`)
  .join('\n\n')}

## Municipality Rules

All notices must include this state baseline legal help language in the body:
"State law provides you the right to legal representation and the court may be able to appoint a lawyer to represent you without cost to you if you are a qualifying low-income renter. If you believe you are a qualifying low-income renter and would like an attorney appointed to represent you, please contact the Eviction Defense Screening Line at 855-657-8387 or apply online at https://nwjustice.org/apply-online. For additional resources, call 2-1-1 or the Northwest Justice Project CLEAR Hotline outside King County (888)201-1014 weekdays between 9:15 a.m. – 12:15 p.m., or (888) 387-7111 for seniors (age 60 and over). You may find additional information to help you at http://www.washingtonlawhelp.org. Free or low-cost mediation services to assist in nonpayment of rent disputes before any judicial proceedings occur are also available at dispute resolution centers throughout the state. You can find your nearest dispute resolution center at https://www.resolutionwa.org. State law also provides you the right to receive interpreter services at court."

Municipality-specific addendum language (append after state baseline):

- **WA State / Renton / Des Moines / Tacoma**: No addendum required beyond state baseline above.

- **Seattle**: Add this addendum page:
  "Additional information based on the location of your rental premises in the City of Seattle:
  RIGHT TO LEGAL COUNSEL: CITY LAW PROVIDES RENTERS WHO ARE UNABLE TO PAY FOR AN ATTORNEY THE RIGHT TO FREE LEGAL REPRESENTATION IN AN EVICTION LAWSUIT.
  If you need help understanding this notice or information about your renter rights, call the Renting in Seattle Helpline at (206) 684-5700 or visit the web site at www.seattle.gov/rentinginseattle."

- **Burien**: Add this addendum page:
  "Additional information based on the location of your rental premises in the City of Burien:
  Landlords are required to attach Renting in Burien Handbook - Resources when serving this notice to a tenant in the City of Burien. The current version of the Renting in Burien Handbook - Resources can be found at https://www.burienwa.gov/city_hall/laws_regulations/renting_in_burien/information_for_landlords."
  Also flag to the manager: they must physically attach the Renting in Burien Handbook - Resources document when serving this notice.

- **SeaTac**: Add this addendum page:
  "Additional information based on the location of your rental premises in the City of SeaTac:
  SeaTac city code SMC 4.05.040(B) requires that your landlord provides you with a copy of resources found at this web address: https://www.seatacwa.gov/government/city-departments/community-and-economic-development/rental-housing-resources/rental-housing-resources-information"
  Also flag to the manager: they must print and attach the SeaTac rental housing resources page when serving this notice.

## Notice Exhibit A Structure
**Section 1**: Rental Agreement, Lease, and/or Rules and Regulations applying to your tenancy:
-> Cite the exact lease section(s) that apply. Do not modify lease language.

**Section 2**: Your violation(s) of the Rental Agreement, Lease, and/or Rules and Regulations as follows:
-> Describe the specific violation factually and specifically. Include dates, observations, and relevant details the manager provided.

**Section 3**: You are required to perform the following action(s) by the deadline specified on this notice or you may be liable of unlawful detainer:
-> List clear, specific, measurable corrective actions the tenant must take.

## Section-by-section drafting flow

Work through Exhibit A one section at a time. Never present more than one section at once.

**Step 1 - Section 1 (Lease Citations)**
Once you have confirmed the tenant and have enough detail about the violation, present Section 1 only:

*Section 1 - Draft:*
*[cite the exact lease section name and full quoted text - bold the entire draft content]*

APPROVE_OR_REVISE

**Step 2 - Section 2 (Violation Description)**
When the manager approves Section 1:
1. Call record_section_approval with section_number=1 and the final approved text
2. Present Section 2 only using the same format

**Step 3 - Section 3 (Required Actions)**
When the manager approves Section 2:
1. Call record_section_approval with section_number=2 and the final approved text
2. Present Section 3 only using the same format

**Step 4 - PDF generation**
When the manager approves Section 3:
1. Call record_section_approval with section_number=3 and the final approved text
2. Reply: "All three sections approved. Generating the notice PDF now - it will appear in this thread shortly."

If the manager requests changes to any section, revise it and re-present it before proceeding.

IMPORTANT: When presenting a section draft, end your message with exactly this line (nothing else after it):
APPROVE_OR_REVISE

This signals that interactive approve/revise buttons should be shown.

## Notice type triage

Before drafting, confirm the violation type is appropriate:
- Lease covenant violation (pet, smoking, occupant, etc.) -> 10-Day Comply or Vacate (this bot)
- Unpaid rent -> 14-Day Pay or Vacate (different form - do not use this flow)
- Waste, nuisance, unlawful activity, criminal conduct -> 3-Day Quit (different form - flag to manager)
- Health/safety issue remediable by repair or cleaning -> 30-Day Remediation (different form - flag)

## Service method (as of June 11, 2026 - HB 2664)

Certified mail is no longer required. Acceptable methods:
- Personal delivery
- First-class mail postmarked from WA state (adds 5 calendar days before deadline begins)
- Posting on door + mailing

## Seattle-specific considerations

- School-year defense (Oct 1 - Apr 30): tenants with school-age children may raise a defense
- Winter defense (Nov 1 - Mar 31): additional protections
- Three-notices rule: third notice in 12 months allows end-of-tenancy termination
- 3-day nuisance notices require copy to SDCI

## Section 2 specificity requirement

Always include: exact date(s), time (if relevant), location on property, observer name/role, specific lease clause violated, and for pets: description of animal; for occupants: name if known; for smoking: substance and location.

## Tone and format
- Be professional but concise in Slack messages
- Always confirm tenant identity before drafting
- Never include late fees or monetary amounts
- When asking a question with fixed answer options, present them as a numbered list:
  1. Option one
  2. Option two
  3. Other - describe below
  Always include an "Other" option.
- You do not send the notice - the manager prints and serves it`;
}

// ─── Agent loop ─────────────────────────────────────────────────────────────

export const MAX_TOOL_ROUNDS = 8;

export async function runAgent(userMessage, conversationHistory, state) {
  let tenantData = null;
  let managerName = null;
  const sectionApprovals = [];

  let stateContext = '';
  if (state?.tenantName) {
    const addr = [state.propertyAddress, state.unitNumber && `Unit ${state.unitNumber}`, state.city, state.propertyState, state.propertyZip]
      .filter(Boolean).join(', ');
    stateContext += `[Confirmed state: Tenant "${state.tenantName}"${addr ? ` at ${addr}` : ''} has already been confirmed by the manager. Do NOT call lookup_tenant again.]\n`;
  }
  if (state?.managerName) stateContext += `[Staff member for the notice: "${state.managerName}" — do NOT call record_manager_name again.]\n`;
  if (state?.section1) stateContext += '[Section 1 already approved - do not re-draft it.]\n';
  if (state?.section2) stateContext += '[Section 2 already approved - do not re-draft it.]\n';
  if (state?.section3) stateContext += '[Section 3 already approved - do not re-draft it.]\n';

  const messages = conversationHistory.map((m) => ({ role: m.role, content: m.content }));
  const currentContent = stateContext ? stateContext + userMessage : userMessage;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    // Duplicate sends or a missing bot reply left history ending with a user turn.
    // Merge to avoid consecutive user roles, which Anthropic rejects.
    lastMsg.content += '\n' + currentContent;
  } else {
    messages.push({ role: 'user', content: currentContent });
  }

  const tools = [
    {
      name: 'lookup_tenant',
      description: 'Look up Financially Responsible tenants in Supabase by property name and unit number. Pass whatever the manager provided as property_hint — it can be a property name, partial name, or street address (with or without city/state/zip). Returns tenants with full address, or an error: property_not_found, unit_not_found (includes sampleUnits showing how units are stored for that property), or missing_property_or_unit. After a successful call, present all found tenants and their full address and ask the manager to confirm before proceeding. On unit_not_found, show the sample units and ask which one is correct — do not say the property is missing.',
      input_schema: {
        type: 'object',
        properties: {
          property_hint: { type: 'string', description: 'Property name, partial name, or street address' },
          unit_number: { type: 'string', description: 'Unit number as the manager wrote it (e.g. B06, B-06, 204)' },
        },
        required: ['property_hint', 'unit_number'],
      },
    },
    {
      name: 'record_section_approval',
      description: 'Call this when the manager has approved the content for a section of Exhibit A.',
      input_schema: {
        type: 'object',
        properties: {
          section_number: { type: 'number', description: '1, 2, or 3' },
          content: { type: 'string', description: 'The complete final approved text for this section' },
        },
        required: ['section_number', 'content'],
      },
    },
    {
      name: 'record_manager_name',
      description: 'Call this once the manager has confirmed which staff member should be listed on the notice as the serving party.',
      input_schema: {
        type: 'object',
        properties: {
          manager_name: { type: 'string', description: 'Full name of the staff member who will serve the notice' },
        },
        required: ['manager_name'],
      },
    },
  ];

  let response = await callClaude({
    maxTokens: 4096,
    system: buildSystemPrompt(),
    messages,
    tools,
  });

  let toolRounds = 0;
  while (response.stop_reason === 'tool_use') {
    toolRounds += 1;
    if (toolRounds > MAX_TOOL_ROUNDS) {
      throw new Error(`Agent exceeded ${MAX_TOOL_ROUNDS} tool rounds without finishing — please try again`);
    }

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    const toolResults = [];
    for (const toolUseBlock of toolUseBlocks) {
      let toolResult;
      if (toolUseBlock.name === 'lookup_tenant') {
        const { property_hint, unit_number } = toolUseBlock.input;
        const lookupResult = await lookupTenant(property_hint, unit_number);
        toolResult = JSON.stringify(lookupResult);
        if (!lookupResult.error && lookupResult.tenants?.length) {
          const t = lookupResult.tenants[0];
          tenantData = {
            tenantName: lookupResult.tenants.map((x) => x.tenant_name).join(' & '),
            propertyName: lookupResult.propertyName || t.property_name,
            propertyAddress: lookupResult.propertyAddress || t.property_address,
            unitNumber: lookupResult.unitNumber || t.unit,
            city: lookupResult.city || t.property_city,
            propertyState: lookupResult.propertyState || t.property_state,
            propertyZip: lookupResult.propertyZip || t.property_zip,
          };
        }
      } else if (toolUseBlock.name === 'record_section_approval') {
        const { section_number, content } = toolUseBlock.input;
        sectionApprovals.push({ section_number, content });
        toolResult = JSON.stringify({ ok: true });
      } else if (toolUseBlock.name === 'record_manager_name') {
        managerName = toolUseBlock.input.manager_name;
        toolResult = JSON.stringify({ ok: true });
      } else {
        toolResult = JSON.stringify({ error: 'unknown_tool' });
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResult });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await callClaude({
      maxTokens: 4096,
      system: buildSystemPrompt(),
      messages,
      tools,
    });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return { text: textBlock ? textBlock.text : '(no response)', tenantData, managerName, sectionApprovals };
}
