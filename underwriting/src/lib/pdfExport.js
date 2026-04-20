import jsPDF from 'jspdf';

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt$(n) {
  if (!n && n !== 0) return '$0';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtPct(n) {
  if (n === null || n === undefined) return 'N/A';
  return n.toFixed(2) + '%';
}

function fmtPct1(n) {
  if (n === null || n === undefined) return '—';
  return n.toFixed(1) + '%';
}

// ─── Color helpers ────────────────────────────────────────────────────────────
function capRateColor(val) {
  if (val >= 6) return [22, 163, 74];
  if (val >= 4.5) return [202, 138, 4];
  return [220, 38, 38];
}

function cocColor(val) {
  if (val >= 8) return [22, 163, 74];
  if (val >= 5) return [202, 138, 4];
  return [220, 38, 38];
}

// ─── Shared header ────────────────────────────────────────────────────────────
function drawHeader(doc, inputs) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 70, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('MILESTONE PROPERTIES', margin, 35);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text('Acquisition Underwriting Summary', margin, 52);
}

function drawFooter(doc) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text('Milestone Properties | Confidential | For internal use only', margin, pageHeight - 20);
  doc.text(new Date().toLocaleDateString(), pageWidth - margin - 60, pageHeight - 20);
}

// ─── ORIGINAL exportDealPDF (unchanged interface) ─────────────────────────────
export function exportDealPDF(inputs, results, sensitivityData, dealMemo) {
  const doc = new jsPDF('p', 'pt', 'letter');
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  drawHeader(doc, inputs);
  y = 90;
  doc.setTextColor(0, 0, 0);

  // Deal Info
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(inputs.dealName || 'Untitled Deal', margin, y);
  y += 16;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  if (inputs.address) {
    doc.text(`${inputs.address} | ${inputs.market || ''}`, margin, y);
    y += 12;
  }
  doc.text(`Generated ${new Date().toLocaleDateString()}`, margin, y);
  y += 24;

  // Key Metrics
  doc.setFillColor(241, 245, 249);
  doc.rect(margin, y, pageWidth - margin * 2, 110, 'F');
  y += 16;

  const col1 = margin + 12;
  const col2 = pageWidth / 2 + 12;
  const lineHeight = 15;

  const metrics = [
    ['Purchase Price', fmt$(inputs.purchasePrice), 'Cap Rate', fmtPct(results.capRate)],
    ['Down Payment', `${inputs.downPct}% (${fmt$(results.equity)})`, 'Cash-on-Cash', fmtPct(results.cashOnCash)],
    ['Loan Amount', fmt$(results.loanAmount), 'DSCR', results.dscr.toFixed(2) + 'x'],
    ['Interest Rate', `${inputs.rate}% / ${inputs.amortYears}yr`, 'GRM', results.grm.toFixed(1) + 'x'],
    ['NOI', fmt$(results.noi), 'Leverage', results.leverageFlag],
    ['Debt Service', fmt$(results.annualDebtService) + '/yr', '5yr IRR', results.irr5yr ? fmtPct(results.irr5yr) : 'N/A'],
    ['Pre-Tax Cash Flow', fmt$(results.preTaxCashFlow), '10yr IRR', results.irr10yr ? fmtPct(results.irr10yr) : 'N/A'],
  ];

  doc.setFontSize(8);
  metrics.forEach(([l1, v1, l2, v2]) => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(l1, col1, y);
    doc.text(l2, col2, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(v1, col1 + 110, y);
    doc.text(v2, col2 + 100, y);
    y += lineHeight;
  });

  y += 16;

  // Sensitivity Table (cap rate × vacancy)
  if (sensitivityData && sensitivityData.length > 0) {
    const vacRates = [3, 5, 7, 10, 12, 15];
    y = drawCapRateVacancyTable(doc, sensitivityData, vacRates, margin, y, pageWidth);
    y += 12;
  }

  // Deal Memo
  if (dealMemo) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Investment Summary', margin, y);
    y += 14;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(dealMemo, pageWidth - margin * 2);
    lines.forEach(line => {
      if (y > 740) { doc.addPage(); y = margin; drawFooter(doc); }
      doc.text(line, margin, y);
      y += 11;
    });
  }

  drawFooter(doc);
  doc.save(`${(inputs.dealName || 'deal').replace(/\s+/g, '_')}_underwriting.pdf`);
}

