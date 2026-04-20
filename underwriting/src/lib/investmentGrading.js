import { runUnderwriting } from './calculations';

// Investment grading based on Grant's criteria:
// - 30-40% down payment target
// - Must be cashflow positive
// - Evaluate at offering price, then find scenarios that work

const GRADE_THRESHOLDS = {
  capRate:      { A: 6.0, B: 5.0, C: 4.0, D: 3.0 },
  cashOnCash:   { A: 8.0, B: 5.0, C: 2.0, D: 0.0 },
  dscr:         { A: 1.4, B: 1.25, C: 1.1, D: 1.0 },
  irr5yr:       { A: 15, B: 12, C: 8, D: 5 },
  leveragePositive: true, // positive leverage = better
};

function gradeMetric(value, thresholds) {
  if (value >= thresholds.A) return { grade: 'A', label: 'Excellent' };
  if (value >= thresholds.B) return { grade: 'B', label: 'Good' };
  if (value >= thresholds.C) return { grade: 'C', label: 'Fair' };
  if (value >= thresholds.D) return { grade: 'D', label: 'Weak' };
  return { grade: 'F', label: 'Poor' };
}

export function gradeInvestment(inputs, results) {
  const grades = {
    capRate: gradeMetric(results.capRate, GRADE_THRESHOLDS.capRate),
    cashOnCash: gradeMetric(results.cashOnCash, GRADE_THRESHOLDS.cashOnCash),
    dscr: gradeMetric(results.dscr, GRADE_THRESHOLDS.dscr),
    irr5yr: gradeMetric(results.irr5yr || 0, GRADE_THRESHOLDS.irr5yr),
    leverage: {
      grade: results.leverageFlag === 'Positive' ? 'A' : 'D',
      label: results.leverageFlag === 'Positive' ? 'Positive' : 'Negative',
    },
    cashflowPositive: {
      grade: results.preTaxCashFlow > 0 ? 'A' : 'F',
      label: results.preTaxCashFlow > 0 ? 'Yes' : 'No',
      value: results.preTaxCashFlow,
    },
  };

  // Overall grade: weighted average
  const gradePoints = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  const weights = {
    capRate: 1.5,
    cashOnCash: 2.0, // cashflow is most important for Grant
    dscr: 1.5,
    irr5yr: 1.0,
    leverage: 0.5,
    cashflowPositive: 2.5, // heaviest weight - must be positive
  };

  let totalPoints = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    totalPoints += gradePoints[grades[key].grade] * weight;
    totalWeight += weight;
  }

  const avgPoints = totalPoints / totalWeight;
  let overallGrade, overallLabel;
  if (avgPoints >= 3.5) { overallGrade = 'A'; overallLabel = 'Strong Buy'; }
  else if (avgPoints >= 2.5) { overallGrade = 'B'; overallLabel = 'Buy'; }
  else if (avgPoints >= 1.5) { overallGrade = 'C'; overallLabel = 'Hold / Negotiate'; }
  else if (avgPoints >= 0.5) { overallGrade = 'D'; overallLabel = 'Weak — Needs Better Terms'; }
  else { overallGrade = 'F'; overallLabel = 'Pass'; }

  return { grades, overallGrade, overallLabel, avgPoints };
}

