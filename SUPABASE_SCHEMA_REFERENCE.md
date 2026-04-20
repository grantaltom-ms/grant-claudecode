# Milestone Properties — Supabase Database Reference

This document describes the database schema, table relationships, GL account structure, and example queries for the Milestone Properties financial database hosted in Supabase (project: `augbrysfqwgekfhfokco`).

Use the `exec_sql` RPC function to run read-only SQL queries: `client.rpc('exec_sql', {'query': '...'})`. Only SELECT and WITH queries are allowed. Queries must not have leading whitespace.

---

## Data Coverage

| Data Type | Date Range | Properties |
|---|---|---|
| GL Transactions | 2007-06-19 to 2026-03-05 | 42 properties (most have 2024-01-01 to 2026-02-28) |
| Income Statements | 2023 to 2025 (annual) | 46 properties |
| Balance Sheets | As of 2026-03-09 | 50 properties |

---

## Properties

There are 51 properties. Always join on `properties.id` (bigint) to get the property name. Use case-insensitive matching (`LOWER(p.name)`) when matching user input to property names.

**Property list:** 1255 Kearny St, 1413 East John, 1415 East John, 1620 32nd Ave, 1803 F Street, 2318 Fairview Ave, 9275 Renton, Ansonia, Ascona, Astro Plaza, Beachcomber Apartments, Bel Vista, Bon Vista, Brandon Court, Bridgewood, Buccaneer, California Court Apartments, Castle, CC Dolores, CC Edmunds, CC Hudson, Century Manor Apartments, Colony Surf, Crosby, DD Culp, Delmont Apartments, Envoy, Galer Crest, Heather, Iron Ridge Apartments, Isherwood, Kenton, Kerry Park, Legacy Place, Olympic View Apartments, Park Place, Pennington, Pine Creek Apartments, Prospect Manor, Raleigh House, Redmond View, Roni Lee, Stonehaven Apartments, The Frances, Top of Fifth, Townvue, Twin Apartments, University View, UW Pacific, Willow Lake Apartments, Woodland

**Important:** The property name in the database is the short name (e.g., "Castle", "Envoy", "Prospect Manor"). Users may say "Castle Apartments" or "the Envoy" — match flexibly using LIKE or ILIKE when needed.

### Properties Table

```
properties
  id                  bigint (PK)
  name                text (unique short name)
  address             text
  city                text
  state               text
  zip                 text
  property_type       text
  total_units         integer
  owner_entity        text
  manager             text
  status              text
```

---

## GL Accounts (Chart of Accounts)

GL accounts follow AppFolio's numbering convention. The `account_number` is the primary lookup key. Account ranges define categories:

### Account Number Ranges

| Range | Type | Category |
|---|---|---|
| 00000000-x | Various | AppFolio system accounts (prepaid income, owner contributions, security clearing, etc.) |
| 1000-1099 | Asset | Cash & Bank Accounts (Operating, Savings, MM, CD, SD) |
| 1100-1260 | Asset | Receivables & Undeposited Funds |
| 1300-1400 | Asset | Other Assets (Closing Costs, Loan Fees, Escrow) |
| 1500-1570 | Asset | Fixed Assets (Land, Building, Improvements, Equipment, WIP) |
| 1600-1610 | Asset | Equipment & Construction in Progress |
| 1700-1702 | Asset | Accumulated Depreciation & Amortization |
| 2000-2200 | Liability | Payables, Security Deposits, Mortgages |
| 3000-3142 | Equity | Net Income, Retained Earnings, Owner Equity & Distributions |
| 4003-4999 | Income | Rental Income, Fees, Other Property Income, Utility Income, Bad Debts |
| 5000-5900 | Expense | Operating Expenses (see detailed breakdown below) |
| 6000-6300 | Expense | Other/Non-Operating Expenses (Construction, Depreciation, Mortgage Interest) |
| 8000-8100 | Income | Other Income (Interest Income, Proceeds from Sale) |
| 8998-9999 | Expense | Special items (743b Depreciation, Charitable, Uncategorized) |

### Expense Account Detail (5000-5900 series)

**Management & Payroll (5000-5098):**
- 5000: Management Fees
- 5001: Asset Management Fee
- 5091: Wages - Management
- 5092: Wages - Maintenance
- 5093: Wages - Leasing
- 5094: Payroll Taxes
- 5095: Bonus
- 5096: Unit Turn Labor
- 5097: Benefits

**Repairs & Maintenance (5100-5134):**
- 5102-5134: Individual R&M line items (Windows, Flooring, Cleaning, Plumbing, Electrical, Elevator, HVAC, Painting, Roof Repairs, Landscaping, etc.)
- Parent (non-posting): 5100 - Repairs & Maintenance Expense

