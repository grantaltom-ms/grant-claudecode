import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'grant@milestoneproperties.net';
const DEFAULT_SOURCE_SUPABASE_URL = 'https://augbrysfqwgekfhfokco.supabase.co';
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
  const sourceUrl = process.env.SOURCE_MEMORY_SUPABASE_URL
    || process.env.OWNER_INVESTOR_SUPABASE_URL
    || DEFAULT_SOURCE_SUPABASE_URL;
  const sourceKey =
    process.env.SOURCE_MEMORY_SUPABASE_SERVICE_ROLE_KEY
    || process.env.OWNER_INVESTOR_SUPABASE_SERVICE_ROLE_KEY
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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function money(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return Math.round(number).toLocaleString('en-US');
}

async function upsertEntity({ entityType, name, summary, metadata }) {
  const normalizedName = normalizeName(name);
  if (!normalizedName) return null;
  const now = new Date().toISOString();
  const { data, error } = await targetSupabase
    .from('entities')
    .upsert({
      owner_email: OWNER_EMAIL,
      entity_type: entityType,
      name,
      normalized_name: normalizedName,
      current_summary: summary || null,
      metadata: metadata || {},
      last_seen_at: now,
      updated_at: now,
    }, {
      onConflict: 'owner_email,entity_type,normalized_name',
    })
    .select('id')
    .single();

  if (error) throw new Error(`Entity upsert failed for ${name}: ${error.message}`);
  return data;
}

async function upsertChunk({ sourceType, sourceTable, sourcePk, entityId = null, title, summary, text, metadata }) {
  const { error } = await targetSupabase
    .from('memory_chunks')
    .upsert({
      owner_email: OWNER_EMAIL,
      source_type: sourceType,
      source_table: sourceTable,
      source_pk: String(sourcePk),
      source_id: null,
      entity_id: entityId,
      title,
      chunk_summary: summary || null,
      chunk_text: text,
      metadata: metadata || {},
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'owner_email,source_type,source_pk',
    });

  if (error) throw new Error(`Memory chunk upsert failed for ${sourceType}:${sourcePk}: ${error.message}`);
}

async function syncProperties(sourceSupabase, sourceProjectRef, limit) {
  const { data: properties, error: propertyError } = await sourceSupabase
    .from('properties')
    .select('id, appfolio_id, name, address, city, state, zip, property_type, total_units, year_built, square_footage, owner_entity, manager, manager_name, manager_email, manager_phone, neighborhood, managed_by_milestone, status, is_active, is_group, notes, updated_at')
    .not('name', 'is', null)
    .order('name', { ascending: true })
    .limit(limit);

  if (propertyError) throw new Error(`Property source load failed: ${propertyError.message}`);

  const propertyIds = (properties || []).map(property => property.id);
  const { data: aliases, error: aliasError } = propertyIds.length
    ? await sourceSupabase
      .from('property_aliases')
      .select('alias, property_id, confirmed_by, appfolio_property_id')
      .in('property_id', propertyIds)
    : { data: [], error: null };

  if (aliasError) throw new Error(`Property alias source load failed: ${aliasError.message}`);

  const aliasesByProperty = new Map();
  for (const alias of aliases || []) {
    const list = aliasesByProperty.get(alias.property_id) || [];
    list.push(alias);
    aliasesByProperty.set(alias.property_id, list);
  }

  let saved = 0;
  for (const property of properties || []) {
    const propertyAliases = aliasesByProperty.get(property.id) || [];
    const aliasNames = propertyAliases.map(alias => alias.alias).filter(Boolean).sort();
    const location = [property.address, property.city, property.state, property.zip].filter(Boolean).join(', ');
    const manager = property.manager_name || property.manager;
    const summary = [
      `${property.name} is a ${property.property_type || 'property'}${property.total_units ? ` with ${property.total_units} units` : ''}.`,
      location ? `Address: ${location}.` : null,
      manager ? `Manager: ${manager}.` : null,
      property.owner_entity ? `Owner entity: ${property.owner_entity}.` : null,
      aliasNames.length ? `Known aliases: ${aliasNames.join(', ')}.` : null,
      property.notes ? `Notes: ${property.notes}` : null,
    ].filter(Boolean).join(' ');

    const metadata = {
      source: 'source_supabase_properties',
      source_project_ref: sourceProjectRef,
      source_table: 'properties',
      source_property_id: property.id,
      appfolio_id: property.appfolio_id || null,
      aliases: aliasNames,
      address: location || null,
      city: property.city || null,
      state: property.state || null,
      zip: property.zip || null,
      property_type: property.property_type || null,
      total_units: property.total_units || null,
      year_built: property.year_built || null,
      square_footage: property.square_footage || null,
      owner_entity: property.owner_entity || null,
      manager: manager || null,
      manager_email: property.manager_email || null,
      manager_phone: property.manager_phone || null,
      neighborhood: property.neighborhood || null,
      managed_by_milestone: property.managed_by_milestone,
      status: property.status || null,
      is_active: property.is_active,
      is_group: property.is_group,
    };

    const entity = await upsertEntity({
      entityType: 'property',
      name: property.name,
      summary,
      metadata,
    });

    await upsertChunk({
      sourceType: 'property_profile',
      sourceTable: 'properties',
      sourcePk: property.id,
      entityId: entity?.id,
      title: `Property: ${property.name}`,
      summary,
      text: [
        `Property: ${property.name}`,
        `Aliases: ${aliasNames.join(', ')}`,
        `Address: ${location}`,
        `Type: ${property.property_type || ''}`,
        `Units: ${property.total_units || ''}`,
        `Year built: ${property.year_built || ''}`,
        `Owner entity: ${property.owner_entity || ''}`,
        `Manager: ${manager || ''}`,
        `Manager contact: ${[property.manager_email, property.manager_phone].filter(Boolean).join(', ')}`,
        `Neighborhood: ${property.neighborhood || ''}`,
        `Status: ${property.status || ''}`,
        `Notes: ${property.notes || ''}`,
        `Summary: ${summary}`,
      ].join('\n'),
      metadata: {
        ...metadata,
        raw_aliases: compactJson(propertyAliases),
      },
    });

    saved += 1;
  }

  return { considered: (properties || []).length, saved };
}

