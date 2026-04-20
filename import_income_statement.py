#!/usr/bin/env python3
"""
Import AppFolio Income Statement CSV into Supabase.

Supports two formats:
  Format A: Single-property (vertical) — columns: Account Name, Selected Period, Account Number, GL Account ID
  Format B: Multi-property (horizontal) — columns: Account Name, Property1, Property2, ..., Total

Usage:
    python3 import_income_statement.py <csv_file> --year 2024
    python3 import_income_statement.py <csv_file> --start 2024-01-01 --end 2024-12-31

Steps:
    1. Detect format (single vs multi-property)
    2. Parse hierarchy (category/subcategory via indentation)
    3. Transform rows into normalized line items
    4. Push to is_import_staging
    5. Resolve into income_statement_lines and income_statement_summary
    6. Refresh materialized views
"""

import csv
import sys
import re
import argparse
from datetime import datetime

from db import get_client

# Section headers that set the current category
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

# Grouping headers that don't change the category (ignored)
IGNORED_SECTION_HEADERS = {
    "Operating Income & Expense",
    "Other Income & Expense",
}

# Summary lines to capture as line_type='summary'
SUMMARY_LABELS = {
    "Net Operating Income",
    "NOI",
    "NOI - Net Operating Income",
    "Net Income",
    "Net Income (Loss)",
    "Total Income",
    "Total Expense",
    "Total Operating Income",
    "Total Operating Expense",
    "Total Operating Expenses",
    "Total Other Income",
    "Total Other Expense",
    "Total Other Expenses",
    "Net Other Income",
}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def clean_amount(val: str) -> float:
    if not val or not val.strip():
        return 0.0
    cleaned = val.replace("$", "").replace(",", "").replace('"', "").strip()
    if not cleaned or cleaned == "-":
        return 0.0
    # Handle parentheses for negatives: (1,234.56) → -1234.56
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    return float(cleaned)


def get_indentation_level(line: str) -> int:
    """Count leading groups of 4 spaces."""
    stripped = line.lstrip(" ")
    leading = len(line) - len(stripped)
    return leading // 4


def is_non_posting(name: str) -> bool:
    return "(non-posting)" in name.lower()


def is_subtotal(name: str) -> bool:
    return name.strip().startswith("Total ")


def detect_format(headers: list[str]) -> str:
    """Detect whether this is Format A (single) or Format B (multi-property)."""
    normalized = [h.strip().lower() for h in headers]
    if "selected period" in normalized or "account number" in normalized:
        return "single"
    return "multi"


def parse_single_property(filepath: str, period_start: str, period_end: str,
                           property_name_override: str = None) -> list[dict]:
    """Parse Format A: single-property vertical income statement."""
    rows = []
    current_category = None
    current_subcategory = None

    with open(filepath, newline="", encoding="utf-8-sig") as f:
        # Read raw lines to preserve indentation
        raw_lines = f.readlines()

    if not raw_lines:
        return rows

    # Parse header
    header_line = raw_lines[0]
    headers = next(csv.reader([header_line]))

    for line in raw_lines[1:]:
        if not line.strip():
            continue

        indent_level = get_indentation_level(line)
        parsed = next(csv.reader([line.strip()]))

        if len(parsed) < 1:
            continue

        account_name = parsed[0].strip()
        if not account_name:
            continue

        # Skip ignored grouping headers
        if account_name in IGNORED_SECTION_HEADERS:
            continue

        # Check if this is a category header
        if account_name in CATEGORY_HEADERS:
            current_category = CATEGORY_HEADERS[account_name]
            current_subcategory = None
            continue

        # Check for summary lines
        if account_name in SUMMARY_LABELS:
            amount = clean_amount(parsed[1]) if len(parsed) > 1 else 0.0
            account_number = parsed[2].strip() if len(parsed) > 2 else None
            rows.append({
                "property_name": property_name_override or "Unknown",
                "period_start": period_start,
                "period_end": period_end,
                "account_name": account_name,
                "account_number": account_number,
                "amount": amount,
                "category": current_category,
                "subcategory": None,
                "line_type": "summary",
            })
            continue

        # Skip subtotal rows
        if is_subtotal(account_name):
            continue

        # Non-posting parent → sets subcategory
        if is_non_posting(account_name):
            current_subcategory = account_name.replace("(non-posting)", "").strip()
            continue

        # Regular line item
        amount = clean_amount(parsed[1]) if len(parsed) > 1 else 0.0
        account_number = parsed[2].strip() if len(parsed) > 2 else None

        if amount == 0.0:
            continue

        rows.append({
            "property_name": property_name_override or "Unknown",
            "period_start": period_start,
            "period_end": period_end,
            "account_name": account_name,
            "account_number": account_number,
            "amount": amount,
            "category": current_category,
            "subcategory": current_subcategory,
            "line_type": "line_item",
        })

    return rows