**Utilities (5400-5408):**
- 5402: Water & Sewer
- 5403: Electric - House
- 5404: Electric - Vacant
- 5405: Tenant Utilities Paid By Mgt
- 5406: Garbage
- 5407: GAS - Vacant
- 5408: GAS - House
- Parent (non-posting): 5400 - Utilities Expense
- **When a user asks about "utility expenses" or "utilities", sum accounts 5402, 5403, 5404, 5405, 5406, 5407, 5408.**

**Taxes (5500-5502):**
- 5501: Property Taxes
- 5502: CA Franchise Tax

**Insurance (5550-5555):**
- 5551: Car Insurance
- 5552: Building Insurance
- 5553: Liability Insurance
- 5554: EQ Insurance (Earthquake)
- 5555: Umbrella Insurance

**General & Administrative (5600-5613):**
- 5601-5613: Office Supplies, Internet, Telephone, Software, Advertising, Bank Fees, Auto/Travel, Leasing Expense, etc.

**Legal & Professional (5700-5710):**
- 5701: Professional Fees
- 5702: Legal Fees
- 5703: Accounting Fees
- 5710: HOA Dues

**Other Operating (5800-5900):**
- 5801: Capital Expenses
- 5802: Other General Expense
- 5803: Laundry Equipment & Repair
- 5900: Misc Rental Expense

### Non-Operating Expenses (6000+ series)

- 6100-6104: Construction (Contractors, Labor, Equipment Rental, Materials)
- 6200: Depreciation Expense
- 6201: Amortization Expense
- 6230: Mortgage Interest Expense
- 6250: Sales Fees and Expenses

### GL Accounts Table

```
gl_accounts
  id                  bigint (PK)
  account_number      text (unique, e.g., "5402")
  account_name        text (e.g., "Water & Sewer")
  account_type        text ("Asset", "Liability", "Equity", "Income", "Expense")
  parent_account_id   bigint (FK to gl_accounts.id, for non-posting parents)
  is_corporate        boolean
  fund_account        text
  status              text
```

**Non-posting accounts** (like "5100 - Repairs & Maintenance Expense (non-posting)") are grouping headers — they don't hold transactions. Their children hold the actual amounts. When a user asks about a category like "repairs and maintenance", query accounts in the range 5102-5134, not account 5100.

---

## GL Transactions

Every financial transaction across all properties. This is the most detailed data source.

```
gl_transactions
  id                  bigint (PK)
  property_id         bigint (FK → properties.id)
  gl_account_id       bigint (FK → gl_accounts.id)
  transaction_date    date
  description         text
  debit               numeric
  credit              numeric
  net_amount          numeric (computed: debit - credit)
  transaction_type    text (e.g., "Receipt", "Bill", "Journal Entry")
  reference           text
  vendor              text
  import_batch        text
```

**Key relationships:**
- Always JOIN `properties` for property name: `JOIN properties p ON p.id = g.property_id`
- Always JOIN `gl_accounts` for account info: `JOIN gl_accounts ga ON ga.id = g.gl_account_id`

**Amount conventions:**
- Revenue/Income: appears as `credit` (positive credit means income received)
- Expenses: appears as `debit` (positive debit means money spent)
- To get total revenue: `SUM(credit) WHERE account_type = 'Income'`
- To get total expenses: `SUM(debit) WHERE account_type = 'Expense'`
- NOI = Total Revenue (credits from Income accounts) - Total Expenses (debits from Expense accounts)

---

## Income Statements

Annual income statement data with two levels of detail:

### income_statement_lines (Detail)

Individual income/expense line items per property per period.

```
income_statement_lines
  id                  bigint (PK)
  property_id         bigint (FK → properties.id)
  period_start        date (e.g., "2025-01-01")
  period_end          date (e.g., "2025-12-31")
  account_name        text (e.g., "Rental Charges", "Water & Sewer")
  account_number      text (e.g., "4101", "5402")
  amount              numeric
  category            text ("Income", "Expense", "Other Income", "Other Expense")
  subcategory         text (optional grouping, e.g., "Rental Income", "Repairs & Maintenance Expense")
  line_type           text ("line_item" or "summary")
```

**Categories:**
- **Income**: Operating revenue (rent, fees, utility income, bad debts)
- **Expense**: Operating expenses (wages, R&M, utilities, taxes, insurance, G&A)
- **Other Income**: Non-operating income (interest income)
- **Other Expense**: Non-operating expenses (mortgage interest, depreciation)

### income_statement_summary (Summary)

Pre-computed totals per property per period.

