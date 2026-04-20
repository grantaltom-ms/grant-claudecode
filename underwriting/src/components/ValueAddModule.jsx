import { buildValueAddSchedule } from '../lib/calculations';

export const DEFAULT_VALUE_ADD = {
  enabled: false,
  totalUnitsToRenovate: 10,
  unitsPerYear: 5,
  costPerUnit: 15000,
  rentPremium: 150,
  monthsVacant: 1,
};

function fmt$(n) {
  if (!n && n !== 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function VAInput({ label, value, onChange, prefix, suffix, step, min }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">{prefix}</span>
        )}
        <input
          type="number"
          value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          step={step || 1}
          min={min ?? 0}
          className={`w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-8' : ''}`}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">{suffix}</span>
        )}
      </div>
    </div>
  );
}

export default function ValueAddModule({ valueAdd, onToggle, onFieldChange, inputs }) {
  const schedule = valueAdd.enabled
    ? buildValueAddSchedule(valueAdd, inputs)
    : null;

  // Only show years with renovation activity + 1 year after (up to 5)
  const visibleSchedule = schedule
    ? schedule.filter((row, i) => i < 5)
    : [];

  const totalCapex = visibleSchedule.reduce((s, r) => s + r.capex, 0);
  const totalPremium = visibleSchedule[visibleSchedule.length - 1]?.rentPremium || 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      {/* Header / Toggle */}
      <div className="flex items-center justify-between mb-1">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Value-Add Assumptions</h2>
          {valueAdd.enabled && (
            <p className="text-xs text-slate-400 mt-0.5">Renovation capex flows below NOI line</p>
          )}
        </div>
        <button
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            valueAdd.enabled ? 'bg-blue-600' : 'bg-slate-200'
          }`}
          aria-label="Toggle value-add module"
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              valueAdd.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {!valueAdd.enabled && (
        <p className="text-xs text-slate-400 mt-2">Enable to model unit renovations and rent premium upside.</p>
      )}

      {valueAdd.enabled && (
        <div className="mt-4 space-y-4">
          {/* Inputs grid */}
          <div className="grid grid-cols-2 gap-3">
            <VAInput
              label="Total Units to Renovate"
              value={valueAdd.totalUnitsToRenovate}
              onChange={v => onFieldChange('totalUnitsToRenovate', v)}
              step={1} min={1}
            />
            <VAInput
              label="Units Renovated / Year"
              value={valueAdd.unitsPerYear}
              onChange={v => onFieldChange('unitsPerYear', v)}
              step={1} min={1}
            />
            <VAInput
              label="Cost per Unit"
              value={valueAdd.costPerUnit}
              onChange={v => onFieldChange('costPerUnit', v)}
              prefix="$" step={1000}
            />
            <VAInput
              label="Monthly Rent Premium"
              value={valueAdd.rentPremium}
              onChange={v => onFieldChange('rentPremium', v)}
              prefix="$" step={25}
            />
            <VAInput
              label="Months Vacant per Reno"
              value={valueAdd.monthsVacant}
              onChange={v => onFieldChange('monthsVacant', v)}
              step={0.5} min={0}
            />
            {/* Summary pill */}
            <div className="flex flex-col justify-end">
              <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs">
                <p className="text-slate-500">Total CapEx</p>
                <p className="font-bold text-blue-700">{fmt$(totalCapex)}</p>
                <p className="text-slate-500 mt-0.5">Yr-5 Annual Premium</p>
                <p className="font-bold text-emerald-600">{fmt$(totalPremium)}/yr</p>
              </div>
            </div>
          </div>

          {/* Year-by-year schedule */}
          <div>
            <h3 className="text-xs font-semibold text-slate-600 mb-2">Renovation Schedule (Years 1–5)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800 text-white">
                    <th className="px-2 py-2 text-left font-medium rounded-tl-lg">Year</th>
                    <th className="px-2 py-2 text-right font-medium">Units Reno'd</th>
                    <th className="px-2 py-2 text-right font-medium">Cumulative</th>
                    <th className="px-2 py-2 text-right font-medium">CapEx Out</th>
                    <th className="px-2 py-2 text-right font-medium">Lost Rent</th>
                    <th className="px-2 py-2 text-right font-medium rounded-tr-lg">Annual Premium</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSchedule.map((row) => (
                    <tr key={row.year} className={row.year % 2 === 0 ? 'bg-slate-50' : 'bg-white'}>
                      <td className="px-2 py-1.5 font-medium text-slate-700">Yr {row.year}</td>
                      <td className="px-2 py-1.5 text-right text-slate-600">{row.unitsThisYear}</td>
                      <td className="px-2 py-1.5 text-right text-slate-600">{row.cumulativeRenovated}</td>
                      <td className={`px-2 py-1.5 text-right font-medium ${row.capex > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                        {row.capex > 0 ? `(${fmt$(row.capex)})` : '—'}
                      </td>
                      <td className={`px-2 py-1.5 text-right ${row.lostRent > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                        {row.lostRent > 0 ? `(${fmt$(row.lostRent)})` : '—'}
                      </td>
                      <td className={`px-2 py-1.5 text-right font-medium ${row.rentPremium > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {row.rentPremium > 0 ? `+${fmt$(row.rentPremium)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
