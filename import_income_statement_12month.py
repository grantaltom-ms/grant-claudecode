#!/usr/bin/env python3
"""
Import AppFolio 12-month income statement XLSX or CSV files into Supabase.

Each file covers Jan–Dec for a single property.
Inserts monthly records (one per month per property) into:
  - income_statement_summary  (unique on property_id, period_start → skip on conflict)
  - income_statement_lines    (pre-check existence before inserting to avoid dupes)

Usage:
    python3 import_income_statement_12month.py [folder_path] [--dry-run]

Set SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) in environment,
or place a .env file in this directory.
"""

import os
import sys
import re
import csv
import glob
import calendar
import argparse
from datetime import date
from pathlib import Path

import openpyxl

# ---------------------------------------------------------------------------
# Environment / credentials
# ---------------------------------------------------------------------------

def load_env_local():
    """Load .env or .env.local from this dir or the sibling Next.js project."""
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
    print("  Warning: no .env/.env.local found; relying on existing environment variables.")


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
# Constants
# ---------------------------------------------------------------------------

XLSX_FOLDER = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else Path("/Users/grantcarlson/Downloads/bulk_income_statement_12_month (6)/")

CATEGORY_HEADERS = {
    "Income": "Income",
    "Operating Income": "Income",
    "Expense": "Expense",
    "Operating Expense": "Expense",
    "Operating Expenses": "Expense",
    "Other Income": "Other Income",
    "Other Expense": "Other Expense",
    "Other Expenses": "Other Expense",
}

IGNORED_HEADERS = {
    "Operating Income & Expense",
    "Other Income & Expense",
    "Income & Expense",
}

SUMMARY_LABELS = {
    "Net Operating Income", "NOI", "NOI - Net Operating Income",
    "Net Income", "Net Income (Loss)",
    "Total Income", "Total Expense",
    "Total Operating Income", "Total Operating Expense", "Total Operating Expenses",
    "Total Other Income", "Total Other Expense", "Total Other Expenses",
    "Net Other Income", "Net Other Expense",
}

# Map summary row names → income_statement_summary column
SUMMARY_TO_COLUMN = {
    "Total Operating Income":   "total_operating_income",
    "Total Operating Expense":  "total_operating_expense",
    "Total Operating Expenses": "total_operating_expense",
    "NOI - Net Operating Income": "noi",
    "NOI":                      "noi",
    "Net Operating Income":     "noi",
    "Net Income":               "net_income",
    "Net Income (Loss)":        "net_income",
}

# Month name → number
MONTH_MAP = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def indent_level(s: str) -> int:
    """Count groups of 4 leading spaces."""
    if not s:
        return 0
    stripped = s.lstrip(" ")
    return (len(s) - len(stripped)) // 4


def clean_amount(val) -> float:
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace("$", "").replace(",", "").strip()
    if not s or s == "-":
        return 0.0
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except ValueError:
        return 0.0


def month_period(year: int, month: int):
    """Return (period_start, period_end) as date strings for a given year/month."""
    last_day = calendar.monthrange(year, month)[1]
    return (
        date(year, month, 1).isoformat(),
        date(year, month, last_day).isoformat(),
    )


def extract_property_name(row5_value: str) -> str:
    """
    'Properties: Castle - 2132 2nd Ave Seattle, WA 98121'
    → 'Castle'
    """
    if not row5_value:
        return ""
    text = str(row5_value).strip()
    if text.startswith("Properties:"):
        text = text[len("Properties:"):].strip()
    # Take the part before the first ' - ' (address separator)
    if " - " in text:
        text = text.split(" - ", 1)[0].strip()
    return text


# ---------------------------------------------------------------------------
# CSV filename → property name matching
# ---------------------------------------------------------------------------