```
income_statement_summary
  id                  bigint (PK)
  property_id         bigint (FK → properties.id)
  period_start        date
  period_end          date
  total_operating_income    numeric
  total_operating_expense   numeric
  noi                       numeric (Net Operating Income = operating income - operating expense)
  total_other_income        numeric
  total_other_expense       numeric
  net_income                numeric (bottom line after all income and expenses)
```

**NOI vs Net Income:**
- **NOI** = Total Operating Income - Total Operating Expense (excludes mortgage interest, depreciation, etc.)
- **Net Income** = NOI + Other Income - Other Expense (includes everything)
- When users ask about "profitability" or "how is the property doing", NOI is usually the most relevant metric for property operations. Net Income includes financing costs (mortgage) which vary by ownership structure.

---

## Balance Sheets

Point-in-time financial position with two levels of detail:

### balance_sheets (Summary)

Key financial position metrics per property.

```
balance_sheets
  id                  bigint (PK)
  property_id         bigint (FK → properties.id)
  as_of_date          date
  cash_and_equivalents      numeric
  accounts_receivable       numeric
  total_assets              numeric
  mortgage_balance          numeric
  total_liabilities         numeric
  total_equity              numeric
```

**Balance sheet equation:** total_assets = total_liabilities + total_equity (always)

### balance_sheet_lines (Detail)

Every line item from the balance sheet, grouped by section.

```
balance_sheet_lines
  id                  bigint (PK)
  property_id         bigint (FK → properties.id)
  as_of_date          date
  section             text ("Assets", "Liabilities", "Capital")
  subsection          text (e.g., "Cash")
  account_name        text (e.g., "Accumulated Depreciation", "Mortgage Payable")
  amount              numeric
  line_type           text ("line_item" or "summary")
```

---

## Materialized Views (Pre-Computed)

These views are refreshed after each import. They provide fast access to common aggregations.

### mv_annual_property_summary
Annual financial summary per property, computed from GL transactions.
```
  property_id         bigint
  property_name       text
  owner_entity        text
  total_units         integer
  year                integer
  total_revenue       numeric (sum of credits from Income accounts)
  total_expenses      numeric (sum of debits from Expense accounts)
  noi                 numeric (revenue - expenses)
  transaction_count   integer
```

### mv_monthly_expenses_by_category
Monthly expense breakdown by GL account per property.
```
  property_id         bigint
  property_name       text
  expense_category    text (account_name from gl_accounts)
  account_number      text
  month               date (first day of month)
  amount              numeric
  transaction_count   integer
```

### mv_portfolio_annual
Portfolio-wide annual totals.
```
  year                integer
  property_count      integer
  total_revenue       numeric
  total_expenses      numeric
  portfolio_noi       numeric
```

---

## Common Query Patterns

### Get a property's income statement for a year
```sql
SELECT isl.category, isl.account_name, isl.amount
FROM income_statement_lines isl
JOIN properties p ON p.id = isl.property_id
WHERE LOWER(p.name) = 'castle'
  AND isl.period_start = '2025-01-01'
  AND isl.line_type = 'line_item'
ORDER BY isl.category, isl.account_name
```

### Get NOI and net income for a property
```sql
SELECT p.name, iss.period_start, iss.noi, iss.net_income,
       iss.total_operating_income, iss.total_operating_expense
FROM income_statement_summary iss
JOIN properties p ON p.id = iss.property_id
WHERE LOWER(p.name) = 'castle'
ORDER BY iss.period_start
```

### Get total utility expenses for a property in a year
```sql
SELECT p.name, ga.account_name, SUM(g.debit) as total_expense
FROM gl_transactions g
JOIN properties p ON p.id = g.property_id
JOIN gl_accounts ga ON ga.id = g.gl_account_id
WHERE LOWER(p.name) = 'colony surf'
  AND ga.account_number IN ('5402','5403','5404','5405','5406','5407','5408')
  AND g.transaction_date >= '2025-01-01'
  AND g.transaction_date < '2026-01-01'
GROUP BY p.name, ga.account_name
ORDER BY total_expense DESC
```

### Get balance sheet for a property
```sql
SELECT p.name, bs.total_assets, bs.total_liabilities, bs.total_equity,
       bs.cash_and_equivalents, bs.mortgage_balance
FROM balance_sheets bs
JOIN properties p ON p.id = bs.property_id
WHERE LOWER(p.name) = 'colony surf'
```

### Get detailed balance sheet line items
```sql
SELECT bsl.section, bsl.account_name, bsl.amount, bsl.line_type
FROM balance_sheet_lines bsl
JOIN properties p ON p.id = bsl.property_id
WHERE LOWER(p.name) = 'colony surf'
  AND bsl.as_of_date = '2026-03-09'
ORDER BY bsl.section, bsl.account_name
```