// ─── EXPORT SUMMARY PDF (new — full package) ──────────────────────────────────
export function exportSummaryPDF(inputs, results, proformaRows, valueAddData, table1, table2, table3, dealMemo) {
  const doc = new jsPDF('p', 'pt', 'letter');
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  drawHeader(doc, inputs);
  y = 90;
  doc.setTextColor(0, 0, 0);

  // ── Deal Header ──
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(inputs.dealName || 'Untitled Deal', margin, y);
  y += 16;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  if (inputs.address) { doc.text(`${inputs.address} | ${inputs.market || ''}`, margin, y); y += 12; }
  doc.text(`Generated ${new Date().toLocaleDateString()} | Hold: 5yr / 10yr`, margin, y);
  y += 20;

  // ── Assumptions box ──
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Assumptions', margin, y);
  y += 12;

  doc.setFillColor(248, 250, 252);
  doc.rect(margin, y - 6, pageWidth - margin * 2, 52, 'F');

  const aCol1 = margin + 8;
  const aCol2 = margin + 130;
  const aCol3 = margin + 270;
  const aCol4 = margin + 400;
  doc.setFontSize(7.5);
  const aRows = [
    [['Purchase Price', fmt$(inputs.purchasePrice)], ['Down Payment', `${inputs.downPct}%`], ['Interest Rate', `${inputs.rate}%`], ['Amortization', `${inputs.amortYears}yr`]],
    [['Gross Mo. Rents', fmt$(inputs.grossMonthlyRents)], ['Vacancy', `${inputs.vacancyPct}%`], ['Mgmt Fee', `${inputs.mgmtFeePct}%`], ['Annual OpEx', fmt$(inputs.annualOpex)]],
    [['Rent Growth', `${inputs.rentGrowthPct}%/yr`], ['Expense Growth', `${inputs.expenseGrowthPct ?? 3}%/yr`], ['Total Units', String(inputs.totalUnits ?? '—')], ['Building Val %', `${inputs.buildingValuePct ?? 80}%`]],
  ];
  aRows.forEach(cols => {
    const positions = [aCol1, aCol2, aCol3, aCol4];
    cols.forEach(([label, val], i) => {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 116, 139);
      doc.text(label, positions[i], y);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text(val, positions[i], y + 9);
    });
    y += 18;
  });

  y += 10;

  // ── Year-1 Snapshot ──
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Year-1 Snapshot', margin, y);
  y += 12;

  doc.setFillColor(219, 234, 254); // blue-100
  doc.rect(margin, y - 6, pageWidth - margin * 2, 28, 'F');

  const snapItems = [
    ['NOI', fmt$(results.noi)],
    ['Cap Rate', fmtPct(results.capRate)],
    ['CoC', fmtPct(results.cashOnCash)],
    ['DSCR', results.dscr.toFixed(2) + 'x'],
    ['5yr IRR', results.irr5yr ? fmtPct(results.irr5yr) : 'N/A'],
    ['10yr IRR', results.irr10yr ? fmtPct(results.irr10yr) : 'N/A'],
  ];
  const snapColW = (pageWidth - margin * 2) / snapItems.length;
  snapItems.forEach(([label, val], i) => {
    const x = margin + snapColW * i + 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(label, x, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    doc.text(val, x, y + 12);
  });
  y += 32;

  // ── 5-Year Proforma Table ──
  if (proformaRows && proformaRows.length > 0) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('5-Year Annual Proforma', margin, y);
    y += 12;

    y = drawProformaTable(doc, proformaRows, margin, y, pageWidth, !!valueAddData);
    y += 12;
  }

  // ── Value-Add Summary ──
  if (valueAddData && proformaRows) {
    const yr1 = proformaRows[0];
    const yr5 = proformaRows[proformaRows.length - 1];
    const totalCapex = proformaRows.reduce((s, r) => s + (r.capex || 0), 0);
    const yr5Premium = yr5?.rentPremium || 0;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Value-Add Summary', margin, y);
    y += 12;

    doc.setFillColor(240, 253, 244); // emerald-50
    doc.rect(margin, y - 6, pageWidth - margin * 2, 24, 'F');
    const vaItems = [
      ['Total CapEx', fmt$(totalCapex)],
      ['Yr-5 Annual Premium', fmt$(yr5Premium)],
      ['Yr-1 Net CF', fmt$(yr1?.netCashFlow)],
      ['Yr-5 Net CF', fmt$(yr5?.netCashFlow)],
      ['Yr-1 CoC', fmtPct1(yr1?.coc)],
      ['Yr-5 CoC', fmtPct1(yr5?.coc)],
    ];
    const vaColW = (pageWidth - margin * 2) / vaItems.length;
    vaItems.forEach(([label, val], i) => {
      const x = margin + vaColW * i + 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(label, x, y);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      doc.text(val, x, y + 11);
    });
    y += 28;
  }

  // ── Sensitivity Tables ──
  if (table1 && table1.length > 0) {
    if (y > 580) { doc.addPage(); drawFooter(doc); y = margin; }
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Table 1 — Entry Cap Rate × Expense Growth → Year-1 CoC', margin, y);
    y += 12;
    y = drawCoCHeatmap(doc, table1, margin, y, pageWidth, 'capRate', [1, 2, 3, 4, 5], 'eg_', 'eg', '%/yr OpEx');
    y += 10;
  }

  if (table2 && table2.length > 0) {
    if (y > 580) { doc.addPage(); drawFooter(doc); y = margin; }
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Table 2 — Rent Growth × Year → CoC', margin, y);
    y += 12;
    y = drawCoCHeatmap(doc, table2, margin, y, pageWidth, 'rentGrowth', [1, 2, 3, 4, 5], 'yr_', 'Year');
    y += 10;
  }

  if (table3 && table3.length > 0) {
    if (y > 580) { doc.addPage(); drawFooter(doc); y = margin; }
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Table 3 — Purchase Price × Year → CoC', margin, y);
    y += 12;
    y = drawCoCHeatmap(doc, table3, margin, y, pageWidth, 'price', [1, 2, 3, 4, 5], 'yr_', 'Year');
    y += 10;
  }

  // ── Deal Memo ──
  if (dealMemo) {
    if (y > 640) { doc.addPage(); drawFooter(doc); y = margin; }
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('Investment Summary (AI-Generated)', margin, y);
    y += 14;

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(dealMemo, pageWidth - margin * 2);
    lines.forEach(line => {
      if (y > 740) { doc.addPage(); drawFooter(doc); y = margin; }
      doc.text(line, margin, y);
      y += 11;
    });
  }

  drawFooter(doc);
  doc.save(`${(inputs.dealName || 'deal').replace(/\s+/g, '_')}_summary.pdf`);
}

