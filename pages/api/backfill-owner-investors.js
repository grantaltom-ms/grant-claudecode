import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'grant@milestoneproperties.net';
const DEFAULT_OWNER_INVESTOR_SUPABASE_URL = 'https://augbrysfqwgekfhfokco.supabase.co';
const targetSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function verifyCronRequest(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function boundedInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function projectRefFromUrl(url) {
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

function sourceClient() {
  const sourceUrl = process.env.OWNER_INVESTOR_SUPABASE_URL || DEFAULT_OWNER_INVESTOR_SUPABASE_URL;
  const sourceKey =
    process.env.OWNER_INVESTOR_SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    supabase: createClient(sourceUrl, sourceKey),
    url: sourceUrl,
  };
}

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactJson(value) {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function ownerPropertiesFor(owner, ownerProperties, propertiesById) {
  return ownerProperties
    .filter(row => row.owner_id === owner.id)
    .map(row => {
      const property = propertiesById.get(row.property_id) || {};
      return {
        property_id: row.property_id,
        property_name: property.name || null,
        appfolio_prop_id: row.appfolio_prop_id || null,
        ownership_pct: row.ownership_pct || null,
      };
    })
    .filter(row => row.property_name || row.property_id);
}

function ownerSummary(owner, properties) {
  const propertyNames = properties.map(property => property.property_name).filter(Boolean);
  const flags = [
    owner.payment_type ? `payment type: ${owner.payment_type}` : null,
    owner.send_packets_by_email === true ? 'packets by email' : null,
    owner.hold_payments === true ? 'payments on hold' : null,
    owner.last_payment_date ? `last payment date: ${owner.last_payment_date}` : null,
  ].filter(Boolean);

  return [
    `${owner.name} is an owner/investor contact.`,
    owner.email ? `Email: ${owner.email}.` : null,
    owner.phone ? `Phone: ${owner.phone}.` : null,
    propertyNames.length ? `Linked properties: ${propertyNames.join(', ')}.` : null,
    flags.length ? `Owner account details: ${flags.join('; ')}.` : null,
  ].filter(Boolean).join(' ');
}

function ownerChunkText(owner, properties, summary) {
  return [
    `Person: ${owner.name}`,
    'Role: owner/investor',
    owner.email ? `Email: ${owner.email}` : null,
    owner.phone ? `Phone: ${owner.phone}` : null,
    owner.payment_type ? `Payment type: ${owner.payment_type}` : null,
    owner.send_packets_by_email != null ? `Send packets by email: ${owner.send_packets_by_email}` : null,
    owner.hold_payments != null ? `Hold payments: ${owner.hold_payments}` : null,
    owner.last_payment_date ? `Last payment date: ${owner.last_payment_date}` : null,
    owner.notes ? `Notes: ${owner.notes}` : null,
    `Linked properties: ${properties.map(property => [
      property.property_name || `property ${property.property_id}`,
      property.ownership_pct ? `${property.ownership_pct}%` : null,
    ].filter(Boolean).join(' - ')).join('; ')}`,
    `Summary: ${summary}`,
  ].filter(Boolean).join('\n');
}

async function loadSourceOwners(sourceSupabase, limit) {
  const { data: owners, error: ownerError } = await sourceSupabase
    .from('owners')
    .select('id, appfolio_owner_id, name, email, phone, payment_type, send_packets_by_email, hold_payments, last_payment_date, notes, updated_at')
    .not('name', 'is', null)
    .order('name', { ascending: true })
    .limit(limit);

  if (ownerError) throw new Error(`Owner source load failed: ${ownerError.message}`);

  const ownerIds = (owners || []).map(owner => owner.id);
  if (!ownerIds.length) return [];

  const { data: ownerProperties, error: ownerPropertyError } = await sourceSupabase
    .from('owner_properties')
    .select('owner_id, property_id, appfolio_prop_id, ownership_pct')
    .in('owner_id', ownerIds);

  if (ownerPropertyError) throw new Error(`Owner-property source load failed: ${ownerPropertyError.message}`);

  const propertyIds = [...new Set((ownerProperties || []).map(row => row.property_id).filter(Boolean))];
  const { data: properties, error: propertyError } = propertyIds.length
    ? await sourceSupabase
      .from('properties')
      .select('id, name')
      .in('id', propertyIds)
    : { data: [], error: null };

  if (propertyError) throw new Error(`Owner property name load failed: ${propertyError.message}`);

  const propertiesById = new Map((properties || []).map(property => [property.id, property]));
  return (owners || []).map(owner => ({
    ...owner,
    properties: ownerPropertiesFor(owner, ownerProperties || [], propertiesById),
  }));
}

async function upsertOwnerMemory(owner, sourceProjectRef) {
  const normalizedName = normalizeName(owner.name);
  if (!normalizedName) return { saved: false, skipped: true, reason: 'missing_name' };

  const now = new Date().toISOString();
  const summary = ownerSummary(owner, owner.properties || []);
  const metadata = {
    role: 'owner_investor',
    source: 'supabase_owner_table',
    source_project_ref: sourceProjectRef,
    source_table: 'owners',
    source_owner_id: owner.id,
    appfolio_owner_id: owner.appfolio_owner_id || null,
    email: owner.email || null,
    phone: owner.phone || null,
    payment_type: owner.payment_type || null,
    send_packets_by_email: owner.send_packets_by_email,
    hold_payments: owner.hold_payments,
    last_payment_date: owner.last_payment_date || null,
    properties: owner.properties || [],
  };

  const { data: entity, error: entityError } = await targetSupabase
    .from('entities')
    .upsert({
      owner_email: OWNER_EMAIL,
      entity_type: 'person',
      name: owner.name,
      normalized_name: normalizedName,
      current_summary: summary,
      metadata,
      last_seen_at: now,
      updated_at: now,
    }, {
      onConflict: 'owner_email,entity_type,normalized_name',
    })
    .select('id')
    .single();

  if (entityError) throw new Error(`Owner entity upsert failed for ${owner.name}: ${entityError.message}`);

  const { error: chunkError } = await targetSupabase
    .from('memory_chunks')
    .upsert({
      owner_email: OWNER_EMAIL,
      source_type: 'owner_investor',
      source_table: 'owners',
      source_pk: String(owner.id),
      source_id: String(owner.id),
      entity_id: entity.id,
      title: `Owner/investor: ${owner.name}`,
      chunk_summary: summary,
      chunk_text: ownerChunkText(owner, owner.properties || [], summary),
      metadata: {
        ...metadata,
        property_names: (owner.properties || []).map(property => property.property_name).filter(Boolean),
        raw_properties: compactJson(owner.properties || []),
      },
      updated_at: now,
    }, {
      onConflict: 'owner_email,source_type,source_pk',
    });

  if (chunkError) throw new Error(`Owner memory chunk upsert failed for ${owner.name}: ${chunkError.message}`);

  return { saved: true, entity_id: entity.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  if (!verifyCronRequest(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Missing target Supabase environment variables.',
    });
  }

  try {
    const maxOwners = boundedInteger(req.query.max, 100, 1000);
    const { supabase: ownerSourceSupabase, url: sourceUrl } = sourceClient();
    const sourceProjectRef = projectRefFromUrl(sourceUrl);
    const owners = await loadSourceOwners(ownerSourceSupabase, maxOwners);

    let saved = 0;
    const errors = [];
    for (const owner of owners) {
      try {
        const result = await upsertOwnerMemory(owner, sourceProjectRef);
        if (result.saved) saved += 1;
      } catch (error) {
        errors.push({
          owner_id: owner.id,
          owner_name: owner.name,
          message: error.message,
        });
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      target_supabase_project_ref: projectRefFromUrl(process.env.SUPABASE_URL),
      source_supabase_project_ref: sourceProjectRef,
      owners_considered: owners.length,
      owners_saved: saved,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error('Owner/investor memory backfill failed:', error);
    return res.status(500).json({
      ok: false,
      target_supabase_project_ref: projectRefFromUrl(process.env.SUPABASE_URL),
      error: error.message,
    });
  }
}