def parse_multi_property(filepath: str, period_start: str, period_end: str) -> list[dict]:
    """Parse Format B: multi-property horizontal income statement."""
    rows = []
    current_category = None
    current_subcategory = None

    with open(filepath, newline="", encoding="utf-8-sig") as f:
        raw_lines = f.readlines()

    if not raw_lines:
        return rows

    # Parse header to get property names
    headers = next(csv.reader([raw_lines[0]]))
    # First column is "Account Name", last is usually "Total"
    # Everything in between is property names
    property_names = []
    for h in headers[1:]:
        h = h.strip()
        if h.lower() == "total" or not h:
            continue
        property_names.append(h)

    for line in raw_lines[1:]:
        if not line.strip():
            continue

        indent_level = get_indentation_level(line)
        parsed = next(csv.reader([line.strip()]))

        if len(parsed) < 1:
            continue

        account_name = parsed[0].strip()
        if not account_name:
            continue

        # Skip ignored grouping headers
        if account_name in IGNORED_SECTION_HEADERS:
            continue

        # Check category header
        if account_name in CATEGORY_HEADERS:
            current_category = CATEGORY_HEADERS[account_name]
            current_subcategory = None
            continue

        # Summary lines
        is_summary = account_name in SUMMARY_LABELS
        if is_subtotal(account_name) and not is_summary:
            continue

        # Non-posting parent
        if is_non_posting(account_name):
            current_subcategory = account_name.replace("(non-posting)", "").strip()
            continue

        line_type = "summary" if is_summary else "line_item"

        # Extract amount for each property
        for i, prop_name in enumerate(property_names):
            col_idx = i + 1  # offset past Account Name column
            if col_idx >= len(parsed):
                continue

            amount = clean_amount(parsed[col_idx])
            if amount == 0.0 and line_type == "line_item":
                continue

            # Try to extract account number — multi-property format usually doesn't have one
            # in a separate column, so we leave it None
            rows.append({
                "property_name": prop_name,
                "period_start": period_start,
                "period_end": period_end,
                "account_name": account_name,
                "account_number": None,
                "amount": amount,
                "category": current_category,
                "subcategory": current_subcategory,
                "line_type": line_type,
            })

    return rows


def upload_staging(client, rows: list[dict], batch: str) -> int:
    """Upload rows to is_import_staging."""
    # Add import_batch
    for row in rows:
        row["import_batch"] = batch

    # Clear previous batch
    client.table("is_import_staging").delete().eq("import_batch", batch).execute()

    chunk_size = 500
    total = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        client.table("is_import_staging").insert(chunk).execute()
        total += len(chunk)
        print(f"  Uploaded {total}/{len(rows)} rows to staging...")

    return total


def resolve_line_items(client, batch: str) -> int:
    """Resolve staging → income_statement_lines via FK join."""
    query = (
        "SELECT p.id as property_id, s.period_start, s.period_end, "
        "s.account_name, s.account_number, s.amount, s.category, "
        "s.subcategory, s.line_type, s.import_batch "
        "FROM is_import_staging s "
        "JOIN properties p ON LOWER(p.name) = LOWER(s.property_name) "
        f"WHERE s.import_batch = '{batch}' AND s.line_type = 'line_item'"
    )

    result = client.rpc("exec_sql", {"query": query}).execute()
    resolved = result.data if result.data else []

    if isinstance(resolved, str):
        import json
        resolved = json.loads(resolved)

    if not resolved:
        return 0

    # Upsert into income_statement_lines
    chunk_size = 500
    inserted = 0
    for i in range(0, len(resolved), chunk_size):
        chunk = resolved[i : i + chunk_size]
        client.table("income_statement_lines").upsert(
            chunk,
            on_conflict="property_id,period_start,account_number,line_type"
        ).execute()
        inserted += len(chunk)
        print(f"  Upserted {inserted}/{len(resolved)} line items...")

    return inserted


def resolve_summaries(client, batch: str) -> int:
    """Build income_statement_summary from summary rows in staging."""
    query = (
        "SELECT p.id as property_id, s.period_start, s.period_end, "
        "s.account_name, s.amount "
        "FROM is_import_staging s "
        "JOIN properties p ON LOWER(p.name) = LOWER(s.property_name) "
        f"WHERE s.import_batch = '{batch}' AND s.line_type = 'summary'"
    )

    result = client.rpc("exec_sql", {"query": query}).execute()
    resolved = result.data if result.data else []

    if isinstance(resolved, str):
        import json
        resolved = json.loads(resolved)

    if not resolved:
        return 0

    # Group by property_id + period_start to build summary rows
    summaries = {}
    for row in resolved:
        key = (row["property_id"], row["period_start"], row.get("period_end"))
        if key not in summaries:
            summaries[key] = {
                "property_id": row["property_id"],
                "period_start": row["period_start"],
                "period_end": row.get("period_end"),
                "total_operating_income": 0,
                "total_operating_expense": 0,
                "noi": 0,
                "total_other_income": 0,
                "total_other_expense": 0,
                "net_income": 0,
                "import_batch": batch,
            }
        name = row["account_name"].lower().strip()
        amt = row["amount"] or 0

        if "total operating income" in name:
            summaries[key]["total_operating_income"] = amt
        elif "total operating expense" in name:
            summaries[key]["total_operating_expense"] = amt
        elif name in ("net operating income", "noi", "noi - net operating income"):
            summaries[key]["noi"] = amt
        elif "total other income" in name:
            summaries[key]["total_other_income"] = amt
        elif "total other expense" in name:
            summaries[key]["total_other_expense"] = amt
        elif name in ("net income", "net income (loss)"):
            summaries[key]["net_income"] = amt

    summary_rows = list(summaries.values())
    if not summary_rows:
        return 0

    client.table("income_statement_summary").upsert(
        summary_rows,
        on_conflict="property_id,period_start"
    ).execute()

    return len(summary_rows)


