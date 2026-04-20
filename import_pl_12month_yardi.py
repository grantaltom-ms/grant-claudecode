#!/usr/bin/env python3
"""
Import Yardi "Profit & Loss 12 Month Recap" XLSX files into Supabase.

These are Jan–Dec 2023 monthly P&L files per property.
The format differs from AppFolio:
  - Property name in row 4: "Property: Castle Apartments"
  - Headers in row 6: "JAN 23", "FEB 23", ... "DEC 23", "TOTAL"
  - Account numbers embedded in line item names: "5091 Wages - Management"
  - Summary rows (Total Income, Total Expense, NOI, etc.) contain formulas (no cached value)
    → computed from line items instead

Usage:
    python3 import_pl_12month_yardi.py [--dry-run]
"""

import os
import sys
import re
import calendar
import argparse
from datetime import date
from pathlib import Path

import openpyxl

# ---------------------------------------------------------------------------
# Environment / credentials
# ---------------------------------------------------------------------------

def load_env_local():
    search_paths = [
        Path(__file__).parent / ".env",
        Path(__file__).parent / ".env.local",
        Path(__file__).parent.parent / "milestone-finance-web" / ".env.local",
    ]
    for p in search_paths:
        if p.exists():
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, _, v = line.partition("=")
                        os.environ.setdefault(k.strip(), v.strip())
            print(f"  Loaded env from {p}")
            return


load_env_local()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_KEY")
    or ""
)

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY) must be set.")
    sys.exit(1)

from supabase import create_client
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# ---------------------------------------------------------------------------
# File list
# ---------------------------------------------------------------------------

DOWNLOADS = Path("/Users/grantcarlson/Downloads")

FILE_CODES = [
    "WOOD", "TVUE", "PAC", "UVIEW", "FIFTH", "RONI", "REDMOND", "RAVEN",
    "MANOR", "Quarry", "Park Place", "KERRY", "KENTON", "GALER", "ISHER",
    "HEATHER", "ENV", "DDCULP", "DOLOR", "CROSBY", "SURF", "HUDS", "EDMUNDS",
    "BUCC", "CAST", "Brookland", "BWOOD", "BRANDO", "ANSON", "ASCON",
    "Madrona", "BONVIS", "BELVIS", "Renton Ave", "EJOHN", "1413EJ",
]

XLSX_FILES = [
    DOWNLOADS / f"Profit & Loss 12 Month Recap - {code}.xlsx"
    for code in FILE_CODES
]

# ---------------------------------------------------------------------------
# Property name normalization
# Yardi names → Supabase names (where they differ)
# ---------------------------------------------------------------------------

