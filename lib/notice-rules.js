// lib/notice-rules.js
// Where the comply bot's legal text comes from.
//
// The source of truth is Milestone's notice rulebook in POV-app, read through
// GET /api/rules/resolve. Conor approves every change there. This file keeps a
// bundled last-known copy of the text, used ONLY when the rulebook can't be
// reached -- and every time that happens it is logged loudly and noted on the
// notice's review message, so a stale copy can never be used silently.

// ─── Bundled last-known copy (offline fallback only) ────────────────────────
// Matches production text as of 2026-10-30, and is what POV-app migration 0026
// was generated from (scripts/import-comply-rules.ts). Do not edit legal text
// here; change it in the rulebook.

export const BUNDLED_COPY_DATE = '2026-10-30';

export const STATE_BASELINE_LEGAL =
  'State law provides you the right to legal representation and the court may be able to appoint a lawyer to represent you without cost to you if you are a qualifying low-income renter. ' +
  'If you believe you are a qualifying low-income renter and would like an attorney appointed to represent you, please contact the Eviction Defense Screening Line at 855-657-8387 or apply online at https://nwjustice.org/apply-online. ' +
  'For additional resources, call 2-1-1 or the Northwest Justice Project CLEAR Hotline outside King County (888)201-1014 weekdays between 9:15 a.m. – 12:15 p.m., or (888) 387-7111 for seniors (age 60 and over). ' +
  'You may find additional information to help you at http://www.washingtonlawhelp.org. ' +
  'Free or low-cost mediation services to assist in nonpayment of rent disputes before any judicial proceedings occur are also available at dispute resolution centers throughout the state. ' +
  'You can find your nearest dispute resolution center at https://www.resolutionwa.org. ' +
  'State law also provides you the right to receive interpreter services at court.';

export const MUNICIPALITY_ADDENDA = {
  Seattle:
    'Additional information based on the location of your rental premises in the City of Seattle:\n\n' +
    'RIGHT TO LEGAL COUNSEL: CITY LAW PROVIDES RENTERS WHO ARE UNABLE TO PAY FOR AN ATTORNEY THE RIGHT TO FREE LEGAL REPRESENTATION IN AN EVICTION LAWSUIT.\n\n' +
    'If you need help understanding this notice or information about your renter rights, call the Renting in Seattle Helpline at (206) 684-5700 or visit the web site at www.seattle.gov/rentinginseattle.',
  Burien:
    'Additional information based on the location of your rental premises in the City of Burien:\n\n' +
    'Landlords are required to attach Renting in Burien Handbook - Resources when serving this notice to a tenant in the City of Burien. ' +
    'The current version of the Renting in Burien Handbook - Resources can be found at https://www.burienwa.gov/city_hall/laws_regulations/renting_in_burien/information_for_landlords.',
  SeaTac:
    'Additional information based on the location of your rental premises in the City of SeaTac:\n\n' +
    'SeaTac city code SMC 4.05.040(B) requires that your landlord provides you with a copy of resources found at this web address: ' +
    'https://www.seatacwa.gov/government/city-departments/community-and-economic-development/rental-housing-resources/rental-housing-resources-information',
};

/** The bundled-copy city for a free-text city, using the bot's original matching. */
export function bundledCity(city) {
  const c = (city || '').toLowerCase();
  if (c.includes('seattle')) return 'Seattle';
  if (c.includes('burien')) return 'Burien';
  if (c.includes('seatac') || c.includes('sea-tac') || c.includes('sea tac')) return 'SeaTac';
  return null;
}

/** Rulebook spelling of a city: "Sea-Tac" and "Sea Tac" are SeaTac. */
function rulebookCity(city) {
  return bundledCity(city) ?? (city || '').trim();
}

function isWashington(state) {
  const s = (state || 'WA').trim().toLowerCase().replace(/\./g, '');
  return s === '' || s === 'wa' || s === 'washington';
}

/**
 * @typedef {object} ComplyRules
 * @property {'rulebook'|'bundled_fallback'|'bundled_out_of_state'} source
 * @property {string} baselineText    statewide legal-help language for the notice body
 * @property {string|null} addendumText  city addendum page, or null
 * @property {string|null} city       city as the rulebook knows it
 * @property {boolean} statewideFallback  the city has no approved comply rule, so statewide only
 * @property {string[]} ruleVersionIds
 * @property {string|null} fallbackReason  why the bundled copy was used
 */