def name_to_slug(name: str) -> str:
    """Convert 'CC Dolores' → 'cc_dolores', '9275 Renton' → '9275_renton'."""
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def match_property_from_slug(filename_stem: str, prop_map: dict):
    """
    Given a filename stem like 'castle_2132_2nd_ave_seattle_wa_98121',
    find the best matching property name (lowercase) from prop_map keys.
    Uses longest-slug-prefix match so 'cc_dolores' beats 'cc'.
    """
    # Strip the common file prefix
    slug = filename_stem.replace("income_statement_12_month__", "")

    best_name = None
    best_len = 0
    for prop_lower_name in prop_map:
        prop_slug = name_to_slug(prop_lower_name)
        if slug == prop_slug or slug.startswith(prop_slug + "_"):
            if len(prop_slug) > best_len:
                best_name = prop_lower_name
                best_len = len(prop_slug)
    return best_name


# ---------------------------------------------------------------------------
# Property name → ID cache
# ---------------------------------------------------------------------------

def load_property_map() -> dict:
    """Return {lower_name: id} for all non-group properties."""
    rows = sb.table("properties").select("id, name").execute().data
    return {r["name"].lower().strip(): r["id"] for r in rows}


# ---------------------------------------------------------------------------
# XLSX parser
# ---------------------------------------------------------------------------

