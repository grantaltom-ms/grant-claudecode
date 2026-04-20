import { useState, useMemo, useCallback } from 'react';
import {
  runUnderwriting, buildSensitivityTable,
  buildProformaTable,
  buildSensitivityCapRateVsExpenseGrowth,
  buildSensitivityRentGrowthVsYear,
  buildSensitivityPriceVsYear,
} from '../lib/calculations';
import { gradeInvestment, findScenarios } from '../lib/investmentGrading';
import { saveDeal, generateDealMemo } from '../lib/supabase';
import { exportDealPDF, exportSummaryPDF } from '../lib/pdfExport';
import ResultsDashboard from './ResultsDashboard';
import SensitivityTable from './SensitivityTable';
import SensitivityTablesAdvanced from './SensitivityTablesAdvanced';
import AnnualProforma from './AnnualProforma';
import ValueAddModule, { DEFAULT_VALUE_ADD } from './ValueAddModule';
import InvestmentGrade from './InvestmentGrade';
import ScenarioAnalysis from './ScenarioAnalysis';
import PDFUpload from './PDFUpload';
import SavedDeals from './SavedDeals';

const DEFAULT_INPUTS = {
  dealName: '',
  address: '',
  market: 'Seattle',
  purchasePrice: 2500000,
  downPct: 25,
  rate: 6.5,
  amortYears: 30,
  grossMonthlyRents: 25000,
  vacancyPct: 5,
  mgmtFeePct: 8,
  annualOpex: 60000,
  buildingValuePct: 80,
  rentGrowthPct: 3,
  expenseGrowthPct: 3,
  totalUnits: 20,
};

function InputField({ label, name, value, onChange, prefix, suffix, step, min, max }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">{prefix}</span>
        )}
        <input
          type="number"
          name={name}
          value={value}
          onChange={onChange}
          step={step || 1}
          min={min}
          max={max}
          className={`w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-8' : ''}`}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">{suffix}</span>
        )}
      </div>
    </div>
  );
}

