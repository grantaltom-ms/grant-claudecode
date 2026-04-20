#!/usr/bin/env python3
"""
Import AppFolio GL export CSV into Supabase.

Usage:
    python3 import_gl.py /path/to/appfolio_gl_export.csv

Steps:
    1. Read and transform CSV (date format, amount cleaning, column mapping)
    2. Push rows to gl_import_staging via Supabase API
    3. Run FK resolution INSERT into gl_transactions
    4. Report row counts and any unmatched rows
    5. Refresh materialized views
"""

import csv
import sys
import re
from datetime import datetime

from db import get_client

# Rows starting with these values in the first column are skipped
SKIP_PREFIXES = {"Starting Balance", "Net Change", "Total"}


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def clean_amount(val: str) -> float:
    """Strip $, commas, and whitespace. Blank/missing → 0."""
    if not val or not val.strip():
        return 0.0
    cleaned = val.replace("$", "").replace(",", "").replace('"', "").strip()
    if not cleaned:
        return 0.0
    return float(cleaned)


def parse_date(val: str) -> str:
    """Convert MM/DD/YYYY → YYYY-MM-DD."""
    return datetime.strptime(val.strip(), "%m/%d/%Y").strftime("%Y-%m-%d")


def extract_account_number(gl_account: str) -> str:
    """'4101 - Rental Charges' → '4101'"""
    return gl_account.split(" - ")[0].strip()


def should_skip(row: dict) -> bool:
    first_val = (list(row.values())[0] or "").strip()
    if not first_val:
        return True
    for prefix in SKIP_PREFIXES:
        if first_val.startswith(prefix):
            return True
    return False


def extract_property_name(property_field: str) -> str:
    """Extract property name from 'PropertyName - Address' format.
    e.g. 'Prospect Manor - 1100 5th Ave N Seattle, WA 98109' → 'Prospect Manor'
    """
    if " - " in property_field:
        return property_field.split(" - ", 1)[0].strip()
    return property_field.strip()


def detect_gl_format(headers):
    """Detect CSV format. Returns 'grouped' if account is in group rows, 'flat' if column."""
    normalized = [h.strip().lower() for h in headers]
    if "gl account" in normalized:
        return "flat"
    if "group" in normalized:
        return "grouped"
    return "flat"


def transform_csv(filepath: str):
    """Read AppFolio GL CSV, return (transformed_rows, import_batch)."""
    rows = []
    property_names = set()
    years = set()

    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader)
        fmt = detect_gl_format(headers)

    if fmt == "grouped":
        rows, property_names, years = transform_grouped_csv(filepath)
    else:
        rows, property_names, years = transform_flat_csv(filepath)

    # Build import_batch from most common property + year range
    if property_names and years:
        prop_slug = slugify(sorted(property_names)[0])
        year_part = "-".join(sorted(years))
        batch = f"gl-{prop_slug}-{year_part}"
    else:
        batch = f"gl-import-{datetime.now().strftime('%Y%m%d%H%M%S')}"

    for row in rows:
        row["import_batch"] = batch

    return rows, batch


def transform_grouped_csv(filepath: str):
    """Parse grouped GL format where account is in '-> ACCT - Name' header rows."""
    rows = []
    property_names = set()
    years = set()
    current_account_number = None

    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            group_val = (raw.get("Group") or "").strip()

            # Group header row: -> 1000 - Operating
            if group_val.startswith("->"):
                acct_str = group_val[2:].strip()  # remove '->'
                current_account_number = extract_account_number(acct_str)
                continue

            # Skip Starting Balance, Net Change, Total rows
            property_field = (raw.get("Property") or "").strip()
            if not property_field:
                continue
            if any(property_field.startswith(p) for p in SKIP_PREFIXES):
                continue

            date_str = (raw.get("Date") or "").strip()
            if not date_str or not current_account_number:
                continue

            property_name = extract_property_name(property_field)
            transaction_date = parse_date(date_str)

            row = {
                "transaction_date": transaction_date,
                "property_name": property_name,
                "account_number": current_account_number,
                "description": (raw.get("Description") or "").strip(),
                "debit": clean_amount(raw.get("Debit", "")),
                "credit": clean_amount(raw.get("Credit", "")),
                "transaction_type": (raw.get("Type") or "").strip(),
                "reference": (raw.get("Reference") or "").strip(),
                "vendor": (raw.get("Payee / Payer") or "").strip(),
                "unit_number": None,
            }

            property_names.add(property_name)
            years.add(transaction_date[:4])
            rows.append(row)

    return rows, property_names, years


def transform_flat_csv(filepath: str):
    """Parse flat GL format where GL Account is a column."""
    rows = []
    property_names = set()
    years = set()

    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            if should_skip(raw):
                continue

            property_name = (raw.get("Property Name") or "").strip()
            date_str = (raw.get("Date") or "").strip()
            gl_account = (raw.get("GL Account") or "").strip()

            if not date_str or not gl_account:
                continue

            transaction_date = parse_date(date_str)
            account_number = extract_account_number(gl_account)

            row = {
                "transaction_date": transaction_date,
                "property_name": property_name,
                "account_number": account_number,
                "description": (raw.get("Description") or "").strip(),
                "debit": clean_amount(raw.get("Debit", "")),
                "credit": clean_amount(raw.get("Credit", "")),
                "transaction_type": (raw.get("Type") or "").strip(),
                "reference": (raw.get("Reference") or "").strip(),
                "vendor": (raw.get("Payee / Payer") or "").strip(),
                "unit_number": (raw.get("Unit") or "").strip() or None,
            }

            property_names.add(property_name)
            years.add(transaction_date[:4])
            rows.append(row)

    return rows, property_names, years


