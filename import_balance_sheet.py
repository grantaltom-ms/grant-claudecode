#!/usr/bin/env python3
"""
Import AppFolio Balance Sheet CSV into Supabase.

Supports multi-property horizontal comparison format.

Usage:
    python3 import_balance_sheet.py <csv_file>
    python3 import_balance_sheet.py <csv_file> --date 2026-03-09

Steps:
    1. Parse CSV (detect properties, section hierarchy, amounts)
    2. Derive as_of_date from filename or --date flag
    3. Resolve property names → property_id
    4. Upsert summary totals into balance_sheets
    5. Insert line items into balance_sheet_lines
    6. Log import and refresh materialized views

Prerequisites:
    Create the balance_sheet_lines table by running create_balance_sheet_lines.sql
    in the Supabase SQL Editor.
"""

import csv
import sys
import re
import os
import json
import argparse
from datetime import datetime

from db import get_client

# Section headers — rows with these names and all-empty values set the current section
SECTION_MARKERS = {
    "ASSETS": "Assets",
    "Liabilities": "Liabilities",
    "Capital": "Capital",
}

# These top-level groupings are ignored (not a section themselves)
IGNORED_HEADERS = {"LIABILITIES & CAPITAL"}

# Subsection headers — rows with these names and all-empty values set the subsection
SUBSECTION_MARKERS = {"Cash"}

# Summary labels — rows captured as line_type='summary'
SUMMARY_LABELS = {
    "Total Cash",
    "TOTAL ASSETS",
    "Total Liabilities",
    "Total Capital",
    "TOTAL LIABILITIES & CAPITAL",
}

# Map account names (lowercase) to balance_sheets summary columns
SUMMARY_TO_COLUMN = {
    "total cash": "cash_and_equivalents",
    "total assets": "total_assets",
    "mortgage payable": "mortgage_balance",
    "total liabilities": "total_liabilities",
    "total capital": "total_equity",
}

# Receivable accounts to sum for balance_sheets.accounts_receivable
RECEIVABLE_ACCOUNTS = {
    "notes receivable",
    "other property receivable",
    "other receivables",
}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def clean_amount(val: str) -> float:
    """Strip $, commas, quotes, and whitespace. Handle parenthesized negatives."""
    if not val or not val.strip():
        return 0.0
    cleaned = val.replace("$", "").replace(",", "").replace('"', "").strip()
    if not cleaned or cleaned == "-":
        return 0.0
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = "-" + cleaned[1:-1]
    return float(cleaned)


def extract_date_from_filename(filepath: str):
    """Try to extract YYYYMMDD date from filename → YYYY-MM-DD."""
    basename = os.path.basename(filepath)
    match = re.search(r"(\d{4})(\d{2})(\d{2})", basename)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return None


