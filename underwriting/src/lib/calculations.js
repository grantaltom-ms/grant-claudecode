// Pure financial calculation functions for multifamily underwriting
// All existing public functions preserved; new functions added below.

export function calcNOI(grossAnnualRents, vacancyPct, mgmtFeePct, annualOpex) {
  const effectiveGross = grossAnnualRents * (1 - vacancyPct / 100);
  const mgmtFee = effectiveGross * (mgmtFeePct / 100);
  return effectiveGross - mgmtFee - annualOpex;
}

export function calcCapRate(noi, purchasePrice) {
  if (!purchasePrice) return 0;
  return (noi / purchasePrice) * 100;
}

export function calcDebtService(loanAmount, annualRate, amortYears) {
  if (!loanAmount || !annualRate || !amortYears) return 0;
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = amortYears * 12;
  const monthlyPayment =
    loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
    (Math.pow(1 + monthlyRate, numPayments) - 1);
  return monthlyPayment * 12;
}

export function calcCashOnCash(noi, annualDebtService, equity) {
  if (!equity) return 0;
  const preTaxCashFlow = noi - annualDebtService;
  return (preTaxCashFlow / equity) * 100;
}

export function calcDSCR(noi, annualDebtService) {
  if (!annualDebtService) return 0;
  return noi / annualDebtService;
}

export function calcGRM(purchasePrice, grossAnnualRents) {
  if (!grossAnnualRents) return 0;
  return purchasePrice / grossAnnualRents;
}

export function calcCostOfDebt(annualDebtService, loanAmount) {
  if (!loanAmount) return 0;
  return (annualDebtService / loanAmount) * 100;
}

export function calcLeverageFlag(capRate, costOfDebt) {
  return capRate > costOfDebt ? 'Positive' : 'Negative';
}

// IRR via Newton-Raphson method
export function calcIRR(cashFlows, guess = 0.1, maxIter = 1000, tol = 1e-7) {
  let rate = guess;
  for (let i = 0; i < maxIter; i++) {
    let npv = 0;
    let dnpv = 0;
    for (let t = 0; t < cashFlows.length; t++) {
      const factor = Math.pow(1 + rate, t);
      npv += cashFlows[t] / factor;
      if (t > 0) dnpv -= t * cashFlows[t] / Math.pow(1 + rate, t + 1);
    }
    if (Math.abs(npv) < tol) return rate * 100;
    if (Math.abs(dnpv) < tol) return null;
    rate = rate - npv / dnpv;
    if (rate < -1) return null;
  }
  return null;
}

// Calculate remaining loan balance after N years
function calcLoanBalance(loanAmount, annualRate, amortYears, yearsElapsed) {
  const monthlyRate = annualRate / 100 / 12;
  const totalPayments = amortYears * 12;
  const paymentsMade = yearsElapsed * 12;
  const monthlyPayment =
    loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, totalPayments)) /
    (Math.pow(1 + monthlyRate, totalPayments) - 1);
  const balance =
    loanAmount * Math.pow(1 + monthlyRate, paymentsMade) -
    monthlyPayment * ((Math.pow(1 + monthlyRate, paymentsMade) - 1) / monthlyRate);
  return Math.max(0, balance);
}

// ─── VALUE-ADD SCHEDULE ────────────────────────────────────────────────────────
// Returns year-by-year renovation schedule for up to 10 years.
// Premium for renovated units starts the year AFTER they are completed.
export function buildValueAddSchedule(valueAdd, inputs) {
  const { totalUnitsToRenovate, unitsPerYear, costPerUnit, rentPremium, monthsVacant } = valueAdd;
  const { grossMonthlyRents, totalUnits = 1 } = inputs;
  const avgRentPerUnit = totalUnits > 0 ? grossMonthlyRents / totalUnits : 0;

  const schedule = [];
  let cumulativeRenovated = 0;

  for (let year = 1; year <= 10; year++) {
    const prevCumulative = cumulativeRenovated;

    let unitsThisYear = 0;
    if (cumulativeRenovated < totalUnitsToRenovate) {
      unitsThisYear = Math.min(unitsPerYear, totalUnitsToRenovate - cumulativeRenovated);
    }
    cumulativeRenovated += unitsThisYear;

    const capex = unitsThisYear * costPerUnit;
    // Lost rent during renovation turn (reduces revenue in renovation year)
    const lostRent = unitsThisYear * avgRentPerUnit * monthsVacant;
    // Premium starts the year AFTER renovation completes
    const annualRentPremium = prevCumulative * rentPremium * 12;

    schedule.push({
      year,
      unitsThisYear,
      cumulativeRenovated,
      capex,
      lostRent,
      rentPremium: annualRentPremium,
    });
  }

  return schedule;
}

