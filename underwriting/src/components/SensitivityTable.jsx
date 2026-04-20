function fmt$(n) {
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n / 1000) + 'K';
}

function fmtPct(n) {
  return n.toFixed(2) + '%';
}

function cellColor(val) {
  if (val >= 6) return 'bg-emerald-100 text-emerald-800 font-semibold';
  if (val >= 5) return 'bg-emerald-50 text-emerald-700';
  if (val >= 4) return 'bg-amber-50 text-amber-700';
  if (val >= 3) return 'bg-orange-50 text-orange-700';
  return 'bg-red-50 text-red-700';
}

export default function SensitivityTable({ data, basePrice }) {
  const vacRates = [3, 5, 7, 10, 12, 15];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900 mb-3">
        Cap Rate Sensitivity
        <span className="text-xs font-normal text-slate-400 ml-2">Purchase Price x Vacancy Rate</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="px-3 py-2 text-left font-medium rounded-tl-lg">Price</th>
              {vacRates.map(v => (
                <th key={v} className={`px-3 py-2 text-center font-medium ${v === vacRates[vacRates.length - 1] ? 'rounded-tr-lg' : ''}`}>
                  {v}% Vacancy
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const isBase = row.priceOffset === 0;
              return (
                <tr key={row.priceOffset} className={isBase ? 'ring-2 ring-blue-400 ring-inset' : ''}>
                  <td className={`px-3 py-2 text-left font-medium text-slate-700 ${isBase ? 'bg-blue-50' : 'bg-slate-50'}`}>
                    {fmt$(row.price)}
                    {row.priceOffset !== 0 && (
                      <span className={`ml-1 text-[10px] ${row.priceOffset < 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {row.priceOffset > 0 ? '+' : ''}{row.priceOffset}%
                      </span>
                    )}
                    {isBase && <span className="ml-1 text-[10px] text-blue-600">base</span>}
                  </td>
                  {vacRates.map(v => (
                    <td key={v} className={`px-3 py-2 text-center ${cellColor(row[`vac_${v}`])}`}>
                      {fmtPct(row[`vac_${v}`])}
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