def parse_balance_sheet(filepath, as_of_date):
    """
    Parse multi-property horizontal balance sheet CSV.

    Returns (line_items, summaries_by_property).
        line_items:  list of dicts for balance_sheet_lines
        summaries_by_property:  dict of property_name → {column: amount} for balance_sheets
    """
    line_items = []

    # First pass: read headers to get property names
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader)

    # First column is "Account Name", last is "Total"
    property_names = []
    for h in headers[1:]:
        h = h.strip()
        if h.lower() == "total" or not h:
            continue
        property_names.append(h)

    # Initialize summaries for each property
    summaries = {}
    for prop in property_names:
        summaries[prop] = {
            "cash_and_equivalents": 0,
            "accounts_receivable": 0,
            "total_assets": 0,
            "mortgage_balance": 0,
            "total_liabilities": 0,
            "total_equity": 0,
        }

    current_section = None
    current_subsection = None

    # Second pass: parse all data rows
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader)  # skip header

        for row in reader:
            if not row or not row[0].strip():
                continue

            account_name = row[0].strip()

            # Get values for each property column
            values = row[1:len(property_names) + 1] if len(row) > 1 else []
            all_empty = all(not v.strip() for v in values) if values else True

            # Skip ignored headers
            if account_name in IGNORED_HEADERS:
                continue

            # Section markers (no values = header row)
            if account_name in SECTION_MARKERS and all_empty:
                current_section = SECTION_MARKERS[account_name]
                current_subsection = None
                continue

            # Subsection markers (no values = grouping row)
            if account_name in SUBSECTION_MARKERS and all_empty:
                current_subsection = account_name
                continue

            # Skip any other empty rows
            if all_empty:
                continue

            # Determine line type
            is_summary = account_name in SUMMARY_LABELS
            line_type = "summary" if is_summary else "line_item"

            # Check if this row maps to a balance_sheets summary column
            name_lower = account_name.lower().strip()
            summary_col = SUMMARY_TO_COLUMN.get(name_lower)
            is_receivable = name_lower in RECEIVABLE_ACCOUNTS

            # Process each property's value
            for i, prop_name in enumerate(property_names):
                if i >= len(values):
                    continue

                amount = clean_amount(values[i])

                # Skip zero line items (keep zero summaries for completeness)
                if amount == 0.0 and line_type == "line_item":
                    continue

                line_items.append({
                    "property_name": prop_name,
                    "as_of_date": as_of_date,
                    "section": current_section or "Unknown",
                    "subsection": current_subsection,
                    "account_name": account_name,
                    "amount": amount,
                    "line_type": line_type,
                })

                # Update summary values for balance_sheets table
                if summary_col and prop_name in summaries:
                    summaries[prop_name][summary_col] = amount

                # Sum receivables for accounts_receivable
                if is_receivable and prop_name in summaries:
                    summaries[prop_name]["accounts_receivable"] += amount

            # Reset subsection after "Total" lines
            if account_name.startswith("Total ") and current_subsection:
                current_subsection = None

    return line_items, summaries


def build_property_map(client):
    """Build lowercase property name → UUID mapping."""
    result = client.table("properties").select("id, name").execute()
    return {p["name"].lower(): p["id"] for p in result.data}


def check_table_exists(client, table_name: str) -> bool:
    """Check if a table exists in the database."""
    query = ("SELECT EXISTS (SELECT FROM information_schema.tables "
             f"WHERE table_name = '{table_name}') as table_exists")
    result = client.rpc("exec_sql", {"query": query}).execute()
    data = result.data if result.data else []
    if isinstance(data, str):
        data = json.loads(data)
    if data and len(data) > 0:
        return data[0].get("table_exists", False)
    return False


def upload_balance_sheets(client, summaries, property_map, as_of_date, batch):
    """Upsert summary rows into balance_sheets. Returns (count, unmatched)."""
    rows = []
    unmatched = []

    for prop_name, cols in summaries.items():
        prop_id = property_map.get(prop_name.lower())
        if not prop_id:
            unmatched.append(prop_name)
            continue

        rows.append({
            "property_id": prop_id,
            "as_of_date": as_of_date,
            "import_batch": batch,
            **cols,
        })

    if not rows:
        return 0, unmatched

    # Upsert in chunks
    chunk_size = 500
    total = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        client.table("balance_sheets").upsert(
            chunk, on_conflict="property_id,as_of_date"
        ).execute()
        total += len(chunk)

    return total, unmatched


def upload_balance_sheet_lines(client, line_items, property_map, batch, as_of_date):
    """Insert line items into balance_sheet_lines. Returns count."""
    rows = []
    for item in line_items:
        prop_id = property_map.get(item["property_name"].lower())
        if not prop_id:
            continue  # already tracked as unmatched

        rows.append({
            "property_id": prop_id,
            "as_of_date": item["as_of_date"],
            "section": item["section"],
            "subsection": item["subsection"],
            "account_name": item["account_name"],
            "amount": item["amount"],
            "line_type": item["line_type"],
            "import_batch": batch,
        })

    if not rows:
        return 0

    # Delete existing rows for this date to allow clean re-import
    # (avoids orphan rows if accounts change between imports)
    client.table("balance_sheet_lines").delete().eq(
        "as_of_date", as_of_date
    ).execute()

    # Insert in chunks
    chunk_size = 500
    total = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        client.table("balance_sheet_lines").insert(chunk).execute()
        total += len(chunk)
        print(f"  Inserted {total}/{len(rows)} line items...")

    return total