// ─── UPDATED buildProforma (now supports expenseGrowthPct + value-add) ────────
export function buildProforma(inputs) {
  const {
    purchasePrice, downPct, rate, amortYears,
    grossMonthlyRents, vacancyPct, mgmtFeePct, annualOpex,
    rentGrowthPct, holdYears, buildingValuePct,
    expenseGrowthPct = 0,
    valueAdd = null,
    totalUnits = 1,
  } = inputs;

  const equity = purchasePrice * (downPct / 100);
  const loanAmount = purchasePrice - equity;
  const annualDebtService = calcDebtService(loanAmount, rate, amortYears);

  // Exit cap rate: going-in cap rate + 50bps
  const year1NOI = calcNOI(grossMonthlyRents * 12, vacancyPct, mgmtFeePct, annualOpex);
  const exitCapRate = calcCapRate(year1NOI, purchasePrice) + 0.5;

  const vaSchedule = (valueAdd?.enabled && totalUnits > 0)
    ? buildValueAddSchedule(valueAdd, inputs)
    : null;

  const cashFlows = [-equity];
  let currentRents = grossMonthlyRents * 12;

  for (let year = 1; year <= holdYears; year++) {
    if (year > 1) currentRents *= (1 + rentGrowthPct / 100);

    const opexThisYear = annualOpex * Math.pow(1 + expenseGrowthPct / 100, year - 1);

    let lostRent = 0, rentPremium = 0, capex = 0;
    if (vaSchedule && vaSchedule[year - 1]) {
      lostRent = vaSchedule[year - 1].lostRent;
      rentPremium = vaSchedule[year - 1].rentPremium;
      capex = vaSchedule[year - 1].capex;
    }

    const egi = currentRents * (1 - vacancyPct / 100) - lostRent;
    const totalRevenue = egi + rentPremium;
    const mgmtFee = totalRevenue * (mgmtFeePct / 100);
    const noi = totalRevenue - mgmtFee - opexThisYear;

    let cf = noi - annualDebtService - capex;

    if (year === holdYears) {
      const exitNOI = noi * (1 + rentGrowthPct / 100);
      const salePrice = exitCapRate > 0 ? exitNOI / (exitCapRate / 100) : 0;
      const remainingBalance = calcLoanBalance(loanAmount, rate, amortYears, year);
      const netProceeds = salePrice - remainingBalance - salePrice * 0.02;
      cf += netProceeds;
    }

    cashFlows.push(cf);
  }

  return { cashFlows, irr: calcIRR(cashFlows) };
}

// ─── 5-YEAR ANNUAL PROFORMA TABLE ─────────────────────────────────────────────
// Returns row-by-row P&L for display in AnnualProforma component.
export function buildProformaTable(inputs, valueAdd = null) {
  const {
    purchasePrice, downPct, rate, amortYears,
    grossMonthlyRents, vacancyPct, mgmtFeePct, annualOpex,
    rentGrowthPct, expenseGrowthPct = 3, totalUnits = 1,
  } = inputs;

  const equity = purchasePrice * (downPct / 100);
  const loanAmount = purchasePrice - equity;
  const annualDebtService = calcDebtService(loanAmount, rate, amortYears);

  const vaSchedule = (valueAdd?.enabled && totalUnits > 0)
    ? buildValueAddSchedule(valueAdd, inputs)
    : null;

  const rows = [];

  for (let year = 1; year <= 5; year++) {
    const gpr = grossMonthlyRents * 12 * Math.pow(1 + rentGrowthPct / 100, year - 1);
    const vacancyLoss = gpr * (vacancyPct / 100);
    const egi = gpr - vacancyLoss;

    let lostRent = 0, rentPremium = 0, capex = 0;
    if (vaSchedule && vaSchedule[year - 1]) {
      lostRent = vaSchedule[year - 1].lostRent;
      rentPremium = vaSchedule[year - 1].rentPremium;
      capex = vaSchedule[year - 1].capex;
    }

    const totalRevenue = egi - lostRent + rentPremium;
    const opex = annualOpex * Math.pow(1 + expenseGrowthPct / 100, year - 1);
    const mgmtFee = totalRevenue * (mgmtFeePct / 100);
    const noi = totalRevenue - mgmtFee - opex;
    const netCashFlow = noi - annualDebtService - capex;
    const coc = equity > 0 ? (netCashFlow / equity) * 100 : 0;

    rows.push({
      year, gpr, vacancyLoss, egi,
      lostRent, rentPremium, totalRevenue,
      opex, mgmtFee, noi,
      annualDebtService, capex, netCashFlow, coc,
    });
  }

  return { rows, equity, annualDebtService };
}

