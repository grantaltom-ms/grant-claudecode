function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return n.toFixed(1) + '%';
}

function fmt$(n) {
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n / 1000) + 'K';
}

// CoC thresholds: <5% red, 5-8% yellow, >8% green
function cocColor(val) {
  if (val >= 8) return 'bg-emerald-100 text-emerald-800';
  if (val >= 5) return 'bg-amber-50 text-amber-800';
  return 'bg-red-50 text-red-700';
}

// ─── TABLE 1: Cap Rate vs Expense Growth → Year-1 CoC ─────────────────────────
function Table1({ data, baseCapRate }) {
  if (!data || data.length === 0) return null;
  const expGrowths = [1, 2, 3, 4, 5];

  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-700 mb-1">
        Table 1 — Entry Cap Rate × Expense Growth → Year-1 CoC
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[400px]">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="px-3 py-2 text-left font-medium rounded-tl-lg">Cap Rate</th>
              {expGrowths.map((eg, i) => (
                <th key={eg} className={`px-3 py-2 text-center font-medium ${i === expGrowths.length - 1 ? 'rounded-tr-lg' : ''}`}>
                  {eg}% OpEx Grw
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => {
              const isBase = Math.abs(row.capRate - baseCapRate) < 0.01;
              return (
                <tr key={ri} className={isBase ? 'ring-2 ring-inset ring-blue-400' : ''}>
                  <td className={`px-3 py-1.5 font-medium text-slate-700 ${isBase ? 'bg-blue-50' : 'bg-slate-50'}`}>
                    {row.capRate.toFixed(2)}%
                    {isBase && <span className="ml-1 text-[10px] text-blue-600">base</span>}
                    <div className="text-[10px] text-slate-400 font-normal">{fmt$(row.impliedPrice)}</div>
                  </td>
                  {expGrowths.map(eg => (
                    <td key={eg} className={`px-3 py-1.5 text-center ${cocColor(row[`eg_${eg}`])}`}>
                      {fmtPct(row[`eg_${eg}`])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── TABLE 2: Rent Growth × Year → CoC ────────────────────────────────────────
function Table2({ data, baseRentGrowth }) {
  if (!data || data.length === 0) return null;
  const years = [1, 2, 3, 4, 5];

  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-700 mb-1">
        Table 2 — Rent Growth × Year → CoC
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[400px]">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="px-3 py-2 text-left font-medium rounded-tl-lg">Rent Growth</th>
              {years.map((yr, i) => (
                <th key={yr} className={`px-3 py-2 text-center font-medium ${i === years.length - 1 ? 'rounded-tr-lg' : ''}`}>
                  Year {yr}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => {
              const isBase = row.rentGrowth === baseRentGrowth;
              return (
                <tr key={ri} className={isBase ? 'ring-2 ring-inset ring-blue-400' : ''}>
                  <td className={`px-3 py-1.5 font-medium text-slate-700 ${isBase ? 'bg-blue-50' : 'bg-slate-50'}`}>
                    {row.rentGrowth}% / yr
                    {isBase && <span className="ml-1 text-[10px] text-blue-600">base</span>}
                  </td>
                  {years.map(yr => (
                    <td key={yr} className={`px-3 py-1.5 text-center ${cocColor(row[`yr_${yr}`])}`}>
                      {fmtPct(row[`yr_${yr}`])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── TABLE 3: Purchase Price × Year → CoC ─────────────────────────────────────
function Table3({ data, basePrice }) {
  if (!data || data.length === 0) return null;
  const years = [1, 2, 3, 4, 5];

  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-700 mb-1">
        Table 3 — Purchase Price × Year → CoC
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[400px]">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="px-3 py-2 text-left font-medium rounded-tl-lg">Price</th>
              {years.map((yr, i) => (
                <th key={yr} className={`px-3 py-2 text-center font-medium ${i === years.length - 1 ? 'rounded-tr-lg' : ''}`}>
                  Year {yr}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => {
              const isBase = row.priceOffset === 0;
              return (
                <tr key={ri} className={isBase ? 'ring-2 ring-inset ring-blue-400' : ''}>
                  <td className={`px-3 py-1.5 font-medium text-slate-700 ${isBase ? 'bg-blue-50' : 'bg-slate-50'}`}>
                    {fmt$(row.price)}
                    {row.priceOffset !== 0 && (
                      <span className={`ml-1 text-[10px] ${row.priceOffset < 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {row.priceOffset > 0 ? '+' : ''}{row.priceOffset}%
                      </span>
                    )}
                    {isBase && <span className="ml-1 text-[10px] text-blue-600">base</span>}
                  </td>
                  {years.map(yr => (
                    <td key={yr} className={`px-3 py-1.5 text-center ${cocColor(row[`yr_${yr}`])}`}>
                      {fmtPct(row[`yr_${yr}`])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-slate-500">
      <span className="font-medium">CoC Legend:</span>
      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-100"></span>&lt;5% Weak</span>
      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-100"></span>5–8% OK</span>
      <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-emerald-100"></span>&gt;8% Strong</span>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────
export default function SensitivityTablesAdvanced({ table1, table2, table3, baseCapRate, baseRentGrowth, basePrice }) {
  if (!table1 && !table2 && !table3) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Advanced Sensitivity Analysis</h2>
        <Legend />
      </div>

      {table1 && <Table1 data={table1} baseCapRate={baseCapRate} />}
      {table2 && <Table2 data={table2} baseRentGrowth={baseRentGrowth} />}
      {table3 && <Table3 data={table3} basePrice={basePrice} />}
    </div>
  );
}
