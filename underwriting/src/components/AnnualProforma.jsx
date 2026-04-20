function fmt$(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return n.toFixed(1) + '%';
}

function fmtParens(n, isNeg = false) {
  if (!n || n === 0) return '—';
  const abs = fmt$(Math.abs(n));
  return isNeg ? `(${abs})` : abs;
}

const ROW_DEFS = [
  { key: 'gpr',             label: 'Gross Potential Rent',  indent: 0, bold: false, color: null },
  { key: 'vacancyLoss',     label: 'Vacancy Loss',          indent: 1, bold: false, color: 'neg', parens: true },
  { key: 'egi',             label: 'Eff. Gross Income',     indent: 0, bold: true,  color: null, separator: true },
  { key: 'lostRent',        label: 'Lost Rent (Renovation)',indent: 1, bold: false, color: 'neg', parens: true, vaOnly: true },
  { key: 'rentPremium',     label: 'Rent Premium (VA)',     indent: 1, bold: false, color: 'pos', vaOnly: true },
  { key: 'totalRevenue',    label: 'Total Revenue',         indent: 0, bold: true,  color: null, separator: true },
  { key: 'opex',            label: 'Operating Expenses',    indent: 1, bold: false, color: 'neg', parens: true },
  { key: 'mgmtFee',         label: 'Management Fee',        indent: 1, bold: false, color: 'neg', parens: true },
  { key: 'noi',             label: 'NOI',                   indent: 0, bold: true,  color: 'highlight', separator: true },
  { key: 'annualDebtService',label: 'Debt Service',         indent: 1, bold: false, color: 'neg', parens: true },
  { key: 'capex',           label: 'CapEx (Renovation)',    indent: 1, bold: false, color: 'neg', parens: true, vaOnly: true },
  { key: 'netCashFlow',     label: 'Net Cash Flow',         indent: 0, bold: true,  color: 'cf', separator: true },
  { key: 'coc',             label: 'Cash-on-Cash Return',   indent: 0, bold: true,  color: 'coc', isPct: true },
];

function cellValue(row, def) {
  const val = row[def.key];
  if (def.isPct) return fmtPct(val);
  if (def.parens) return fmtParens(val, true);
  return fmt$(val);
}

function cellClass(row, def) {
  const val = row[def.key];
  if (def.key === 'coc') {
    if (val >= 8) return 'text-emerald-700 font-bold';
    if (val >= 5) return 'text-amber-700 font-bold';
    return 'text-red-700 font-bold';
  }
  if (def.color === 'neg') return 'text-slate-500';
  if (def.color === 'pos') return 'text-emerald-600';
  if (def.color === 'highlight') return 'text-blue-700 font-bold';
  if (def.color === 'cf') return val >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold';
  return def.bold ? 'text-slate-900 font-semibold' : 'text-slate-700';
}

export default function AnnualProforma({ rows, hasValueAdd }) {
  if (!rows || rows.length === 0) return null;

  const visibleDefs = ROW_DEFS.filter(d => !d.vaOnly || hasValueAdd);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900 mb-1">
        5-Year Annual Proforma
        <span className="text-xs font-normal text-slate-400 ml-2">Pre-tax cash flow by year</span>
      </h2>

      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="bg-slate-800 text-white">
              <th className="px-3 py-2 text-left font-medium rounded-tl-lg w-40">Line Item</th>
              {rows.map(row => (
                <th
                  key={row.year}
                  className={`px-3 py-2 text-right font-medium ${
                    row.year === 1 ? 'bg-blue-700' : ''
                  } ${row.year === rows.length ? 'rounded-tr-lg' : ''}`}
                >
                  Year {row.year}
                  {row.year === 1 && <span className="block text-[9px] font-normal opacity-75">Current</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleDefs.map((def) => (
              <tr
                key={def.key}
                className={`${def.separator ? 'border-t border-slate-200' : ''} ${
                  def.bold ? 'bg-slate-50' : 'bg-white'
                }`}
              >
                <td className={`px-3 py-1.5 text-slate-600 ${def.bold ? 'font-semibold text-slate-800' : ''}`}>
                  <span style={{ paddingLeft: `${def.indent * 12}px` }}>{def.label}</span>
                </td>
                {rows.map(row => (
                  <td
                    key={row.year}
                    className={`px-3 py-1.5 text-right ${
                      row.year === 1 ? 'bg-blue-50' : ''
                    } ${cellClass(row, def)}`}
                  >
                    {cellValue(row, def)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