// ─── MAIN runUnderwriting (unchanged interface, new optional inputs) ───────────
export function runUnderwriting(inputs) {
  const {
    purchasePrice, downPct, rate, amortYears,
    grossMonthlyRents, vacancyPct, mgmtFeePct, annualOpex,
    rentGrowthPct, buildingValuePct,
    expenseGrowthPct = 0,
    valueAdd = null,
    totalUnits = 1,
  } = inputs;

  const grossAnnualRents = grossMonthlyRents * 12;
  const equity = purchasePrice * (downPct / 100);
  const loanAmount = purchasePrice - equity;
  const noi = calcNOI(grossAnnualRents, vacancyPct, mgmtFeePct, annualOpex);
  const capRate = calcCapRate(noi, purchasePrice);
  const annualDebtService = calcDebtService(loanAmount, rate, amortYears);
  const cashOnCash = calcCashOnCash(noi, annualDebtService, equity);
  const dscr = calcDSCR(noi, annualDebtService);
  const grm = calcGRM(purchasePrice, grossAnnualRents);
  const costOfDebt = calcCostOfDebt(annualDebtService, loanAmount);
  const leverageFlag = calcLeverageFlag(capRate, costOfDebt);

  const proforma5 = buildProforma({ ...inputs, holdYears: 5 });
  const proforma10 = buildProforma({ ...inputs, holdYears: 10 });

  const buildingValue = purchasePrice * ((buildingValuePct || 80) / 100);
  const annualDepreciation = buildingValue / 27.5;

  return {
    grossAnnualRents, equity, loanAmount, noi, capRate,
    annualDebtService, monthlyDebtService: annualDebtService / 12,
    cashOnCash, preTaxCashFlow: noi - annualDebtService,
    dscr, grm, costOfDebt, leverageFlag,
    irr5yr: proforma5.irr, irr10yr: proforma10.irr,
    annualDepreciation, buildingValue,
  };
}

// ─── LEGACY sensitivity table (price × vacancy → cap rate) ───────────────────
export function buildSensitivityTable(inputs, metric = 'capRate') {
  const priceOffsets = [-15, -10, -5, 0, 5, 10, 15];
  const vacancyRates = [3, 5, 7, 10, 12, 15];

  return priceOffsets.map(offset => {
    const price = inputs.purchasePrice * (1 + offset / 100);
    const row = { priceOffset: offset, price };
    vacancyRates.forEach(vac => {
      const modified = { ...inputs, purchasePrice: price, vacancyPct: vac };
      const results = runUnderwriting(modified);
      row[`vac_${vac}`] = metric === 'capRate' ? results.capRate
        : metric === 'cashOnCash' ? results.cashOnCash
        : results.dscr;
    });
    return row;
  });
}