def check_unmatched(client, batch: str) -> list[str]:
    """Find staging property names that didn't match any property."""
    query = (
        "SELECT DISTINCT s.property_name "
        "FROM is_import_staging s "
        "LEFT JOIN properties p ON LOWER(p.name) = LOWER(s.property_name) "
        f"WHERE s.import_batch = '{batch}' AND p.id IS NULL"
    )
    result = client.rpc("exec_sql", {"query": query}).execute()
    data = result.data if result.data else []
    if isinstance(data, str):
        import json
        data = json.loads(data)
    return [r["property_name"] for r in data]


def main():
    parser = argparse.ArgumentParser(description="Import AppFolio Income Statement CSV")
    parser.add_argument("csv_file", help="Path to the CSV file")
    parser.add_argument("--year", type=int, help="Report year (sets period to full year)")
    parser.add_argument("--start", help="Period start date (YYYY-MM-DD)")
    parser.add_argument("--end", help="Period end date (YYYY-MM-DD)")
    parser.add_argument("--property", help="Property name override (for single-property format)")
    args = parser.parse_args()

    if args.year:
        period_start = f"{args.year}-01-01"
        period_end = f"{args.year}-12-31"
    elif args.start and args.end:
        period_start = args.start
        period_end = args.end
    else:
        print("Error: Provide either --year or both --start and --end")
        sys.exit(1)

    filepath = args.csv_file
    print(f"=== Income Statement Import ===")
    print(f"File: {filepath}")
    print(f"Period: {period_start} to {period_end}")

    # Step 1: Detect format and parse
    print("\n1. Detecting format and parsing...")
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        headers = next(csv.reader(f))

    fmt = detect_format(headers)
    print(f"   Format detected: {'single-property' if fmt == 'single' else 'multi-property'}")

    if fmt == "single":
        rows = parse_single_property(filepath, period_start, period_end, args.property)
    else:
        rows = parse_multi_property(filepath, period_start, period_end)

    line_items = [r for r in rows if r["line_type"] == "line_item"]
    summary_items = [r for r in rows if r["line_type"] == "summary"]
    properties = set(r["property_name"] for r in rows)

    print(f"   {len(line_items)} line items, {len(summary_items)} summary rows")
    print(f"   Properties: {len(properties)}")

    if not rows:
        print("   No rows to import. Exiting.")
        sys.exit(0)

    # Build batch name
    prop_slug = slugify(sorted(properties)[0]) if len(properties) == 1 else "multi"
    year_part = period_start[:4]
    batch = f"is-{prop_slug}-{year_part}"
    print(f"   Batch: {batch}")

    # Step 2: Connect and upload
    print("\n2. Connecting to Supabase...")
    client = get_client()

    print("\n3. Uploading to is_import_staging...")
    staging_count = upload_staging(client, rows, batch)
    print(f"   {staging_count} rows in staging.")

    # Step 3: Resolve line items
    print("\n4. Resolving line items → income_statement_lines...")
    lines_inserted = resolve_line_items(client, batch)
    print(f"   {lines_inserted} line items upserted.")

    # Step 4: Resolve summaries
    print("\n5. Building income_statement_summary...")
    summaries_inserted = resolve_summaries(client, batch)
    print(f"   {summaries_inserted} summary rows upserted.")

    # Step 5: Check for unmatched properties
    unmatched = check_unmatched(client, batch)
    if unmatched:
        print(f"\n   ⚠️  Unmatched properties: {', '.join(unmatched)}")

    # Step 6: Log and refresh
    print("\n6. Logging import...")
    client.table("import_log").upsert({
        "batch_id": batch,
        "source_type": "income_statement",
        "source_file": filepath,
        "rows_imported": lines_inserted + summaries_inserted,
        "rows_skipped": len(unmatched),
        "date_range_start": period_start,
        "date_range_end": period_end,
    }, on_conflict="batch_id").execute()

    print("\n7. Refreshing materialized views...")
    client.rpc("refresh_materialized_views").execute()
    print("   Done.")

    # Summary
    print(f"\n{'='*40}")
    print(f"DONE: {lines_inserted} line items + {summaries_inserted} summaries imported.")
    print(f"Batch: {batch}")
    if unmatched:
        print(f"WARNING: Unmatched properties: {', '.join(unmatched)}")
    print(f"{'='*40}")


if __name__ == "__main__":
    main()