### Compare NOI across all properties for a year
```sql
SELECT p.name, iss.noi, iss.net_income
FROM income_statement_summary iss
JOIN properties p ON p.id = iss.property_id
WHERE iss.period_start = '2025-01-01'
ORDER BY iss.noi DESC
```

### Get annual summary from materialized view (fastest)
```sql
SELECT * FROM mv_annual_property_summary
WHERE year = 2025
ORDER BY noi DESC
```

### Get monthly expense trend for a category
```sql
SELECT month::text, amount
FROM mv_monthly_expenses_by_category
WHERE property_name = 'Castle'
  AND account_number = '5402'
ORDER BY month
```

### Total portfolio NOI by year
```sql
SELECT * FROM mv_portfolio_annual ORDER BY year DESC
```

### Top 10 vendors by spend for a property
```sql
SELECT g.vendor, SUM(g.debit) as total_spend, COUNT(*) as txn_count
FROM gl_transactions g
JOIN properties p ON p.id = g.property_id
WHERE LOWER(p.name) = 'castle'
  AND g.transaction_date >= '2025-01-01'
  AND g.vendor IS NOT NULL AND g.vendor != ''
GROUP BY g.vendor
ORDER BY total_spend DESC
LIMIT 10
```

### Get mortgage balance across all properties
```sql
SELECT p.name, bs.mortgage_balance
FROM balance_sheets bs
JOIN properties p ON p.id = bs.property_id
WHERE bs.mortgage_balance > 0
ORDER BY bs.mortgage_balance DESC
```

### Repairs & maintenance spend by property
```sql
SELECT p.name, SUM(g.debit) as rm_total
FROM gl_transactions g
JOIN properties p ON p.id = g.property_id
JOIN gl_accounts ga ON ga.id = g.gl_account_id
WHERE ga.account_number BETWEEN '5102' AND '5134'
  AND g.transaction_date >= '2025-01-01'
  AND g.transaction_date < '2026-01-01'
GROUP BY p.name
ORDER BY rm_total DESC
```

---

## Expense Category Groupings

When users ask about expense categories in plain English, map to the following GL account ranges:

| User Says | GL Accounts | Account Numbers |
|---|---|---|
| "utilities" or "utility expenses" | Water & Sewer, Electric (House & Vacant), Tenant Utilities, Garbage, Gas (House & Vacant) | 5402, 5403, 5404, 5405, 5406, 5407, 5408 |
| "repairs" or "maintenance" or "R&M" | All R&M line items | 5102 through 5134 |
| "payroll" or "wages" or "labor costs" | Wages (Mgmt, Maint, Leasing), Payroll Taxes, Bonus, Benefits | 5091, 5092, 5093, 5094, 5095, 5096, 5097, 5098 |
| "insurance" | Building, Liability, EQ, Umbrella, Car | 5551, 5552, 5553, 5554, 5555 |
| "taxes" or "property taxes" | Property Taxes, CA Franchise Tax | 5501, 5502 |
| "G&A" or "general and admin" | Office, Internet, Phone, Software, Advertising, etc. | 5601 through 5613 |
| "legal" or "professional fees" | Professional, Legal, Accounting fees | 5701, 5702, 5703 |
| "management fees" | Management Fees, Asset Management Fee | 5000, 5001 |
| "mortgage" or "debt service" | Mortgage Interest Expense | 6230 |
| "depreciation" | Depreciation Expense, Amortization | 6200, 6201 |
| "construction" | Contractors, Labor, Equipment Rental, Materials | 6101, 6102, 6103, 6104 |
| "capital expenses" | Capital Expenses | 5801 |

---

## Important Notes

1. **Property name matching**: Users may refer to properties informally. "Castle Apartments" = "Castle". "The Envoy" = "Envoy". Use ILIKE or LOWER() for flexible matching.

2. **Income statement periods are annual**: period_start is always Jan 1 and period_end is Dec 31 of that year. To query a specific year, use `period_start = 'YYYY-01-01'`.

3. **GL transactions are the source of truth** for detailed transaction-level analysis. Income statements and balance sheets are imported from separate AppFolio reports and may cover different time periods.

4. **NOI vs Net Income**: NOI excludes mortgage interest, depreciation, and other non-operating items. It's the standard metric for evaluating property operating performance. Net Income includes everything.

5. **Debit/Credit convention**: In GL transactions, debits increase expenses and assets; credits increase income and liabilities. For expense analysis, sum `debit`. For revenue analysis, sum `credit`.

6. **Balance sheet data is point-in-time** (as_of_date), not period-based. Currently only one snapshot date exists (2026-03-09).

7. **Materialized views** (`mv_annual_property_summary`, `mv_monthly_expenses_by_category`, `mv_portfolio_annual`) are pre-computed and faster than querying raw GL transactions. Use them when possible for annual or monthly aggregations.