def parse_xlsx(filepath: Path) -> dict:
    """
    Parse a 12-month income statement XLSX.

    Returns:
        {
          'property_name': str,
          'year': int,
          'months': {
              month_num: {
                  'period_start': str,
                  'period_end': str,
                  'summary': {col_name: float, ...},   # for income_statement_summary
                  'lines': [{'account_name', 'amount', 'category', 'subcategory',
                              'line_type'}, ...]
              }
          }
        }
    """
    wb = openpyxl.load_workbook(filepath, data_only=True)
    ws = wb.active
    all_rows = list(ws.iter_rows(values_only=True))

    if len(all_rows) < 12:
        raise ValueError(f"File too short: {filepath.name}")

    # Row 5 (index 4): property name
    property_name = extract_property_name(all_rows[4][0])

    # Row 7 (index 6): period range → extract year
    period_range_text = str(all_rows[6][0] or "")
    year_match = re.search(r"\b(20\d{2})\b", period_range_text)
    year = int(year_match.group(1)) if year_match else 2024

    # Row 12 (index 11): headers
    # Col 0: Account Name, Cols 1-12: Jan 2024 ... Dec 2024, Col 13: Total
    header_row = all_rows[11]
    month_cols = {}  # col_index → month_number
    for ci, cell in enumerate(header_row):
        if ci == 0 or cell is None:
            continue
        cell_str = str(cell).strip()
        m = re.match(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$", cell_str)
        if m:
            month_num = MONTH_MAP[m.group(1)]
            month_cols[ci] = month_num

    if not month_cols:
        raise ValueError(f"No month columns found in {filepath.name}")

    # Initialize per-month buckets
    months = {}
    for col_idx, mnum in month_cols.items():
        ps, pe = month_period(year, mnum)
        months[mnum] = {
            "period_start": ps,
            "period_end": pe,
            "summary": {
                "total_operating_income": 0.0,
                "total_operating_expense": 0.0,
                "noi": 0.0,
                "net_income": 0.0,
            },
            "lines": [],
        }

    # Walk data rows (index 12 onward)
    current_category = None
    current_subcategory = None

    for row in all_rows[12:]:
        raw_name = row[0]
        if raw_name is None:
            continue
        raw_name_str = str(raw_name)
        account_name = raw_name_str.strip()
        if not account_name:
            continue

        level = indent_level(raw_name_str)

        # Skip top-level grouping headers (level 0)
        if account_name in IGNORED_HEADERS:
            continue

        # Category headers (level 1, no amount)
        if account_name in CATEGORY_HEADERS:
            current_category = CATEGORY_HEADERS[account_name]
            current_subcategory = None
            continue

        # Non-posting subtotals → update subcategory name but don't store as line
        if "(non-posting)" in account_name.lower():
            # e.g. "Total Repairs & Maintenance Expense (non-posting)"
            # Extract clean subcategory name
            sub = re.sub(r"\s*\(non-posting\)", "", account_name, flags=re.I).strip()
            if sub.startswith("Total "):
                sub = sub[6:].strip()
            current_subcategory = sub or current_subcategory
            continue

        # Summary lines — capture for income_statement_summary
        if account_name in SUMMARY_LABELS:
            col_name = SUMMARY_TO_COLUMN.get(account_name)
            for col_idx, mnum in month_cols.items():
                val = clean_amount(row[col_idx] if col_idx < len(row) else None)
                if col_name:
                    months[mnum]["summary"][col_name] = val
            # Also store as a summary line in income_statement_lines
            for col_idx, mnum in month_cols.items():
                val = clean_amount(row[col_idx] if col_idx < len(row) else None)
                months[mnum]["lines"].append({
                    "account_name": account_name,
                    "account_number": None,
                    "amount": val,
                    "category": current_category,
                    "subcategory": current_subcategory,
                    "line_type": "summary",
                })
            continue

        # Line items — level 2+ with actual amounts
        if level >= 2:
            # Skip subtotal rows that start with "Total " (non-summary subtotals)
            if account_name.startswith("Total "):
                continue
            for col_idx, mnum in month_cols.items():
                val = clean_amount(row[col_idx] if col_idx < len(row) else None)
                months[mnum]["lines"].append({
                    "account_name": account_name,
                    "account_number": None,
                    "amount": val,
                    "category": current_category,
                    "subcategory": current_subcategory,
                    "line_type": "line_item",
                })

    return {
        "property_name": property_name,
        "year": year,
        "months": months,
    }


# ---------------------------------------------------------------------------
# CSV parser  (same AppFolio structure, but no property-name row)
# ---------------------------------------------------------------------------

def parse_csv(filepath: Path, prop_map: dict) -> dict:
    """
    Parse a 12-month income statement CSV (AppFolio export).

    Row 1: headers — "Account Name", "Jan 2025", ..., "Total"
    Rows 2+: data rows with same 4-space indentation pattern.

    Property name is resolved from the filename stem.

    Returns same shape as parse_xlsx().
    """
    with open(filepath, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        all_rows = list(reader)

    if not all_rows:
        raise ValueError(f"Empty file: {filepath.name}")

    # Row 1 (index 0): headers
    header_row = all_rows[0]
    month_cols: dict[int, int] = {}
    year: int = 2025
    for ci, cell in enumerate(header_row):
        if ci == 0:
            continue
        cell_str = cell.strip()
        m = re.match(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$", cell_str)
        if m:
            month_num = MONTH_MAP[m.group(1)]
            year = int(m.group(2))
            month_cols[ci] = month_num

    if not month_cols:
        raise ValueError(f"No month columns found in {filepath.name}")

    # Property name from filename
    property_lower = match_property_from_slug(filepath.stem, prop_map)
    if property_lower is None:
        raise ValueError(f"Cannot match filename to property: {filepath.name}")
    # Reconstruct display name (title-cased from DB key is fine — actual insert uses prop_id)
    property_name = property_lower  # we'll look up via prop_map directly

    # Initialize per-month buckets
    months: dict[int, dict] = {}
    for col_idx, mnum in month_cols.items():
        ps, pe = month_period(year, mnum)
        months[mnum] = {
            "period_start": ps,
            "period_end": pe,
            "summary": {
                "total_operating_income": 0.0,
                "total_operating_expense": 0.0,
                "noi": 0.0,
                "net_income": 0.0,
            },
            "lines": [],
        }

    current_category = None
    current_subcategory = None

    for row in all_rows[1:]:
        if not row:
            continue
        raw_name = row[0] if row else ""
        if raw_name is None:
            continue
        raw_name_str = str(raw_name)
        account_name = raw_name_str.strip()
        if not account_name:
            continue

        level = indent_level(raw_name_str)

        if account_name in IGNORED_HEADERS:
            continue

        if account_name in CATEGORY_HEADERS:
            current_category = CATEGORY_HEADERS[account_name]
            current_subcategory = None
            continue

        if "(non-posting)" in account_name.lower():
            sub = re.sub(r"\s*\(non-posting\)", "", account_name, flags=re.I).strip()
            if sub.startswith("Total "):
                sub = sub[6:].strip()
            current_subcategory = sub or current_subcategory
            continue

        if account_name in SUMMARY_LABELS:
            col_name = SUMMARY_TO_COLUMN.get(account_name)
            for col_idx, mnum in month_cols.items():
                val = clean_amount(row[col_idx] if col_idx < len(row) else None)
                if col_name:
                    months[mnum]["summary"][col_name] = val
            for col_idx, mnum in month_cols.items():
                val = clean_amount(row[col_idx] if col_idx < len(row) else None)
                months[mnum]["lines"].append({
                    "account_name": account_name,
                    "account_number": None,
                    "amount": val,
                    "category": current_category,
                    "subcategory": current_subcategory,
                    "line_type": "summary",
                })
            continue

        if level >= 2:
            if account_name.startswith("Total "):
                continue
            for col_idx, mnum in month_cols.items():
                val = clean_amount(row[col_idx] if col_idx < len(row) else None)
                months[mnum]["lines"].append({
                    "account_name": account_name,
                    "account_number": None,
                    "amount": val,
                    "category": current_category,
                    "subcategory": current_subcategory,
                    "line_type": "line_item",
                })

    return {
        "property_name": property_name,
        "year": year,
        "months": months,
        "_prop_map_key": property_lower,  # already resolved
    }


def is_empty_month(summary: dict) -> bool:
    """
    Return True if a month has no financial activity at all.
    Empty months mean the property wasn't managed — skip them.
    """
    return (
        summary["total_operating_income"] == 0.0
        and summary["total_operating_expense"] == 0.0
        and summary["noi"] == 0.0
        and summary["net_income"] == 0.0
    )


# ---------------------------------------------------------------------------
# Supabase: check which months already have data
# ---------------------------------------------------------------------------

def get_existing_summary_periods(property_id: int, year: int) -> set:
    """Return set of period_start strings that already have a summary row."""
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
    """Return set of period_start strings that already have line item rows."""
    rows = (
        sb.table("income_statement_lines")
        .select("period_start")
        .eq("property_id", property_id)
        .gte("period_start", f"{year}-01-01")
        .lte("period_start", f"{year}-12-31")
        .limit(5000)
        .execute()
        .data
    )
    return {r["period_start"] for r in rows}


# ---------------------------------------------------------------------------
# Supabase: insert helpers
# ---------------------------------------------------------------------------

def insert_summary(property_id: int, period_start: str, period_end: str,
                   summary: dict, dry_run: bool) -> str:
    """Insert one month's summary row. Returns 'inserted' or 'skipped'."""
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
    # ON CONFLICT (property_id, period_start) DO NOTHING
    result = (
        sb.table("income_statement_summary")
        .upsert(row, on_conflict="property_id,period_start", ignore_duplicates=True)
        .execute()
    )
    # upsert with ignore_duplicates returns empty data on conflict
    return "inserted" if result.data else "skipped"


def insert_lines(property_id: int, period_start: str, period_end: str,
                 lines: list, dry_run: bool) -> tuple:
    """Batch-insert line items. Returns (inserted_count, skipped_count)."""
    if not lines:
        return 0, 0

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
        return len(rows), 0

    result = sb.table("income_statement_lines").insert(rows).execute()
    return len(result.data), 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(dry_run: bool = False):
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Milestone Properties — 12-Month Income Statement Import")
    print(f"Source folder: {XLSX_FOLDER}\n")

    # Load property map
    prop_map = load_property_map()
    print(f"Loaded {len(prop_map)} properties from Supabase.\n")

    xlsx_files = sorted(XLSX_FOLDER.glob("*.xlsx"))
    csv_files  = sorted(XLSX_FOLDER.glob("*.csv"))
    all_files  = xlsx_files + csv_files

    if not all_files:
        print(f"ERROR: No .xlsx or .csv files found in {XLSX_FOLDER}")
        sys.exit(1)

    print(f"Found {len(xlsx_files)} XLSX + {len(csv_files)} CSV files.\n")
    print("=" * 70)

    totals = {"files": 0, "months_inserted": 0, "months_skipped": 0,
              "months_empty": 0, "lines_inserted": 0, "not_found": []}

    for filepath in all_files:
        totals["files"] += 1
        print(f"\n→ {filepath.name}")

        try:
            if filepath.suffix.lower() == ".csv":
                parsed = parse_csv(filepath, prop_map)
                # For CSV, property_name is the lowercase DB key
                prop_map_key = parsed.get("_prop_map_key") or parsed["property_name"].lower()
                prop_id = prop_map.get(prop_map_key)
                prop_display = prop_map_key
            else:
                parsed = parse_xlsx(filepath)
                prop_display = parsed["property_name"]
                prop_id = prop_map.get(prop_display.lower())
        except Exception as e:
            print(f"   ERROR parsing file: {e}")
            continue

        year = parsed["year"]

        if prop_id is None:
            print(f"   SKIPPED — property '{prop_display}' not found in Supabase")
            totals["not_found"].append(prop_display)
            continue

        print(f"   Property: {prop_display} (id={prop_id}, year={year})")

        # Fetch which months already have data
        existing_summary = get_existing_summary_periods(prop_id, year)
        existing_lines = get_existing_lines_periods(prop_id, year)

        month_results = []
        for mnum in sorted(parsed["months"].keys()):
            mdata = parsed["months"][mnum]
            ps = mdata["period_start"]
            pe = mdata["period_end"]
            month_label = date.fromisoformat(ps).strftime("%b %Y")

            # Skip empty months (property not managed that month)
            if is_empty_month(mdata["summary"]):
                totals["months_empty"] += 1
                month_results.append(f"{month_label}: skipped (empty — not managed)")
                continue

            # --- Summary ---
            if ps in existing_summary:
                sum_status = "skipped (exists)"
                totals["months_skipped"] += 1
            else:
                sum_status = insert_summary(prop_id, ps, pe, mdata["summary"], dry_run)
                if sum_status in ("inserted", "dry-run"):
                    totals["months_inserted"] += 1
                else:
                    totals["months_skipped"] += 1

            # --- Lines ---
            if ps in existing_lines:
                lines_status = "skipped (exists)"
            else:
                n_ins, _ = insert_lines(prop_id, ps, pe, mdata["lines"], dry_run)
                totals["lines_inserted"] += n_ins
                lines_status = f"{n_ins} lines {'(dry-run)' if dry_run else 'inserted'}"

            month_results.append(f"{month_label}: summary={sum_status}, lines={lines_status}")

        for r in month_results:
            print(f"     {r}")

    # Final report
    print("\n" + "=" * 70)
    print("IMPORT COMPLETE")
    print(f"  Files processed:     {totals['files']}")
    print(f"  Months inserted:     {totals['months_inserted']}")
    print(f"  Months skipped:      {totals['months_skipped']} (already had data)")
    print(f"  Months empty:        {totals['months_empty']} (not managed — skipped)")
    print(f"  Lines inserted:      {totals['lines_inserted']}")
    if totals["not_found"]:
        print(f"  Properties not found in Supabase ({len(totals['not_found'])}):")
        for n in totals["not_found"]:
            print(f"    - {n}")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import 12-month income statement XLSX files")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and report without writing to Supabase")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