// Find the breakeven / target scenarios
export function findScenarios(baseInputs) {
  const scenarios = [];

  // Scenario 1: At asking price, what down payment makes it cashflow positive?
  const downPayments = [25, 30, 35, 40, 45, 50];
  const atAskingPrice = downPayments.map(dp => {
    const modified = { ...baseInputs, downPct: dp };
    const results = runUnderwriting(modified);
    return {
      downPct: dp,
      equity: baseInputs.purchasePrice * (dp / 100),
      preTaxCashFlow: results.preTaxCashFlow,
      cashOnCash: results.cashOnCash,
      dscr: results.dscr,
      monthlyDebtService: results.monthlyDebtService,
      cashflowPositive: results.preTaxCashFlow > 0,
    };
  });
  scenarios.push({
    title: 'Down Payment Scenarios at Asking Price',
    subtitle: `Purchase price: $${baseInputs.purchasePrice.toLocaleString()}`,
    type: 'downPayment',
    rows: atAskingPrice,
  });

  // Scenario 2: At 30% down, what purchase price makes it cashflow positive?
  const targetDown = 30;
  const priceDiscounts = [0, -5, -10, -15, -20, -25];
  const atTargetDown = priceDiscounts.map(disc => {
    const price = Math.round(baseInputs.purchasePrice * (1 + disc / 100));
    const modified = { ...baseInputs, purchasePrice: price, downPct: targetDown };
    const results = runUnderwriting(modified);
    return {
      discount: disc,
      price,
      preTaxCashFlow: results.preTaxCashFlow,
      cashOnCash: results.cashOnCash,
      capRate: results.capRate,
      dscr: results.dscr,
      irr5yr: results.irr5yr,
      cashflowPositive: results.preTaxCashFlow > 0,
    };
  });
  scenarios.push({
    title: 'Price Scenarios at 30% Down',
    subtitle: `Finding the price that makes this deal work`,
    type: 'priceAtDown',
    rows: atTargetDown,
  });

  // Scenario 3: Rate sensitivity at asking price, 30% down
  const rates = [5.0, 5.5, 6.0, 6.5, 7.0, 7.5];
  const rateSensitivity = rates.map(r => {
    const modified = { ...baseInputs, rate: r, downPct: targetDown };
    const results = runUnderwriting(modified);
    return {
      rate: r,
      preTaxCashFlow: results.preTaxCashFlow,
      cashOnCash: results.cashOnCash,
      dscr: results.dscr,
      monthlyDebtService: results.monthlyDebtService,
      cashflowPositive: results.preTaxCashFlow > 0,
    };
  });
  scenarios.push({
    title: 'Interest Rate Sensitivity at 30% Down',
    subtitle: `Purchase price: $${baseInputs.purchasePrice.toLocaleString()}`,
    type: 'rateSensitivity',
    rows: rateSensitivity,
  });

  // Find the breakeven: binary search for min down at asking price to be cashflow positive
  let lo = 0, hi = 100, breakevenDown = null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const results = runUnderwriting({ ...baseInputs, downPct: mid });
    if (results.preTaxCashFlow > 0) {
      breakevenDown = mid;
      hi = mid;
    } else {
      lo = mid;
    }
  }

  // Find breakeven price at 30% down
  lo = baseInputs.purchasePrice * 0.5;
  hi = baseInputs.purchasePrice;
  let breakevenPrice = null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const results = runUnderwriting({ ...baseInputs, purchasePrice: mid, downPct: targetDown });
    if (results.preTaxCashFlow > 0) {
      breakevenPrice = mid;
      hi = mid; // can we go higher?
      // Actually we want the max price that's still positive
      lo = mid;
      // Let me redo this logic
    } else {
      hi = mid;
    }
  }
  // Redo: find max price at 30% down where cashflow >= 0
  lo = baseInputs.purchasePrice * 0.5;
  hi = baseInputs.purchasePrice * 1.1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const results = runUnderwriting({ ...baseInputs, purchasePrice: mid, downPct: targetDown });
    if (results.preTaxCashFlow >= 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  breakevenPrice = Math.round(lo);

  return {
    scenarios,
    breakevens: {
      minDownAtAskingPrice: breakevenDown ? Math.ceil(breakevenDown * 10) / 10 : null,
      maxPriceAt30Down: breakevenPrice,
      maxPriceAt30DownDiscount: breakevenPrice
        ? ((1 - breakevenPrice / baseInputs.purchasePrice) * 100).toFixed(1)
        : null,
    },
  };
}
