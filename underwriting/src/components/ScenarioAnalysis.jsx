function fmt$(n) {
  if (!n && n !== 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function CashflowCell({ positive, value }) {
  return (
    <td className={`px-2 py-1.5 text-center text-xs font-medium ${positive ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50'}`}>
      {fmt$(value)}
    </td>
  );
}

function DownPaymentTable({ rows }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="bg-slate-800 text-white">
          <th className="px-2 py-1.5 text-left font-medium rounded-tl-lg">Down %</th>
          <th className="px-2 py-1.5 text-right font-medium">Equity</th>
          <th className="px-2 py-1.5 text-right font-medium">Debt Service/mo</th>
          <th className="px-2 py-1.5 text-center font-medium">Annual Cash Flow</th>
          <th className="px-2 py-1.5 text-center font-medium">Cash-on-Cash</th>
          <th className="px-2 py-1.5 text-center font-medium rounded-tr-lg">DSCR</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.downPct} className={row.cashflowPositive ? '' : 'opacity-75'}>
            <td className="px-2 py-1.5 text-left font-medium text-slate-700">{row.downPct}%</td>
            <td className="px-2 py-1.5 text-right text-slate-600">{fmt$(row.equity)}</td>
            <td className="px-2 py-1.5 text-right text-slate-600">{fmt$(row.monthlyDebtService)}</td>
            <CashflowCell positive={row.cashflowPositive} value={row.preTaxCashFlow} />
            <td className={`px-2 py-1.5 text-center ${row.cashOnCash >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {row.cashOnCash.toFixed(2)}%
            </td>
            <td className={`px-2 py-1.5 text-center ${row.dscr >= 1.25 ? 'text-emerald-700' : row.dscr >= 1.0 ? 'text-amber-700' : 'text-red-700'}`}>
              {row.dscr.toFixed(2)}x
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PriceTable({ rows }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="bg-slate-800 text-white">
          <th className="px-2 py-1.5 text-left font-medium rounded-tl-lg">Price</th>
          <th className="px-2 py-1.5 text-center font-medium">Discount</th>
          <th className="px-2 py-1.5 text-center font-medium">Cap Rate</th>
          <th className="px-2 py-1.5 text-center font-medium">Annual Cash Flow</th>
          <th className="px-2 py-1.5 text-center font-medium">Cash-on-Cash</th>
          <th className="px-2 py-1.5 text-center font-medium">DSCR</th>
          <th className="px-2 py-1.5 text-center font-medium rounded-tr-lg">5yr IRR</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.discount} className={row.cashflowPositive ? '' : 'opacity-75'}>
            <td className="px-2 py-1.5 text-left font-medium text-slate-700">{fmt$(row.price)}</td>
            <td className="px-2 py-1.5 text-center text-slate-500">
              {row.discount === 0 ? 'Asking' : `${row.discount}%`}
            </td>
            <td className="px-2 py-1.5 text-center text-slate-600">{row.capRate.toFixed(2)}%</td>
            <CashflowCell positive={row.cashflowPositive} value={row.preTaxCashFlow} />
            <td className={`px-2 py-1.5 text-center ${row.cashOnCash >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {row.cashOnCash.toFixed(2)}%
            </td>
            <td className={`px-2 py-1.5 text-center ${row.dscr >= 1.25 ? 'text-emerald-700' : row.dscr >= 1.0 ? 'text-amber-700' : 'text-red-700'}`}>
              {row.dscr.toFixed(2)}x
            </td>
            <td className="px-2 py-1.5 text-center text-slate-600">
              {row.irr5yr ? row.irr5yr.toFixed(1) + '%' : 'N/A'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RateTable({ rows }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="bg-slate-800 text-white">
          <th className="px-2 py-1.5 text-left font-medium rounded-tl-lg">Rate</th>
          <th className="px-2 py-1.5 text-right font-medium">Debt Service/mo</th>
          <th className="px-2 py-1.5 text-center font-medium">Annual Cash Flow</th>
          <th className="px-2 py-1.5 text-center font-medium">Cash-on-Cash</th>
          <th className="px-2 py-1.5 text-center font-medium rounded-tr-lg">DSCR</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.rate} className={row.cashflowPositive ? '' : 'opacity-75'}>
            <td className="px-2 py-1.5 text-left font-medium text-slate-700">{row.rate}%</td>
            <td className="px-2 py-1.5 text-right text-slate-600">{fmt$(row.monthlyDebtService)}</td>
            <CashflowCell positive={row.cashflowPositive} value={row.preTaxCashFlow} />
            <td className={`px-2 py-1.5 text-center ${row.cashOnCash >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {row.cashOnCash.toFixed(2)}%
            </td>
            <td className={`px-2 py-1.5 text-center ${row.dscr >= 1.25 ? 'text-emerald-700' : row.dscr >= 1.0 ? 'text-amber-700' : 'text-red-700'}`}>
              {row.dscr.toFixed(2)}x
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ScenarioAnalysis({ scenarioData }) {
  if (!scenarioData) return null;

  const { scenarios, breakevens } = scenarioData;

  return (
    <div className="space-y-4">
      {/* Breakeven Summary */}
      <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-xl p-4 text-white">
        <h2 className="text-sm font-semibold mb-3">Breakeven Analysis</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-white/10 rounded-lg p-3">
            <p className="text-xs text-slate-300">Min down payment at asking price for positive cashflow</p>
            <p className="text-xl font-bold mt-1">
              {breakevens.minDownAtAskingPrice
                ? `${breakevens.minDownAtAskingPrice.toFixed(1)}%`
                : 'Not achievable'}
            </p>
          </div>
          <div className="bg-white/10 rounded-lg p-3">
            <p className="text-xs text-slate-300">Max price at 30% down for positive cashflow</p>
            <p className="text-xl font-bold mt-1">
              {breakevens.maxPriceAt30Down
                ? `${fmt$(breakevens.maxPriceAt30Down)} (−${breakevens.maxPriceAt30DownDiscount}%)`
                : 'Not achievable'}
            </p>
          </div>
        </div>
      </div>

      {/* Scenario Tables */}
      {scenarios.map((scenario, i) => (
        <div key={i} className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-900">{scenario.title}</h3>
          <p className="text-xs text-slate-400 mb-3">{scenario.subtitle}</p>
          <div className="overflow-x-auto">
            {scenario.type === 'downPayment' && <DownPaymentTable rows={scenario.rows} />}
            {scenario.type === 'priceAtDown' && <PriceTable rows={scenario.rows} />}
            {scenario.type === 'rateSensitivity' && <RateTable rows={scenario.rows} />}
          </div>
        </div>
      ))}
    </div>
  );
}
