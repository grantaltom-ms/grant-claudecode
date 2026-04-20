const gradeColors = {
  A: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  B: 'bg-blue-100 text-blue-800 border-blue-300',
  C: 'bg-amber-100 text-amber-800 border-amber-300',
  D: 'bg-orange-100 text-orange-800 border-orange-300',
  F: 'bg-red-100 text-red-800 border-red-300',
};

const largeBadgeColors = {
  A: 'from-emerald-500 to-emerald-700',
  B: 'from-blue-500 to-blue-700',
  C: 'from-amber-500 to-amber-700',
  D: 'from-orange-500 to-orange-700',
  F: 'from-red-500 to-red-700',
};

function fmt$(n) {
  if (!n && n !== 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function GradeBadge({ grade, size = 'sm' }) {
  if (size === 'lg') {
    return (
      <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${largeBadgeColors[grade]} flex items-center justify-center text-white text-2xl font-black shadow-lg`}>
        {grade}
      </div>
    );
  }
  return (
    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg border text-xs font-bold ${gradeColors[grade]}`}>
      {grade}
    </span>
  );
}

export default function InvestmentGrade({ grading, results }) {
  if (!grading) return null;

  const { grades, overallGrade, overallLabel } = grading;

  const metrics = [
    { key: 'cashflowPositive', label: 'Cashflow Positive', value: grades.cashflowPositive.label + (grades.cashflowPositive.value ? ` (${fmt$(grades.cashflowPositive.value)}/yr)` : '') },
    { key: 'cashOnCash', label: 'Cash-on-Cash', value: results.cashOnCash.toFixed(2) + '%' },
    { key: 'capRate', label: 'Cap Rate', value: results.capRate.toFixed(2) + '%' },
    { key: 'dscr', label: 'DSCR', value: results.dscr.toFixed(2) + 'x' },
    { key: 'irr5yr', label: '5yr IRR', value: results.irr5yr ? results.irr5yr.toFixed(2) + '%' : 'N/A' },
    { key: 'leverage', label: 'Leverage', value: grades.leverage.label },
  ];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center gap-4 mb-4">
        <GradeBadge grade={overallGrade} size="lg" />
        <div>
          <h2 className="text-lg font-bold text-slate-900">{overallLabel}</h2>
          <p className="text-xs text-slate-500">
            Investment grade at {results.equity ? fmt$(results.equity) : '—'} equity ({((results.equity / (results.equity + results.loanAmount)) * 100).toFixed(0)}% down)
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {metrics.map(({ key, label, value }) => (
          <div key={key} className="flex items-center gap-2 py-1.5 px-2 rounded-lg bg-slate-50">
            <GradeBadge grade={grades[key].grade} />
            <div>
              <p className="text-[10px] text-slate-500 leading-tight">{label}</p>
              <p className="text-xs font-semibold text-slate-800">{value}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
