// A tiny in-memory stand-in for the parts of supabase-js the to-do list uses
// (select/update with eq, neq, in, not-in, order, limit, maybeSingle). It keeps
// state across calls, which is what lets a test run the digest several days
// in a row and watch items carry over, get clicked, and close.

export function createFakeSupabase(tables = {}) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));

  function builder(table) {
    const filters = [];
    let op = 'select';
    let patch = null;
    let orderBy = null;
    let limitN = null;
    let single = false;
    let countOnly = false;
    let inserted = null;

    const matches = (row) => filters.every((f) => f(row));
    const run = () => {
      const rows = db[table] || (db[table] = []);
      if (op === 'insert') {
        rows.push(...inserted.map((r) => ({ ...r })));
        return { data: null, error: null };
      }
      if (countOnly) return { data: null, count: rows.filter(matches).length, error: null };
      if (op === 'update') {
        const hit = rows.filter(matches);
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      let out = rows.filter(matches).map((r) => ({ ...r }));
      if (orderBy) {
        const { col, asc } = orderBy;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) out = out.slice(0, limitN);
      if (single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };

    const q = {
      select(_cols, opts = {}) { if (opts.head && opts.count) countOnly = true; return q; },
      insert(rows) { op = 'insert'; inserted = Array.isArray(rows) ? rows : [rows]; return q; },
      gte(col, v) { filters.push((r) => r[col] >= v); return q; },
      lt(col, v) { filters.push((r) => r[col] < v); return q; },
      update(p) { op = 'update'; patch = p; return q; },
      eq(col, v) { filters.push((r) => r[col] === v); return q; },
      neq(col, v) { filters.push((r) => r[col] !== v); return q; },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return q; },
      not(col, operator, list) {
        if (operator === 'is') { filters.push((r) => r[col] != null); return q; }
        const vs = String(list).replace(/^\(|\)$/g, '').split(',');
        filters.push((r) => !vs.includes(String(r[col])));
        return q;
      },
      order(col, { ascending = true } = {}) { orderBy = { col, asc: ascending }; return q; },
      limit(n) { limitN = n; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return q;
  }

  return { from: builder, db };
}