// ─── NEW SENSITIVITY TABLE 1: Cap Rate vs Expense Growth → Year-1 CoC ─────────
// Rows: entry cap rate ± 100bps in 50bp steps (5 rows)
// Columns: expense growth 1–5%
// Cell: Year-1 CoC at implied purchase price (NOI / cap_rate) × expense scale
export function buildSensitivityCapRateVsExpenseGrowth(inputs) {
  const year1NOI = calcNOI(inputs.grossMonthlyRents * 12, inputs.vacancyPct, inputs.mgmtFeePct, inputs.annualOpex);
  const baseCapRate = calcCapRate(year1NOI, inputs.purchasePrice);
  const capRates = [baseCapRate - 1, baseCapRate - 0.5, baseCapRate, baseCapRate + 0.5, baseCapRate + 1];
  const expGrowths = [1, 2, 3, 4, 5];

  return capRates.map(cr => {
    const impliedPrice = cr > 0 ? year1NOI / (cr / 100) : inputs.purchasePrice;
    const equity = impliedPrice * (inputs.downPct / 100);
    const loanAmount = impliedPrice - equity;
    const debtService = calcDebtService(loanAmount, inputs.rate, inputs.amortYears);
    const row = { capRate: cr, impliedPrice };

    expGrowths.forEach(eg => {
      // Apply expense growth as a year-1 scaling factor (shows immediate cost pressure sensitivity)
      const scaledOpex = inputs.annualOpex * (1 + eg / 100);
      const egi = inputs.grossMonthlyRents * 12 * (1 - inputs.vacancyPct / 100);
      const noi = egi * (1 - inputs.mgmtFeePct / 100) - scaledOpex;
      const coc = equity > 0 ? ((noi - debtService) / equity) * 100 : 0;
      row[`eg_${eg}`] = coc;
    });
    return row;
  });
}

// ─── NEW SENSITIVITY TABLE 2: Rent Growth × Year → CoC ───────────────────────
// Rows: rent growth 0–4% (5 rows)
// Columns: Year 1–5
// Cell: CoC in that year under that rent growth
export function buildSensitivityRentGrowthVsYear(inputs) {
  const rentGrowths = [0, 1, 2, 3, 4];
  const years = [1, 2, 3, 4, 5];
  const equity = inputs.purchasePrice * (inputs.downPct / 100);
  const loanAmount = inputs.purchasePrice - equity;
  const debtService = calcDebtService(loanAmount, inputs.rate, inputs.amortYears);
  const expGrowth = inputs.expenseGrowthPct ?? 3;

  return rentGrowths.map(rg => {
    const row = { rentGrowth: rg };
    years.forEach(yr => {
      const gpr = inputs.grossMonthlyRents * 12 * Math.pow(1 + rg / 100, yr - 1);
      const egi = gpr * (1 - inputs.vacancyPct / 100);
      const opex = inputs.annualOpex * Math.pow(1 + expGrowth / 100, yr - 1);
      const noi = egi * (1 - inputs.mgmtFeePct / 100) - opex;
      row[`yr_${yr}`] = equity > 0 ? ((noi - debtService) / equity) * 100 : 0;
    });
    return row;
  });
}

// ─── NEW SENSITIVITY TABLE 3: Purchase Price × Year → CoC ────────────────────
// Rows: price ±10% in 5% steps (5 rows)
// Columns: Year 1–5
// Cell: CoC in that year at that price
export function buildSensitivityPriceVsYear(inputs) {
  const priceOffsets = [-10, -5, 0, 5, 10];
  const years = [1, 2, 3, 4, 5];
  const expGrowth = inputs.expenseGrowthPct ?? 3;

  return priceOffsets.map(offset => {
    const price = inputs.purchasePrice * (1 + offset / 100);
    const equity = price * (inputs.downPct / 100);
    const loanAmount = price - equity;
    const debtService = calcDebtService(loanAmount, inputs.rate, inputs.amortYears);
    const row = { priceOffset: offset, price };

    years.forEach(yr => {
      const gpr = inputs.grossMonthlyRents * 12 * Math.pow(1 + inputs.rentGrowthPct / 100, yr - 1);
      const egi = gpr * (1 - inputs.vacancyPct / 100);
      const opex = inputs.annualOpex * Math.pow(1 + expGrowth / 100, yr - 1);
      const noi = egi * (1 - inputs.mgmtFeePct / 100) - opex;
      row[`yr_${yr}`] = equity > 0 ? ((noi - debtService) / equity) * 100 : 0;
    });
    return row;
  });
}