def upload_staging(client, rows: list[dict], batch: str) -> int:
    """Upload rows to gl_import_staging. Returns count inserted."""
    # Delete any existing rows for this batch to allow re-runs
    client.table("gl_import_staging").delete().eq("import_batch", batch).execute()

    # Insert in chunks of 500 (Supabase API limit)
    chunk_size = 500
    total = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        client.table("gl_import_staging").insert(chunk).execute()
        total += len(chunk)
        print(f"  Uploaded {total}/{len(rows)} rows to staging...")

    return total


def resolve_fkeys_and_count(client, batch: str) -> tuple[int, int]:
    """
    Resolve FKs from staging → gl_transactions.
    Returns (rows_inserted, unmatched_count).
    Uses Supabase RPC for the INSERT and counts via REST API.
    """
    # Count staging rows for this batch
    staging_result = (
        client.table("gl_import_staging")
        .select("*", count="exact")
        .eq("import_batch", batch)
        .limit(0)
        .execute()
    )
    staging_count = staging_result.count

    # Count gl_transactions BEFORE insert
    before_result = (
        client.table("gl_transactions")
        .select("*", count="exact")
        .eq("import_batch", batch)
        .limit(0)
        .execute()
    )
    before_count = before_result.count or 0

    # Delete existing rows for this batch (allow re-import)
    if before_count > 0:
        client.table("gl_transactions").delete().eq("import_batch", batch).execute()

    # Run the FK resolution via exec_sql — we need to use a function or direct SQL
    # Since exec_sql only allows SELECT, we'll use the postgrest RPC with a custom approach
    # Build the insert via the Supabase client by selecting matching rows and inserting
    fk_query = (
        "SELECT p.id as property_id, ga.id as gl_account_id, "
        "s.transaction_date::text as transaction_date, s.description, "
        "s.debit, s.credit, s.transaction_type, s.reference, s.vendor, "
        "s.import_batch "
        "FROM gl_import_staging s "
        "JOIN properties p ON LOWER(p.name) = LOWER(s.property_name) "
        "JOIN gl_accounts ga ON ga.account_number = s.account_number "
        f"WHERE s.import_batch = '{batch}'"
    )

    resolved = client.rpc("exec_sql", {"query": fk_query}).execute()
    resolved_rows = resolved.data if resolved.data else []

    if isinstance(resolved_rows, str):
        import json
        resolved_rows = json.loads(resolved_rows)

    if not resolved_rows:
        return 0, staging_count

    # Insert resolved rows into gl_transactions in chunks
    chunk_size = 500
    inserted = 0
    for i in range(0, len(resolved_rows), chunk_size):
        chunk = resolved_rows[i : i + chunk_size]
        # Clean up the rows for insert
        for row in chunk:
            row.pop("id", None)
        client.table("gl_transactions").insert(chunk).execute()
        inserted += len(chunk)
        print(f"  Inserted {inserted}/{len(resolved_rows)} into gl_transactions...")

    unmatched = staging_count - len(resolved_rows)
    return len(resolved_rows), unmatched


def log_import(client, batch: str, source_file: str, rows_imported: int, rows_skipped: int,
               date_start: str, date_end: str, property_id=None):
    """Log the import to import_log."""
    client.table("import_log").upsert({
        "batch_id": batch,
        "source_type": "gl_transactions",
        "source_file": source_file,
        "property_id": property_id,
        "rows_imported": rows_imported,
        "rows_skipped": rows_skipped,
        "date_range_start": date_start,
        "date_range_end": date_end,
    }, on_conflict="batch_id").execute()


def refresh_views(client):
    """Refresh materialized views."""
    client.rpc("refresh_materialized_views").execute()
    print("  Materialized views refreshed.")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 import_gl.py <csv_file>")
        sys.exit(1)

    filepath = sys.argv[1]
    print(f"=== GL Transaction Import ===")
    print(f"File: {filepath}")

    # Step 1: Transform
    print("\n1. Transforming CSV...")
    rows, batch = transform_csv(filepath)
    print(f"   {len(rows)} rows transformed. Batch: {batch}")

    if not rows:
        print("   No rows to import. Exiting.")
        sys.exit(0)

    # Date range for logging
    dates = sorted(r["transaction_date"] for r in rows)
    date_start, date_end = dates[0], dates[-1]
    print(f"   Date range: {date_start} to {date_end}")

    # Step 2: Connect and upload to staging
    print("\n2. Connecting to Supabase...")
    client = get_client()

    print("\n3. Uploading to gl_import_staging...")
    staging_count = upload_staging(client, rows, batch)
    print(f"   {staging_count} rows in staging.")

    # Step 3: FK resolution
    print("\n4. Resolving foreign keys → gl_transactions...")
    inserted, unmatched = resolve_fkeys_and_count(client, batch)
    print(f"   {inserted} rows inserted into gl_transactions.")

    if unmatched > 0:
        print(f"   ⚠️  {unmatched} staging rows did NOT match (property or account mismatch).")
        print("   Run: python3 audit_data.py  to see details.")

    # Step 4: Log import
    print("\n5. Logging import...")
    log_import(client, batch, filepath, inserted, unmatched, date_start, date_end)

    # Step 5: Refresh views
    print("\n6. Refreshing materialized views...")
    refresh_views(client)

    # Summary
    print(f"\n{'='*40}")
    print(f"DONE: {inserted} GL transactions imported.")
    print(f"Batch: {batch}")
    if unmatched > 0:
        print(f"WARNING: {unmatched} rows unmatched — check audit_data.py")
    print(f"{'='*40}")


if __name__ == "__main__":
    main()
