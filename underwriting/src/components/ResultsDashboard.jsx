function MetricCard({ label, value, sublabel, color }) {
  const colorClasses = {
    green: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
  };

  return (
    <div className={`rounded-xl border p-3 ${colorClasses[color] || colorClasses.slate}`}>
      <p className="text-xs font-medium opacity-70 mb-1">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {sublabel && <p className="text-xs opacity-60 mt-0.5">{sublabel}</p>}
    </div>
  );
}

function fmt$(n) {
  if (!n && n !== 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtPct(n) {
  if (n === null || n === undefined) return 'N/A';
  return n.toFixed(2) + '%';
}

export default function ResultsDashboard({ results, inputs }) {
  const capColor = results.capRate >= 5 ? 'green' : results.capRate >= 4 ? 'amber' : 'red';
  const cocColor = results.cashOnCash >= 8 ? 'green' : results.cashOnCash >= 4 ? 'amber' : 'red';
  const dscrColor = results.dscr >= 1.25 ? 'green' : results.dscr >= 1.0 ? 'amber' : 'red';
  const leverageColor = results.leverageFlag === 'Positive' ? 'green' : 'red';

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-900">Key Metrics</h2>
        <div className="flex gap-4 text-xs text-slate-500">
          <span>NOI: <strong className="text-slate-900">{fmt$(results.noi)}</strong></span>
          <span>Equity: <strong className="text-slate-900">{fmt$(results.equity)}</strong></span>
          <span>Loan: <strong className="text-slate-900">{fmt$(results.loanAmount)}</strong></span>
          <span>Debt Service: <strong className="text-slate-900">{fmt$(results.monthlyDebtService)}/mo</strong></span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Cap Rate" value={fmtPct(results.capRate)} sublabel={`NOI / Price`} color={capColor} />
        <MetricCard label="Cash-on-Cash" value={fmtPct(results.cashOnCash)} sublabel={`${fmt$(results.preTaxCashFlow)}/yr`} color={cocColor} />
        <MetricCard label="DSCR" value={results.dscr.toFixed(2) + 'x'} sublabel="NOI / Debt Service" color={dscrColor} />
        <MetricCard label="GRM" value={results.grm.toFixed(1) + 'x'} sublabel="Price / Gross Rents" color="slate" />
        <MetricCard label="Leverage" value={results.leverageFlag} sublabel={`Cap ${fmtPct(results.capRate)} vs Debt ${fmtPct(results.costOfDebt)}`} color={leverageColor} />
        <MetricCard label="5-Year IRR" value={results.irr5yr ? fmtPct(results.irr5yr) : 'N/A'} sublabel="w/ sale at exit" color="blue" />
        <MetricCard label="10-Year IRR" value={results.irr10yr ? fmtPct(results.irr10yr) : 'N/A'} sublabel="w/ sale at exit" color="blue" />
        <MetricCard label="Depreciation" value={fmt$(results.annualDepreciation) + '/yr'} sublabel={`${inputs.buildingValuePct}% of ${fmt$(inputs.purchasePrice)}`} color="slate" />
      </div>
    </div>
  );
}