export default function UnderwritingForm() {
  const [inputs, setInputs] = useState(DEFAULT_INPUTS);
  const [valueAdd, setValueAdd] = useState(DEFAULT_VALUE_ADD);
  const [dealMemo, setDealMemo] = useState('');
  const [memoLoading, setMemoLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('underwrite');
  const [extractedMeta, setExtractedMeta] = useState(null);

  const handleChange = useCallback((e) => {
    const { name, value } = e.target;
    setInputs(prev => ({
      ...prev,
      [name]: name === 'dealName' || name === 'address' || name === 'market'
        ? value
        : parseFloat(value) || 0,
    }));
  }, []);

  const handleValueAddToggle = useCallback(() => {
    setValueAdd(prev => ({ ...prev, enabled: !prev.enabled }));
  }, []);

  const handleValueAddChange = useCallback((key, val) => {
    setValueAdd(prev => ({ ...prev, [key]: val }));
  }, []);

  // Full inputs merged with value-add for all calculations
  const fullInputs = useMemo(() => ({ ...inputs, valueAdd }), [inputs, valueAdd]);

  const results = useMemo(() => runUnderwriting(fullInputs), [fullInputs]);
  const sensitivityData = useMemo(() => buildSensitivityTable(inputs, 'capRate'), [inputs]);
  const grading = useMemo(() => gradeInvestment(inputs, results), [inputs, results]);
  const scenarioData = useMemo(() => findScenarios(inputs), [inputs]);

  // New: proforma table
  const proformaData = useMemo(
    () => buildProformaTable(fullInputs, valueAdd.enabled ? valueAdd : null),
    [fullInputs, valueAdd]
  );

  // New: 3 advanced sensitivity tables
  const table1 = useMemo(() => buildSensitivityCapRateVsExpenseGrowth(inputs), [inputs]);
  const table2 = useMemo(() => buildSensitivityRentGrowthVsYear(inputs), [inputs]);
  const table3 = useMemo(() => buildSensitivityPriceVsYear(inputs), [inputs]);

  const handlePDFExtracted = useCallback((extractedInputs, rawData) => {
    setInputs(extractedInputs);
    setExtractedMeta(rawData);
    setDealMemo('');
  }, []);

  const handleGenerateMemo = async () => {
    setMemoLoading(true);
    try {
      const memo = await generateDealMemo({ inputs, results });
      setDealMemo(memo);
    } catch (err) {
      setDealMemo(`Error generating memo: ${err.message}`);
    } finally {
      setMemoLoading(false);
    }
  };

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      await saveDeal({
        deal_name: inputs.dealName || 'Untitled Deal',
        market: inputs.market,
        address: inputs.address,
        purchase_price: inputs.purchasePrice,
        down_payment_pct: inputs.downPct,
        interest_rate: inputs.rate,
        amortization_years: inputs.amortYears,
        gross_monthly_rents: inputs.grossMonthlyRents,
        vacancy_pct: inputs.vacancyPct,
        mgmt_fee_pct: inputs.mgmtFeePct,
        annual_opex: inputs.annualOpex,
        building_value_pct: inputs.buildingValuePct,
        rent_growth_pct: inputs.rentGrowthPct,
        noi: results.noi,
        cap_rate: results.capRate,
        cash_on_cash: results.cashOnCash,
        dscr: results.dscr,
        grm: results.grm,
        irr_5yr: results.irr5yr,
        irr_10yr: results.irr10yr,
        deal_memo: dealMemo || null,
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`Error: ${err.message}`);
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  const handleExportPDF = () => {
    exportDealPDF(inputs, results, sensitivityData, dealMemo);
  };

  const handleExportSummary = () => {
    exportSummaryPDF(
      inputs, results,
      proformaData.rows,
      valueAdd.enabled ? proformaData : null,
      table1, table2, table3,
      dealMemo
    );
  };

  const handleLoadDeal = (deal) => {
    setInputs({
      dealName: deal.deal_name || '',
      address: deal.address || '',
      market: deal.market || 'Seattle',
      purchasePrice: deal.purchase_price,
      downPct: deal.down_payment_pct,
      rate: deal.interest_rate,
      amortYears: deal.amortization_years,
      grossMonthlyRents: deal.gross_monthly_rents,
      vacancyPct: deal.vacancy_pct,
      mgmtFeePct: deal.mgmt_fee_pct,
      annualOpex: deal.annual_opex,
      buildingValuePct: deal.building_value_pct ?? 80,
      rentGrowthPct: deal.rent_growth_pct ?? 3,
      expenseGrowthPct: deal.expense_growth_pct ?? 3,
      totalUnits: deal.total_units ?? 20,
    });
    if (deal.deal_memo) setDealMemo(deal.deal_memo);
    setExtractedMeta(null);
    setActiveTab('underwrite');
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-slate-900 text-white px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Milestone Properties</h1>
            <p className="text-slate-400 text-sm">Acquisition Underwriting</p>
          </div>
          <nav className="flex gap-1">
            <button
              onClick={() => setActiveTab('underwrite')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'underwrite' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Underwrite
            </button>
            <button
              onClick={() => setActiveTab('saved')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'saved' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Saved Deals
            </button>
          </nav>
        </div>
      </header>

      {activeTab === 'saved' ? (
        <div className="max-w-7xl mx-auto p-6">
          <SavedDeals onLoadDeal={handleLoadDeal} />
        </div>
      ) : (
        <div className="max-w-7xl mx-auto p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: Inputs */}
            <div className="space-y-4">
              {/* PDF Upload */}
              <PDFUpload onExtracted={handlePDFExtracted} />

              {/* Deal Info */}
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">Deal Info</h2>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Deal Name</label>
                    <input
                      type="text"
                      name="dealName"
                      value={inputs.dealName}
                      onChange={handleChange}
                      placeholder="e.g., Capitol Hill 12-Unit"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Address</label>
                    <input
                      type="text"
                      name="address"
                      value={inputs.address}
                      onChange={handleChange}
                      placeholder="123 Main St, Seattle WA"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Market</label>
                    <select
                      name="market"
                      value={inputs.market}
                      onChange={handleChange}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                    >
                      <option>Seattle</option>
                      <option>San Francisco</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Acquisition */}
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">Acquisition</h2>
                <div className="space-y-3">
                  <InputField label="Purchase Price" name="purchasePrice" value={inputs.purchasePrice} onChange={handleChange} prefix="$" step={10000} />
                  <InputField label="Down Payment" name="downPct" value={inputs.downPct} onChange={handleChange} suffix="%" step={1} min={0} max={100} />
                  <InputField label="Interest Rate" name="rate" value={inputs.rate} onChange={handleChange} suffix="%" step={0.125} min={0} />
                  <InputField label="Amortization" name="amortYears" value={inputs.amortYears} onChange={handleChange} suffix="yr" step={1} min={1} />
                </div>
              </div>

              {/* Income */}
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">Income</h2>
                <div className="space-y-3">
                  <InputField label="Gross Monthly Rents" name="grossMonthlyRents" value={inputs.grossMonthlyRents} onChange={handleChange} prefix="$" step={500} />
                  <InputField label="Vacancy" name="vacancyPct" value={inputs.vacancyPct} onChange={handleChange} suffix="%" step={0.5} min={0} max={100} />
                  <InputField label="Management Fee" name="mgmtFeePct" value={inputs.mgmtFeePct} onChange={handleChange} suffix="%" step={0.5} min={0} />
                  <InputField label="Total Units" name="totalUnits" value={inputs.totalUnits} onChange={handleChange} step={1} min={1} />
                </div>
              </div>

              {/* Expenses & Growth */}
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <h2 className="text-sm font-semibold text-slate-900 mb-3">Expenses & Growth</h2>
                <div className="space-y-3">
                  <InputField label="Annual Operating Expenses" name="annualOpex" value={inputs.annualOpex} onChange={handleChange} prefix="$" step={1000} />
                  <InputField label="Building Value % (Depreciation)" name="buildingValuePct" value={inputs.buildingValuePct} onChange={handleChange} suffix="%" step={5} min={0} max={100} />
                  <InputField label="Annual Rent Growth" name="rentGrowthPct" value={inputs.rentGrowthPct} onChange={handleChange} suffix="%" step={0.5} />
                  <InputField label="Annual Expense Growth" name="expenseGrowthPct" value={inputs.expenseGrowthPct} onChange={handleChange} suffix="%" step={0.5} min={0} />
                </div>
              </div>

              {/* Value-Add Module */}
              <ValueAddModule
                valueAdd={valueAdd}
                onToggle={handleValueAddToggle}
                onFieldChange={handleValueAddChange}
                inputs={inputs}
              />
            </div>

            {/* Right: Results */}
            <div className="lg:col-span-2 space-y-4">
              {/* Investment Grade */}
              <InvestmentGrade grading={grading} results={results} />

              <ResultsDashboard results={results} inputs={inputs} />

              {/* Broker vs Our Numbers */}
              {extractedMeta && (extractedMeta.t12NOI || extractedMeta.brokerProjectedIRR) && (
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <h2 className="text-sm font-semibold text-slate-900 mb-3">Broker Numbers vs Our Underwriting</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    {extractedMeta.t12NOI && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-500">T-12 Actual NOI</p>
                        <p className="font-bold text-slate-800">${extractedMeta.t12NOI.toLocaleString()}</p>
                      </div>
                    )}
                    {extractedMeta.proFormaNOI && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-500">Broker Pro Forma NOI</p>
                        <p className="font-bold text-slate-800">${extractedMeta.proFormaNOI.toLocaleString()}</p>
                        <p className={`text-[10px] ${results.noi < extractedMeta.proFormaNOI ? 'text-amber-600' : 'text-emerald-600'}`}>
                          Our NOI: ${Math.round(results.noi).toLocaleString()}
                        </p>
                      </div>
                    )}
                    {extractedMeta.proFormaCapRate && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-500">Broker Cap Rate</p>
                        <p className="font-bold text-slate-800">{extractedMeta.proFormaCapRate}%</p>
                        <p className={`text-[10px] ${results.capRate < extractedMeta.proFormaCapRate ? 'text-amber-600' : 'text-emerald-600'}`}>
                          Our Cap: {results.capRate.toFixed(2)}%
                        </p>
                      </div>
                    )}
                    {extractedMeta.brokerProjectedIRR && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-500">Broker 5yr IRR</p>
                        <p className="font-bold text-slate-800">{extractedMeta.brokerProjectedIRR}%</p>
                        <p className={`text-[10px] ${(results.irr5yr || 0) < extractedMeta.brokerProjectedIRR ? 'text-amber-600' : 'text-emerald-600'}`}>
                          Our IRR: {results.irr5yr ? results.irr5yr.toFixed(2) + '%' : 'N/A'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Scenario Analysis */}
              <ScenarioAnalysis scenarioData={scenarioData} />

              {/* 5-Year Annual Proforma */}
              <AnnualProforma rows={proformaData.rows} hasValueAdd={valueAdd.enabled} />

              {/* Legacy sensitivity table (price × vacancy) */}
              <SensitivityTable data={sensitivityData} basePrice={inputs.purchasePrice} />

              {/* Advanced Sensitivity Tables */}
              <SensitivityTablesAdvanced
                table1={table1}
                table2={table2}
                table3={table3}
                baseCapRate={results.capRate}
                baseRentGrowth={inputs.rentGrowthPct}
                basePrice={inputs.purchasePrice}
              />

              {/* Deal Memo */}
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-900">AI Deal Memo</h2>
                  <button
                    onClick={handleGenerateMemo}
                    disabled={memoLoading}
                    className="px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 transition"
                  >
                    {memoLoading ? 'Generating...' : 'Generate with Claude'}
                  </button>
                </div>
                {dealMemo ? (
                  <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{dealMemo}</p>
                ) : (
                  <p className="text-sm text-slate-400 italic">Click "Generate with Claude" to create a plain-English investment summary.</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-3 flex-wrap">
                <button
                  onClick={handleExportPDF}
                  className="flex-1 min-w-[140px] px-4 py-2.5 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-600 transition"
                >
                  Export PDF
                </button>
                <button
                  onClick={handleExportSummary}
                  className="flex-1 min-w-[140px] px-4 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 transition"
                >
                  Export Summary
                </button>
                <button
                  onClick={handleSave}
                  disabled={saveStatus === 'saving'}
                  className="flex-1 min-w-[140px] px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
                >
                  {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save to Database'}
                </button>
              </div>
              {saveStatus && saveStatus.startsWith('Error') && (
                <p className="text-xs text-red-500">{saveStatus}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