// ─── INTERNAL DRAWING HELPERS ─────────────────────────────────────────────────

function drawCapRateVacancyTable(doc, sensitivityData, vacRates, margin, y, pageWidth) {
  const colW = (pageWidth - margin * 2) / (vacRates.length + 1);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Cap Rate Sensitivity (Price x Vacancy)', margin, y);
  y += 14;

  // Header row
  doc.setFillColor(30, 41, 59);
  doc.rect(margin, y - 8, pageWidth - margin * 2, 14, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(7);
  doc.text('Price', margin + 4, y);
  vacRates.forEach((v, i) => { doc.text(`${v}% Vac`, margin + colW * (i + 1) + 4, y); });
  y += 12;

  doc.setTextColor(15, 23, 42);
  sensitivityData.forEach((row, ri) => {
    if (ri % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(margin, y - 8, pageWidth - margin * 2, 12, 'F');
    }
    const highlight = row.priceOffset === 0;
    if (highlight) {
      doc.setFillColor(219, 234, 254);
      doc.rect(margin, y - 8, pageWidth - margin * 2, 12, 'F');
    }
    doc.setFont('helvetica', highlight ? 'bold' : 'normal');
    doc.setFontSize(7);
    doc.text(fmt$(row.price), margin + 4, y);
    vacRates.forEach((v, i) => {
      const val = row[`vac_${v}`];
      doc.setTextColor(...capRateColor(val));
      doc.text(fmtPct(val), margin + colW * (i + 1) + 4, y);
    });
    doc.setTextColor(15, 23, 42);
    y += 12;
  });

  return y;
}

function drawProformaTable(doc, rows, margin, y, pageWidth, hasValueAdd) {
  const rowDefs = [
    { key: 'gpr', label: 'Gross Potential Rent' },
    { key: 'vacancyLoss', label: 'Vacancy Loss', parens: true },
    { key: 'egi', label: 'Eff. Gross Income', bold: true },
    ...(hasValueAdd ? [
      { key: 'lostRent', label: 'Lost Rent (Reno)', parens: true },
      { key: 'rentPremium', label: 'Rent Premium (VA)' },
    ] : []),
    { key: 'totalRevenue', label: 'Total Revenue', bold: true },
    { key: 'opex', label: 'OpEx', parens: true },
    { key: 'mgmtFee', label: 'Mgmt Fee', parens: true },
    { key: 'noi', label: 'NOI', bold: true, highlight: true },
    { key: 'annualDebtService', label: 'Debt Service', parens: true },
    ...(hasValueAdd ? [{ key: 'capex', label: 'CapEx', parens: true }] : []),
    { key: 'netCashFlow', label: 'Net Cash Flow', bold: true },
    { key: 'coc', label: 'CoC Return', isPct: true, bold: true },
  ];

  const labelW = 130;
  const dataColW = (pageWidth - margin * 2 - labelW) / rows.length;
  const rowH = 11;

  // Header
  doc.setFillColor(30, 41, 59);
  doc.rect(margin, y - 7, pageWidth - margin * 2, 13, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(7);
  doc.text('Line Item', margin + 3, y);
  rows.forEach((row, i) => {
    const x = margin + labelW + dataColW * i + 3;
    doc.text(`Year ${row.year}`, x, y);
  });
  y += rowH;

  rowDefs.forEach((def, di) => {
    if (di % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(margin, y - 7, pageWidth - margin * 2, rowH, 'F');
    }
    if (def.bold) {
      doc.setFillColor(241, 245, 249);
      doc.rect(margin, y - 7, pageWidth - margin * 2, rowH, 'F');
    }

    doc.setFont('helvetica', def.bold ? 'bold' : 'normal');
    doc.setFontSize(7);
    doc.setTextColor(def.bold ? 15 : 71, def.bold ? 23 : 85, def.bold ? 42 : 105);
    doc.text(def.label, margin + 3, y);

    rows.forEach((row, i) => {
      const x = margin + labelW + dataColW * i + 3;
      const val = row[def.key];

      if (def.isPct) {
        doc.setTextColor(...cocColor(val));
        doc.setFont('helvetica', 'bold');
        doc.text(fmtPct1(val), x, y);
      } else {
        const display = def.parens && val ? `(${fmt$(Math.abs(val))})` : (val ? fmt$(val) : '—');
        if (def.highlight) {
          doc.setTextColor(29, 78, 216);
        } else if (def.key === 'netCashFlow') {
          doc.setTextColor(...(val >= 0 ? [22, 163, 74] : [220, 38, 38]));
        } else {
          doc.setTextColor(15, 23, 42);
        }
        doc.text(display, x, y);
      }
    });

    y += rowH;
  });

  return y;
}

function drawCoCHeatmap(doc, tableData, margin, y, pageWidth, rowKey, colNums, prefix, colLabel) {
  const labelW = 80;
  const dataColW = (pageWidth - margin * 2 - labelW) / colNums.length;
  const rowH = 12;

  // Header
  doc.setFillColor(30, 41, 59);
  doc.rect(margin, y - 7, pageWidth - margin * 2, 13, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(7);
  doc.text(rowKey === 'capRate' ? 'Cap Rate' : rowKey === 'rentGrowth' ? 'Rent Grw' : 'Price', margin + 3, y);
  colNums.forEach((n, i) => {
    doc.text(`${colLabel} ${n}`, margin + labelW + dataColW * i + 3, y);
  });
  y += rowH;

  tableData.forEach((row, ri) => {
    if (ri % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(margin, y - 7, pageWidth - margin * 2, rowH, 'F');
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(15, 23, 42);

    let rowLabel;
    if (rowKey === 'capRate') rowLabel = row.capRate.toFixed(2) + '%';
    else if (rowKey === 'rentGrowth') rowLabel = row.rentGrowth + '%/yr';
    else rowLabel = fmt$(row.price) + (row.priceOffset !== 0 ? ` (${row.priceOffset > 0 ? '+' : ''}${row.priceOffset}%)` : ' base');

    doc.text(rowLabel, margin + 3, y);

    colNums.forEach((n, i) => {
      const val = row[`${prefix}${n}`];
      doc.setTextColor(...cocColor(val));
      doc.setFont('helvetica', 'bold');
      doc.text(fmtPct1(val), margin + labelW + dataColW * i + 3, y);
    });

    y += rowH;
  });

  return y;
}