YARDI_TO_SUPABASE = {
    "woodland park":          "Woodland",
    "townvue heights":        "Townvue",
    "the fifth":              "Top of Fifth",
    "park place apartments":  "Park Place",
    "heather apartments":     "Heather",
    "dolores apartments":     "CC Dolores",
    "castle apartments":      "Castle",
    "ascona seattle":         "Ascona",
    "9275 renton ave":        "9275 Renton",
    # Not in Supabase — will be skipped
    "quarry apartments":      None,
    "brookland apartments":   None,
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MONTH_MAP = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

# Top-level section markers
INCOME_SECTION_STARTS  = {"Income"}
EXPENSE_SECTION_STARTS = {"Expense"}
NOI_SECTION_STARTS     = {"NOI"}
OTHER_EXP_STARTS       = {"N/O EXPENSE"}

# Rows to skip entirely (formula-only aggregates)
SKIP_PREFIXES = ("Total ", "NET INCOME", "Summary")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def indent_level(s: str) -> int:
    stripped = s.lstrip(" ")
    return (len(s) - len(stripped)) // 3  # Yardi uses 3-space indent


def clean_amount(val) -> float:
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace("$", "").replace(",", "").strip()
    if not s or s in ("-", "="):
        return 0.0
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except ValueError:
        return 0.0


def is_numeric(val) -> bool:
    if isinstance(val, (int, float)):
        return True
    if val is None:
        return False
    s = str(val).strip()
    if s in ("=", ""):
        return False
    try:
        float(s.replace("$", "").replace(",", ""))
        return True
    except ValueError:
        return False


def parse_account(raw_name: str):
    """
    Split '5091 Wages - Management' into ('5091', 'Wages - Management').
    Returns (None, name) if no leading account number.
    """
    name = raw_name.strip()
    m = re.match(r"^(\d{4,5})\s+(.+)$", name)
    if m:
        return m.group(1), m.group(2)
    return None, name


def month_period(year: int, month: int):
    last_day = calendar.monthrange(year, month)[1]
    return (
        date(year, month, 1).isoformat(),
        date(year, month, last_day).isoformat(),
    )


# ---------------------------------------------------------------------------
# Property name resolution
# ---------------------------------------------------------------------------

def load_property_map() -> dict:
    rows = sb.table("properties").select("id, name").execute().data
    return {r["name"].lower().strip(): r["id"] for r in rows}


def resolve_property(yardi_name: str, prop_map: dict):
    """Return Supabase property_id for a Yardi property name, or None if not found."""
    key = yardi_name.lower().strip()

    # Check explicit override map first
    if key in YARDI_TO_SUPABASE:
        mapped = YARDI_TO_SUPABASE[key]
        if mapped is None:
            return None, f"explicitly excluded ({yardi_name})"
        lookup = mapped.lower()
        pid = prop_map.get(lookup)
        return pid, mapped if pid else f"mapped to '{mapped}' but not in Supabase"

    # Try direct match
    pid = prop_map.get(key)
    if pid:
        return pid, yardi_name

    return None, f"no match for '{yardi_name}'"


# ---------------------------------------------------------------------------
# XLSX parser
# ---------------------------------------------------------------------------

def parse_xlsx(filepath: Path) -> dict:
    """
    Returns:
        {
          'property_name': str,   (raw Yardi name)
          'year': int,
          'months': {
              month_num: {
                  'period_start': str,
                  'period_end': str,
                  'lines': [{'account_name', 'account_number', 'amount',
                              'category', 'subcategory', 'line_type'}, ...],
                  'summary': {'total_operating_income', 'total_operating_expense',
                              'noi', 'net_income'}
              }
          }
        }
    """
    wb = openpyxl.load_workbook(filepath, data_only=True)
    ws = wb.active
    all_rows = list(ws.iter_rows(values_only=True))

    if len(all_rows) < 6:
        raise ValueError(f"File too short: {filepath.name}")

    # Row 4 (index 3): property name
    raw_prop = str(all_rows[3][0] or "").strip()
    if raw_prop.lower().startswith("property:"):
        raw_prop = raw_prop[len("property:"):].strip()
    property_name = raw_prop

    # Row 2 (index 1): date range → year
    date_text = str(all_rows[1][0] or "")
    year_match = re.search(r"\b(20\d{2})\b", date_text)
    year = int(year_match.group(1)) if year_match else 2023

    # Row 6 (index 5): headers — " " | "JAN 23" | ... | "DEC 23" | "TOTAL"
    header_row = all_rows[5]
    month_cols = {}  # col_index → month_number
    for ci, cell in enumerate(header_row):
        if ci == 0 or cell is None:
            continue
        cell_str = str(cell).strip().upper()
        m = re.match(r"^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d{2}$", cell_str)
        if m:
            month_num = MONTH_MAP[m.group(1)]
            month_cols[ci] = month_num

    if not month_cols:
        raise ValueError(f"No month columns found in {filepath.name}")

    # Initialize per-month buckets
    months = {}
    for mnum in month_cols.values():
        ps, pe = month_period(year, mnum)
        months[mnum] = {
            "period_start": ps,
            "period_end": pe,
            "lines": [],
            # accumulators for computing summary
            "_income": {m: 0.0 for m in month_cols.values()},
            "_expense": {m: 0.0 for m in month_cols.values()},
            "_other_exp": {m: 0.0 for m in month_cols.values()},
        }

    # Walk data rows (index 6 onward)
    current_category = None
    current_subcategory = None

    for row in all_rows[6:]:
        raw_name = row[0]
        if raw_name is None:
            continue
        raw_name_str = str(raw_name)
        account_name_raw = raw_name_str.strip()
        if not account_name_raw:
            continue

        level = indent_level(raw_name_str)

        # ---- Section markers (level 0, no data) ----
        if account_name_raw in INCOME_SECTION_STARTS:
            current_category = "Income"
            current_subcategory = None
            continue
        if account_name_raw in EXPENSE_SECTION_STARTS:
            current_category = "Expense"
            current_subcategory = None
            continue
        if account_name_raw in NOI_SECTION_STARTS:
            current_category = None  # NOI row — computed, not stored as line
            continue
        if account_name_raw in OTHER_EXP_STARTS:
            current_category = "Other Expense"
            current_subcategory = None
            continue

        # ---- Skip aggregate rows ----
        if any(account_name_raw.startswith(p) for p in SKIP_PREFIXES):
            continue
        if account_name_raw in ("NET INCOME", "Summary", "   Income", "   Expense",
                                "   Net Operating Income", "   N/O EXPENSE", "   NET INCOME"):
            continue

        # ---- Non-posting group headers (level 1, no data) ----
        # e.g. "   4100 Rental Income (non-posting)"
        has_data = any(is_numeric(row[ci]) for ci in month_cols)
        if not has_data:
            if "(non-posting)" in account_name_raw.lower() or level == 1:
                # Extract subcategory from the group header
                sub = re.sub(r"\s*\(non-posting\)", "", account_name_raw, flags=re.I).strip()
                acct_num, sub_name = parse_account(sub)
                current_subcategory = sub_name
            continue

        # ---- Line items (have actual numeric data) ----
        acct_num, clean_name = parse_account(account_name_raw)

        for col_idx, mnum in month_cols.items():
            val = clean_amount(row[col_idx] if col_idx < len(row) else None)
            months[mnum]["lines"].append({
                "account_name":   clean_name,
                "account_number": acct_num,
                "amount":         val,
                "category":       current_category,
                "subcategory":    current_subcategory,
                "line_type":      "line_item",
            })
            # Accumulate for summary
            if current_category == "Income":
                months[mnum]["_income"][mnum] += val
            elif current_category == "Expense":
                months[mnum]["_expense"][mnum] += val
            elif current_category == "Other Expense":
                months[mnum]["_other_exp"][mnum] += val

    # Compute per-month summaries and add summary lines
    for mnum, mdata in months.items():
        inc = mdata["_income"][mnum]
        exp = mdata["_expense"][mnum]
        other_exp = mdata["_other_exp"][mnum]
        noi = inc - exp
        net_income = noi - other_exp

        mdata["summary"] = {
            "total_operating_income":  inc,
            "total_operating_expense": exp,
            "noi":                     noi,
            "net_income":              net_income,
        }

        # Add summary lines (for income_statement_lines)
        for label, col, val in [
            ("Total Operating Income",    "Income",  inc),
            ("Total Operating Expense",   "Expense", exp),
            ("NOI - Net Operating Income","Income",  noi),
            ("Net Income",                "Income",  net_income),
        ]:
            mdata["lines"].append({
                "account_name":   label,
                "account_number": None,
                "amount":         val,
                "category":       col,
                "subcategory":    None,
                "line_type":      "summary",
            })

        # Clean up accumulator keys
        del mdata["_income"], mdata["_expense"], mdata["_other_exp"]

    return {
        "property_name": property_name,
        "year": year,
        "months": months,
    }


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def get_existing_summary_periods(property_id: int, year: int) -> set:
    rows = (
        sb.table("income_statement_summary")
        .select("period_start")
        .eq("property_id", property_id)
        .gte("period_start", f"{year}-01-01")
        .lte("period_start", f"{year}-12-31")
        .execute()
        .data
    )
    return {r["period_start"] for r in rows}


def get_existing_lines_periods(property_id: int, year: int) -> set:
    rows = (
        sb.table("income_statement_lines")
        .select("period_start")
        .eq("property_id", property_id)
        .gte("period_start", f"{year}-01-01")
        .lte("period_start", f"{year}-12-31")
        .limit(200)
        .execute()
        .data
    )
    return {r["period_start"] for r in rows}


def insert_summary(property_id: int, period_start: str, period_end: str,
                   summary: dict, dry_run: bool) -> str:
    row = {
        "property_id":             property_id,
        "period_start":            period_start,
        "period_end":              period_end,
        "total_operating_income":  summary["total_operating_income"],
        "total_operating_expense": summary["total_operating_expense"],
        "noi":                     summary["noi"],
        "net_income":              summary["net_income"],
    }
    if dry_run:
        return "dry-run"
    result = (
        sb.table("income_statement_summary")
        .upsert(row, on_conflict="property_id,period_start", ignore_duplicates=True)
        .execute()
    )
    return "inserted" if result.data else "skipped"


def insert_lines(property_id: int, period_start: str, period_end: str,
                 lines: list, dry_run: bool) -> int:
    if not lines:
        return 0
    rows = [
        {
            "property_id":    property_id,
            "period_start":   period_start,
            "period_end":     period_end,
            "account_name":   ln["account_name"],
            "account_number": ln["account_number"],
            "amount":         ln["amount"],
            "category":       ln["category"],
            "subcategory":    ln["subcategory"],
            "line_type":      ln["line_type"],
        }
        for ln in lines
    ]
    if dry_run:
        return len(rows)
    result = sb.table("income_statement_lines").insert(rows).execute()
    return len(result.data)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(dry_run: bool = False):
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Milestone — Yardi P&L 12-Month Import (2023)")
    print(f"Files: {len(XLSX_FILES)}\n")

    prop_map = load_property_map()
    print(f"Loaded {len(prop_map)} properties from Supabase.\n")
    print("=" * 70)

    totals = {
        "files": 0, "months_inserted": 0, "months_skipped": 0,
        "lines_inserted": 0, "not_found": [], "parse_errors": [],
    }

    for filepath in XLSX_FILES:
        totals["files"] += 1
        print(f"\n→ {filepath.name}")

        if not filepath.exists():
            print(f"   ERROR: File not found.")
            totals["parse_errors"].append(filepath.name)
            continue

        try:
            parsed = parse_xlsx(filepath)
        except Exception as e:
            print(f"   ERROR parsing: {e}")
            totals["parse_errors"].append(filepath.name)
            continue

        yardi_name = parsed["property_name"]
        year = parsed["year"]
        prop_id, resolution = resolve_property(yardi_name, prop_map)

        if prop_id is None:
            print(f"   SKIPPED — '{yardi_name}': {resolution}")
            totals["not_found"].append(f"{yardi_name} ({resolution})")
            continue

        print(f"   Property: {yardi_name} → '{resolution}' (id={prop_id}, year={year})")

        existing_summary = get_existing_summary_periods(prop_id, year)
        existing_lines = get_existing_lines_periods(prop_id, year)

        for mnum in sorted(parsed["months"].keys()):
            mdata = parsed["months"][mnum]
            ps = mdata["period_start"]
            pe = mdata["period_end"]
            month_label = date.fromisoformat(ps).strftime("%b %Y")

            # Summary
            if ps in existing_summary:
                sum_status = "skipped (exists)"
                totals["months_skipped"] += 1
            else:
                sum_status = insert_summary(prop_id, ps, pe, mdata["summary"], dry_run)
                if sum_status in ("inserted", "dry-run"):
                    totals["months_inserted"] += 1
                else:
                    totals["months_skipped"] += 1

            # Lines
            if ps in existing_lines:
                lines_status = "skipped (exists)"
            else:
                n_ins = insert_lines(prop_id, ps, pe, mdata["lines"], dry_run)
                totals["lines_inserted"] += n_ins
                lines_status = f"{n_ins} lines {'(dry-run)' if dry_run else 'inserted'}"

            noi = mdata["summary"]["noi"]
            print(f"     {month_label}: summary={sum_status}, lines={lines_status}  [NOI={noi:+,.0f}]")

    print("\n" + "=" * 70)
    print("IMPORT COMPLETE")
    print(f"  Files processed:     {totals['files']}")
    print(f"  Months inserted:     {totals['months_inserted']}")
    print(f"  Months skipped:      {totals['months_skipped']} (already had data)")
    print(f"  Lines inserted:      {totals['lines_inserted']}")
    if totals["not_found"]:
        print(f"  Not matched ({len(totals['not_found'])}):")
        for n in totals["not_found"]:
            print(f"    - {n}")
    if totals["parse_errors"]:
        print(f"  Parse errors ({len(totals['parse_errors'])}):")
        for n in totals["parse_errors"]:
            print(f"    - {n}")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