def main():
    parser = argparse.ArgumentParser(description="Import AppFolio Balance Sheet CSV")
    parser.add_argument("csv_file", help="Path to the balance sheet CSV file")
    parser.add_argument("--date", help="As-of date (YYYY-MM-DD). Auto-detected from filename if omitted.")
    args = parser.parse_args()

    filepath = args.csv_file

    # Determine as_of_date
    as_of_date = args.date or extract_date_from_filename(filepath)
    if not as_of_date:
        print("Error: Could not determine as-of date from filename.")
        print("Use --date YYYY-MM-DD to specify it.")
        sys.exit(1)

    print(f"=== Balance Sheet Import ===")
    print(f"File: {filepath}")
    print(f"As-of date: {as_of_date}")

    # Step 1: Parse
    print("\n1. Parsing balance sheet CSV...")
    line_items, summaries = parse_balance_sheet(filepath, as_of_date)
    properties = list(summaries.keys())
    detail_items = [li for li in line_items if li["line_type"] == "line_item"]
    summary_items = [li for li in line_items if li["line_type"] == "summary"]

    print(f"   {len(properties)} properties found")
    print(f"   {len(detail_items)} detail line items")
    print(f"   {len(summary_items)} summary line items")

    if not line_items:
        print("   No rows to import. Exiting.")
        sys.exit(0)

    # Build batch name
    batch = f"bs-multi-{as_of_date}"
    print(f"   Batch: {batch}")

    # Step 2: Connect and build property map
    print("\n2. Connecting to Supabase...")
    client = get_client()

    print("\n3. Building property name → ID mapping...")
    property_map = build_property_map(client)
    print(f"   {len(property_map)} properties in database")

    # Step 3: Check if balance_sheet_lines table exists
    print("\n4. Checking prerequisites...")
    if not check_table_exists(client, "balance_sheet_lines"):
        print("   ❌ Table 'balance_sheet_lines' does not exist.")
        print("   Please run the following SQL in the Supabase SQL Editor:")
        print("   → create_balance_sheet_lines.sql")
        print("   Then re-run this script.")
        sys.exit(1)
    print("   ✅ balance_sheet_lines table exists")

    # Step 4: Upload summaries
    print("\n5. Upserting balance_sheets (summaries)...")
    summary_count, unmatched = upload_balance_sheets(
        client, summaries, property_map, as_of_date, batch
    )
    print(f"   {summary_count} summary rows upserted.")

    if unmatched:
        print(f"   ⚠️  {len(unmatched)} unmatched properties:")
        for name in unmatched:
            print(f"      - {name}")

    # Step 5: Upload line items
    print("\n6. Inserting balance_sheet_lines...")
    lines_count = upload_balance_sheet_lines(
        client, line_items, property_map, batch, as_of_date
    )
    print(f"   {lines_count} line items inserted.")

    # Step 6: Log import
    print("\n7. Logging import...")
    client.table("import_log").upsert({
        "batch_id": batch,
        "source_type": "balance_sheet",
        "source_file": filepath,
        "rows_imported": summary_count + lines_count,
        "rows_skipped": len(unmatched),
        "date_range_start": as_of_date,
        "date_range_end": as_of_date,
    }, on_conflict="batch_id").execute()

    # Step 7: Refresh views
    print("\n8. Refreshing materialized views...")
    client.rpc("refresh_materialized_views").execute()
    print("   Done.")

    # Summary
    print(f"\n{'='*40}")
    print(f"DONE: {summary_count} summaries + {lines_count} line items imported.")
    print(f"Batch: {batch}")
    if unmatched:
        print(f"WARNING: {len(unmatched)} unmatched properties: {', '.join(unmatched)}")
    print(f"{'='*40}")


if __name__ == "__main__":
    main()
