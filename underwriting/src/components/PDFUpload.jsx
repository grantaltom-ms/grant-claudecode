import { useState, useRef } from 'react';
import { extractTextFromPDF } from '../lib/pdfExtract';
import { supabase } from '../lib/supabase';

export default function PDFUpload({ onExtracted }) {
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState(null); // null | 'reading' | 'extracting' | 'done' | 'error'
  const [error, setError] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const fileInputRef = useRef(null);

  const processFile = async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setError('Please upload a PDF file');
      setStatus('error');
      return;
    }

    setError(null);
    setStatus('reading');

    try {
      // Step 1: Extract text client-side
      const pdfText = await extractTextFromPDF(file);

      if (pdfText.length < 100) {
        setError('Could not extract enough text from this PDF. It may be image-only.');
        setStatus('error');
        return;
      }

      setStatus('extracting');

      // Step 2: Send to Claude for structured extraction
      const { data, error: fnError } = await supabase.functions.invoke('extract-deal-pdf', {
        body: { pdfText },
      });

      if (fnError) throw fnError;
      if (data.error) throw new Error(data.error);

      const extracted = data.extracted;
      setExtractedData(extracted);
      setStatus('done');

      // Map to underwriting inputs
      const inputs = {
        dealName: extracted.dealName || file.name.replace('.pdf', ''),
        address: extracted.address || '',
        market: extracted.market || 'Seattle',
        purchasePrice: extracted.purchasePrice || 0,
        downPct: 30, // Start with Grant's preferred 30%
        rate: 6.5,
        amortYears: 30,
        grossMonthlyRents: extracted.grossMonthlyRents || 0,
        vacancyPct: extracted.vacancyPct ?? 5,
        mgmtFeePct: extracted.mgmtFeePct ?? 8,
        annualOpex: extracted.annualOpex || 0,
        buildingValuePct: 80,
        rentGrowthPct: extracted.rentGrowthPct ?? 3,
      };

      onExtracted(inputs, extracted);
    } catch (err) {
      setError(err.message || 'Failed to process PDF');
      setStatus('error');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    processFile(file);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
  };

  return (
    <div className="space-y-3">
      {/* Drop Zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
          dragOver
            ? 'border-blue-400 bg-blue-50'
            : status === 'done'
            ? 'border-emerald-300 bg-emerald-50'
            : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-white'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          onChange={handleFileSelect}
          className="hidden"
        />

        {status === 'reading' && (
          <div className="space-y-2">
            <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto" />
            <p className="text-sm text-blue-600 font-medium">Reading PDF...</p>
          </div>
        )}

        {status === 'extracting' && (
          <div className="space-y-2">
            <div className="animate-pulse w-8 h-8 bg-violet-500 rounded-full mx-auto" />
            <p className="text-sm text-violet-600 font-medium">Claude is extracting deal data...</p>
          </div>
        )}

        {status === 'done' && extractedData && (
          <div className="space-y-1">
            <p className="text-sm font-semibold text-emerald-700">
              {extractedData.dealName || 'Deal'} extracted
            </p>
            <p className="text-xs text-emerald-600">
              {extractedData.units} units | ${(extractedData.purchasePrice || 0).toLocaleString()} | {extractedData.address}
            </p>
            <p className="text-[10px] text-slate-400 mt-2">Drop another PDF to replace</p>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-1">
            <p className="text-sm text-red-600 font-medium">Error</p>
            <p className="text-xs text-red-500">{error}</p>
            <p className="text-[10px] text-slate-400 mt-2">Try again</p>
          </div>
        )}

        {!status && (
          <div className="space-y-2">
            <div className="w-10 h-10 bg-slate-200 rounded-xl mx-auto flex items-center justify-center">
              <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">Upload Broker PDF</p>
              <p className="text-xs text-slate-400">Drop an offering memorandum to auto-extract deal data</p>
            </div>
          </div>
        )}
      </div>

      {/* Extracted highlights */}
      {status === 'done' && extractedData && (
        <div className="space-y-2">
          {extractedData.keyHighlights?.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-blue-800 mb-1">Key Highlights</p>
              <ul className="space-y-0.5">
                {extractedData.keyHighlights.map((h, i) => (
                  <li key={i} className="text-xs text-blue-700">+ {h}</li>
                ))}
              </ul>
            </div>
          )}
          {extractedData.riskFactors?.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-amber-800 mb-1">Risk Factors</p>
              <ul className="space-y-0.5">
                {extractedData.riskFactors.map((r, i) => (
                  <li key={i} className="text-xs text-amber-700">- {r}</li>
                ))}
              </ul>
            </div>
          )}
          {extractedData.unitMix?.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
              <p className="text-xs font-semibold text-slate-800 mb-1">Unit Mix</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left font-medium">Type</th>
                    <th className="text-center font-medium">Units</th>
                    <th className="text-center font-medium">Avg SF</th>
                    <th className="text-right font-medium">Current</th>
                    <th className="text-right font-medium">Pro Forma</th>
                  </tr>
                </thead>
                <tbody>
                  {extractedData.unitMix.map((u, i) => (
                    <tr key={i} className="text-slate-700">
                      <td className="text-left">{u.type}</td>
                      <td className="text-center">{u.units}</td>
                      <td className="text-center">{u.avgSF}</td>
                      <td className="text-right">${u.currentRent?.toLocaleString()}</td>
                      <td className="text-right">${u.proFormaRent?.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