async function syncTeamMembers(sourceSupabase, sourceProjectRef) {
  const { data: members, error } = await sourceSupabase
    .from('team_members')
    .select('initials, name, team, tier, active, slack_user_id, sort_order, updated_at')
    .order('sort_order', { ascending: true });

  if (error) throw new Error(`Team member source load failed: ${error.message}`);

  let saved = 0;
  for (const member of members || []) {
    if (!member.name) continue;
    const summary = `${member.name} is a Milestone team member${member.team ? ` on ${member.team}` : ''}${member.tier ? ` (${member.tier})` : ''}.`;
    const metadata = {
      role: 'team_member',
      source: 'source_supabase_team_members',
      source_project_ref: sourceProjectRef,
      initials: member.initials || null,
      team: member.team || null,
      tier: member.tier || null,
      active: member.active,
      slack_user_id: member.slack_user_id || null,
      sort_order: member.sort_order || null,
    };
    const entity = await upsertEntity({
      entityType: 'person',
      name: member.name,
      summary,
      metadata,
    });
    await upsertChunk({
      sourceType: 'team_member',
      sourceTable: 'team_members',
      sourcePk: member.initials || normalizeName(member.name),
      entityId: entity?.id,
      title: `Team member: ${member.name}`,
      summary,
      text: [
        `Person: ${member.name}`,
        'Role: Milestone team member',
        `Initials: ${member.initials || ''}`,
        `Team: ${member.team || ''}`,
        `Tier: ${member.tier || ''}`,
        `Active: ${member.active}`,
        `Slack user id: ${member.slack_user_id || ''}`,
      ].join('\n'),
      metadata,
    });
    saved += 1;
  }

  return { considered: (members || []).length, saved };
}