/** @returns {ComplyRules} */
export function bundledComplyRules(city, source = 'bundled_fallback', fallbackReason = null) {
  const key = bundledCity(city);
  return {
    source,
    baselineText: STATE_BASELINE_LEGAL,
    addendumText: key ? MUNICIPALITY_ADDENDA[key] : null,
    city: key ?? (city || null),
    statewideFallback: false,
    ruleVersionIds: [],
    fallbackReason,
  };
}

function fallBackToBundled(city, reason) {
  console.error(
    `[comply] RULEBOOK FALLBACK — using the bundled legal text from ${BUNDLED_COPY_DATE} for "${city || ''}": ${reason}`
  );
  return bundledComplyRules(city, 'bundled_fallback', reason);
}

const TIMEOUT_MS = 8000;

/**
 * Asks the rulebook for the approved comply-or-vacate language for a property.
 * Called fresh for every notice (no cache), so a rule Conor approves applies to
 * the very next notice and nothing carries over between threads.
 *
 * @returns {Promise<ComplyRules>}
 */
export async function resolveComplyRules({ city, state }, { fetchImpl = fetch, env = process.env } = {}) {
  // Out-of-state properties keep the bot's existing behavior for now.
  if (!isWashington(state)) return bundledComplyRules(city, 'bundled_out_of_state');

  const base = (env.RULES_API_URL || '').replace(/\/+$/, '');
  const secret = (env.RULES_API_SECRET || '').trim();
  if (!base || !secret) return fallBackToBundled(city, 'RULES_API_URL / RULES_API_SECRET are not set');

  const name = rulebookCity(city);
  const url =
    `${base}/api/rules/resolve?state=WA&notice_type=comply_or_vacate` +
    `&city=${encodeURIComponent(name)}`;

  let res;
  let body;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await res.json();
  } catch (err) {
    return fallBackToBundled(city, `rulebook unreachable (${err?.message || err})`);
  }
  if (!res.ok || !body?.ok) {
    return fallBackToBundled(city, `rulebook answered HTTP ${res.status}${body?.error ? ` (${body.error})` : ''}`);
  }

  const legends = Array.isArray(body.legends) ? body.legends : [];
  const text = (l) => (l.renderedParagraphs || l.paragraphs || []).join('\n\n');
  const baseline = legends.find((l) => String(l.ruleKey || '').startsWith('wa.'));
  // Never send a notice without the statewide legal-help language.
  if (!baseline || !text(baseline)) {
    return fallBackToBundled(city, 'rulebook has no approved statewide comply-or-vacate language yet');
  }
  const cityLegends = legends.filter((l) => l !== baseline);

  return {
    source: 'rulebook',
    baselineText: text(baseline),
    addendumText: cityLegends.length ? cityLegends.map(text).join('\n\n') : null,
    city: body.jurisdiction?.name ?? (name || null),
    statewideFallback: body.fallback === 'statewide',
    ruleVersionIds: Array.isArray(body.ruleVersionIds) ? body.ruleVersionIds : [],
    fallbackReason: null,
  };
}

/** One-message summary of where the notice's legal text came from, for the reviewer. */
export function rulesReviewNote(rules) {
  const versions = rules.ruleVersionIds.length
    ? `\nRule versions: ${rules.ruleVersionIds.map((id) => `\`${id}\``).join(', ')}`
    : '';
  if (rules.source === 'bundled_fallback') {
    return (
      `⚠️ *The notice rulebook could not be used* (${rules.fallbackReason}). ` +
      `This notice uses the bot's bundled copy of the legal text from ${BUNDLED_COPY_DATE}. Check it before serving.`
    );
  }
  if (rules.source === 'bundled_out_of_state') {
    return 'ℹ️ Out-of-state property: legal text not checked against the rulebook.';
  }
  if (rules.statewideFallback) {
    return (
      `⚠️ *Statewide language only* — ${rules.city || 'this city'} has no approved comply-or-vacate city rule in the rulebook yet, ` +
      `so no city addendum was added.${versions}`
    );
  }
  return `📘 Legal text from the notice rulebook${rules.addendumText ? `, with the ${rules.city} city addendum` : ''}.${versions}`;
}