async function syncAgentContext(sourceSupabase, sourceProjectRef) {
  const { data: docs, error } = await sourceSupabase
    .from('agent_context')
    .select('id, doc_key, title, content, updated_at')
    .order('doc_key', { ascending: true });

  if (error) throw new Error(`Agent context source load failed: ${error.message}`);

  let saved = 0;
  for (const doc of docs || []) {
    if (!doc.doc_key && !doc.title) continue;
    const title = doc.title || doc.doc_key;
    const summary = `${title} is curated operating context for the inbox assistant.`;
    await upsertChunk({
      sourceType: 'agent_context',
      sourceTable: 'agent_context',
      sourcePk: doc.doc_key || doc.id,
      title: `Operating context: ${title}`,
      summary,
      text: [
        `Context key: ${doc.doc_key || ''}`,
        `Title: ${title}`,
        `Content: ${cleanText(doc.content) || ''}`,
      ].join('\n'),
      metadata: {
        source: 'source_supabase_agent_context',
        source_project_ref: sourceProjectRef,
        source_context_id: doc.id,
        doc_key: doc.doc_key || null,
        updated_at: doc.updated_at || null,
      },
    });
    saved += 1;
  }

  return { considered: (docs || []).length, saved };
}

function latestSnapshotsBySchedule(snapshots) {
  const latest = new Map();
  for (const snapshot of snapshots || []) {
    const current = latest.get(snapshot.schedule_id);
    if (!current || String(snapshot.as_of_date || '') > String(current.as_of_date || '')) {
      latest.set(snapshot.schedule_id, snapshot);
    }
  }
  return latest;
}

async function syncRealEstateSchedule(sourceSupabase, sourceProjectRef, limit) {
  const { data: schedules, error } = await sourceSupabase
    .from('real_estate_schedule')
    .select('id, property_id, entity_name, address, management_company, purchase_date, purchase_price, apartment_type, units, mortgagor, loan_type, estimated_maturity, pct_owned, taxes_ins_included, notes, updated_at')
    .not('entity_name', 'is', null)
    .order('entity_name', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Real estate schedule source load failed: ${error.message}`);

  const scheduleIds = (schedules || []).map(schedule => schedule.id);
  const propertyIds = [...new Set((schedules || []).map(schedule => schedule.property_id).filter(Boolean))];
  const [{ data: snapshots, error: snapshotError }, { data: properties, error: propertyError }] = await Promise.all([
    scheduleIds.length
      ? sourceSupabase
        .from('real_estate_schedule_snapshots')
        .select('schedule_id, as_of_date, market_value, loan_balance, market_value_pct_owned, loan_value_pct_owned, equity_pct_owned, annual_income_pct_owned, annual_income_total, annual_opex_pct_owned, annual_opex_total, annual_mortgage_interest_pct_owned, annual_principal_paydown_pct_owned, projected_annual_distribution')
        .in('schedule_id', scheduleIds)
      : { data: [], error: null },
    propertyIds.length
      ? sourceSupabase
        .from('properties')
        .select('id, name')
        .in('id', propertyIds)
      : { data: [], error: null },
  ]);

  if (snapshotError) throw new Error(`Real estate schedule snapshot load failed: ${snapshotError.message}`);
  if (propertyError) throw new Error(`Real estate schedule property load failed: ${propertyError.message}`);

  const latestSnapshots = latestSnapshotsBySchedule(snapshots || []);
  const propertiesById = new Map((properties || []).map(property => [property.id, property]));

  let saved = 0;
  for (const schedule of schedules || []) {
    const property = propertiesById.get(schedule.property_id);
    const entityName = schedule.entity_name || property?.name;
    if (!entityName) continue;

    const snapshot = latestSnapshots.get(schedule.id) || null;
    const summary = [
      `${entityName} is a real estate investment schedule entry${property?.name ? ` linked to ${property.name}` : ''}.`,
      schedule.units ? `Units: ${schedule.units}.` : null,
      schedule.pct_owned != null ? `Percent owned: ${schedule.pct_owned}%.` : null,
      schedule.purchase_date ? `Purchased: ${schedule.purchase_date}${schedule.purchase_price ? ` for $${money(schedule.purchase_price)}` : ''}.` : null,
      schedule.mortgagor ? `Mortgagor/lender: ${schedule.mortgagor}.` : null,
      schedule.estimated_maturity ? `Estimated maturity: ${schedule.estimated_maturity}.` : null,
      snapshot?.as_of_date ? `Latest snapshot ${snapshot.as_of_date}: market value $${money(snapshot.market_value)}, loan balance $${money(snapshot.loan_balance)}, equity owned $${money(snapshot.equity_pct_owned)}.` : null,
    ].filter(Boolean).join(' ');

    const metadata = {
      source: 'source_supabase_real_estate_schedule',
      source_project_ref: sourceProjectRef,
      source_schedule_id: schedule.id,
      source_property_id: schedule.property_id || null,
      property_name: property?.name || null,
      address: schedule.address || null,
      management_company: schedule.management_company || null,
      purchase_date: schedule.purchase_date || null,
      purchase_price: schedule.purchase_price || null,
      apartment_type: schedule.apartment_type || null,
      units: schedule.units || null,
      mortgagor: schedule.mortgagor || null,
      loan_type: schedule.loan_type || null,
      estimated_maturity: schedule.estimated_maturity || null,
      pct_owned: schedule.pct_owned || null,
      taxes_ins_included: schedule.taxes_ins_included || null,
      latest_snapshot: snapshot || null,
    };

    const entity = await upsertEntity({
      entityType: 'property',
      name: entityName,
      summary,
      metadata,
    });

    await upsertChunk({
      sourceType: 'real_estate_schedule',
      sourceTable: 'real_estate_schedule',
      sourcePk: schedule.id,
      entityId: entity?.id,
      title: `Real estate schedule: ${entityName}`,
      summary,
      text: [
        `Entity/property: ${entityName}`,
        `Linked property: ${property?.name || ''}`,
        `Address: ${schedule.address || ''}`,
        `Management company: ${schedule.management_company || ''}`,
        `Apartment type: ${schedule.apartment_type || ''}`,
        `Units: ${schedule.units || ''}`,
        `Purchase date: ${schedule.purchase_date || ''}`,
        `Purchase price: ${schedule.purchase_price || ''}`,
        `Percent owned: ${schedule.pct_owned || ''}`,
        `Mortgagor/lender: ${schedule.mortgagor || ''}`,
        `Loan type: ${schedule.loan_type || ''}`,
        `Estimated maturity: ${schedule.estimated_maturity || ''}`,
        `Taxes/insurance included: ${schedule.taxes_ins_included || ''}`,
        `Latest snapshot: ${compactJson(snapshot)}`,
        `Notes: ${schedule.notes || ''}`,
        `Summary: ${summary}`,
      ].join('\n'),
      metadata,
    });

    saved += 1;
  }

  return { considered: (schedules || []).length, saved };
}

function selectedScopes(queryScope) {
  const allScopes = ['properties', 'team_members', 'agent_context', 'real_estate_schedule'];
  if (!queryScope || queryScope === 'all') return allScopes;
  return String(queryScope)
    .split(',')
    .map(scope => scope.trim())
    .filter(scope => allScopes.includes(scope));
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
    const { supabase: sourceSupabase, url: sourceUrl } = sourceClient();
    const sourceProjectRef = projectRefFromUrl(sourceUrl);
    const scopes = selectedScopes(req.query.scope);
    if (!scopes.length) {
      return res.status(400).json({
        ok: false,
        error: 'No valid source memory scopes requested.',
        valid_scopes: ['properties', 'team_members', 'agent_context', 'real_estate_schedule'],
      });
    }

    const results = {};
    const errors = [];
    for (const scope of scopes) {
      try {
        if (scope === 'properties') {
          results.properties = await syncProperties(sourceSupabase, sourceProjectRef, boundedInteger(req.query.properties, 500, 1000));
        } else if (scope === 'team_members') {
          results.team_members = await syncTeamMembers(sourceSupabase, sourceProjectRef);
        } else if (scope === 'agent_context') {
          results.agent_context = await syncAgentContext(sourceSupabase, sourceProjectRef);
        } else if (scope === 'real_estate_schedule') {
          results.real_estate_schedule = await syncRealEstateSchedule(sourceSupabase, sourceProjectRef, boundedInteger(req.query.schedule, 500, 1000));
        }
      } catch (error) {
        errors.push({ scope, message: error.message });
      }
    }

    return res.status(200).json({
      ok: errors.length === 0,
      target_supabase_project_ref: projectRefFromUrl(process.env.SUPABASE_URL),
      source_supabase_project_ref: sourceProjectRef,
      scopes,
      results,
      errors,
    });
  } catch (error) {
    console.error('Source memory backfill failed:', error);
    return res.status(500).json({
      ok: false,
      target_supabase_project_ref: projectRefFromUrl(process.env.SUPABASE_URL),
      error: error.message,
    });
  }
}
