#!/usr/bin/env python3
"""
Audit data quality in the Milestone Properties database.

Usage:
    python3 audit_data.py

Checks:
    1. Unmatched GL staging rows (property or account mismatch)
    2. Unmatched IS staging rows (property mismatch)
    3. Properties with no GL transactions
    4. Duplicate GL transactions
    5. Income statement coverage gaps
    6. Transaction date range per property
    7. Table row counts
    8. Balance sheet coverage
    9. Balance sheet equation check (Assets = Liabilities + Capital)
   10. Balance sheet lines vs summary cross-check
"""

import json
from db import get_client


def run_query(client, query: str) -> list[dict]:
    """Run a SELECT query via exec_sql. Query must start with SELECT or WITH."""
    # exec_sql requires the query to start with SELECT/WITH — strip whitespace
    clean = query.strip()
    result = client.rpc("exec_sql", {"query": clean}).execute()
    data = result.data if result.data else []
    if isinstance(data, str):
        data = json.loads(data)
    return data


def check_unmatched_gl_staging(client):
    """GL staging rows where property_name doesn't match any property."""
    print("\n1. Unmatched GL staging rows (property name mismatch):")
    rows = run_query(client,
        "SELECT s.property_name, COUNT(*) as row_count "
        "FROM gl_import_staging s "
        "LEFT JOIN properties p ON LOWER(p.name) = LOWER(s.property_name) "
        "WHERE p.id IS NULL "
        "GROUP BY s.property_name "
        "ORDER BY row_count DESC"
    )
    if not rows:
        print("   ✅ None — all staging property names matched.")
    else:
        for r in rows:
            print(f"   ❌ '{r['property_name']}' — {r['row_count']} rows")

    print("\n2. Unmatched GL staging rows (account number mismatch):")
    rows = run_query(client,
        "SELECT s.account_number, COUNT(*) as row_count "
        "FROM gl_import_staging s "
        "LEFT JOIN gl_accounts ga ON ga.account_number = s.account_number "
        "WHERE ga.id IS NULL "
        "GROUP BY s.account_number "
        "ORDER BY row_count DESC"
    )
    if not rows:
        print("   ✅ None — all staging account numbers matched.")
    else:
        for r in rows:
            print(f"   ❌ Account '{r['account_number']}' — {r['row_count']} rows")


def check_unmatched_is_staging(client):
    """IS staging rows where property_name doesn't match."""
    print("\n3. Unmatched IS staging rows (property name mismatch):")
    rows = run_query(client,
        "SELECT s.property_name, COUNT(*) as row_count "
        "FROM is_import_staging s "
        "LEFT JOIN properties p ON LOWER(p.name) = LOWER(s.property_name) "
        "WHERE p.id IS NULL "
        "GROUP BY s.property_name "
        "ORDER BY row_count DESC"
    )
    if not rows:
        print("   ✅ None — all IS staging property names matched.")
    else:
        for r in rows:
            print(f"   ❌ '{r['property_name']}' — {r['row_count']} rows")


def check_properties_without_gl(client):
    """Properties that have zero GL transactions."""
    print("\n4. Properties with NO GL transactions:")
    rows = run_query(client,
        "SELECT p.name "
        "FROM properties p "
        "LEFT JOIN gl_transactions g ON g.property_id = p.id "
        "WHERE g.id IS NULL "
        "ORDER BY p.name"
    )
    if not rows:
        print("   ✅ All properties have GL data.")
    else:
        print(f"   ⚠️  {len(rows)} properties missing GL data:")
        for r in rows:
            print(f"      - {r['name']}")


def check_duplicate_gl(client):
    """Check for potential duplicate GL transactions."""
    print("\n5. Potential duplicate GL transactions:")
    rows = run_query(client,
        "SELECT property_id, gl_account_id, transaction_date::text, description, "
        "debit, credit, COUNT(*) as dup_count "
        "FROM gl_transactions "
        "GROUP BY property_id, gl_account_id, transaction_date, description, debit, credit "
        "HAVING COUNT(*) > 1 "
        "ORDER BY dup_count DESC "
        "LIMIT 20"
    )
    if not rows:
        print("   ✅ No duplicates detected.")
    else:
        print(f"   ⚠️  {len(rows)} potential duplicate groups (showing top 20):")
        for r in rows:
            print(f"      {r['transaction_date']} | debit={r['debit']} credit={r['credit']} | {r['dup_count']}x")


def check_is_coverage(client):
    """Check income statement coverage by year."""
    print("\n6. Income statement coverage:")
    rows = run_query(client,
        "SELECT EXTRACT(YEAR FROM period_start)::int as year, "
        "COUNT(DISTINCT property_id) as properties_covered, "
        "COUNT(*) as total_lines "
        "FROM income_statement_lines "
        "GROUP BY EXTRACT(YEAR FROM period_start) "
        "ORDER BY year"
    )
    if not rows:
        print("   ⚠️  No income statement data found.")
    else:
        for r in rows:
            print(f"   {r['year']}: {r['properties_covered']} properties, {r['total_lines']} line items")


def check_gl_date_ranges(client):
    """Show GL transaction date range per property."""
    print("\n7. GL transaction date ranges by property:")
    rows = run_query(client,
        "SELECT p.name, MIN(g.transaction_date)::text as earliest, "
        "MAX(g.transaction_date)::text as latest, COUNT(*) as txn_count "
        "FROM gl_transactions g "
        "JOIN properties p ON p.id = g.property_id "
        "GROUP BY p.name "
        "ORDER BY p.name"
    )
    if not rows:
        print("   ⚠️  No GL transactions found.")
    else:
        for r in rows:
            print(f"   {r['name']}: {r['earliest']} → {r['latest']} ({r['txn_count']} txns)")


def check_row_counts(client):
    """Overall row counts for key tables."""
    print("\n8. Table row counts:")
    tables = [
        "properties", "gl_accounts", "gl_transactions",
        "income_statement_lines", "income_statement_summary",
        "balance_sheets", "balance_sheet_lines",
        "gl_import_staging", "is_import_staging",
        "import_log",
    ]
    for table in tables:
        rows = run_query(client, f"SELECT COUNT(*) as cnt FROM {table}")
        count = rows[0]["cnt"] if rows else "?"
        print(f"   {table}: {count}")


def check_bs_coverage(client):
    """Check balance sheet coverage by date."""
    print("\n9. Balance sheet coverage:")
    rows = run_query(client,
        "SELECT bs.as_of_date::text, "
        "COUNT(DISTINCT bs.property_id) as properties_covered, "
        "COUNT(*) as summary_rows "
        "FROM balance_sheets bs "
        "GROUP BY bs.as_of_date "
        "ORDER BY bs.as_of_date"
    )
    if not rows:
        print("   ⚠️  No balance sheet data found.")
    else:
        for r in rows:
            print(f"   {r['as_of_date']}: {r['properties_covered']} properties, "
                  f"{r['summary_rows']} summary rows")

    rows2 = run_query(client,
        "SELECT bsl.as_of_date::text, "
        "COUNT(DISTINCT bsl.property_id) as properties_covered, "
        "COUNT(*) as line_count "
        "FROM balance_sheet_lines bsl "
        "GROUP BY bsl.as_of_date "
        "ORDER BY bsl.as_of_date"
    )
    if rows2:
        for r in rows2:
            print(f"   Line items: {r['as_of_date']}: {r['properties_covered']} properties, "
                  f"{r['line_count']} lines")


def check_bs_equation(client):
    """Verify Assets = Liabilities + Equity for each property."""
    print("\n10. Balance sheet equation check (Assets = Liabilities + Equity):")
    rows = run_query(client,
        "SELECT p.name, bs.as_of_date::text, "
        "bs.total_assets, bs.total_liabilities, bs.total_equity, "
        "bs.total_assets - (bs.total_liabilities + bs.total_equity) as diff "
        "FROM balance_sheets bs "
        "JOIN properties p ON p.id = bs.property_id "
        "WHERE ABS(bs.total_assets - (bs.total_liabilities + bs.total_equity)) > 0.01 "
        "ORDER BY ABS(bs.total_assets - (bs.total_liabilities + bs.total_equity)) DESC "
        "LIMIT 20"
    )
    if not rows:
        print("   ✅ All properties balance (Assets = Liabilities + Equity).")
    else:
        print(f"   ❌ {len(rows)} properties out of balance:")
        for r in rows:
            print(f"      {r['name']} ({r['as_of_date']}): "
                  f"Assets={r['total_assets']} vs L+E={r['total_liabilities']}+{r['total_equity']} "
                  f"diff={r['diff']}")


def check_bs_lines_vs_summary(client):
    """Cross-check line item totals vs summary table."""
    print("\n11. Balance sheet lines vs summary cross-check:")
    rows = run_query(client,
        "SELECT p.name, bsl.as_of_date::text, "
        "SUM(CASE WHEN bsl.account_name = 'TOTAL ASSETS' THEN bsl.amount ELSE 0 END) as lines_total_assets, "
        "bs.total_assets as summary_total_assets, "
        "SUM(CASE WHEN bsl.account_name = 'TOTAL ASSETS' THEN bsl.amount ELSE 0 END) - bs.total_assets as diff "
        "FROM balance_sheet_lines bsl "
        "JOIN properties p ON p.id = bsl.property_id "
        "JOIN balance_sheets bs ON bs.property_id = bsl.property_id AND bs.as_of_date = bsl.as_of_date "
        "GROUP BY p.name, bsl.as_of_date, bs.total_assets "
        "HAVING ABS(SUM(CASE WHEN bsl.account_name = 'TOTAL ASSETS' THEN bsl.amount ELSE 0 END) - bs.total_assets) > 0.01 "
        "ORDER BY ABS(SUM(CASE WHEN bsl.account_name = 'TOTAL ASSETS' THEN bsl.amount ELSE 0 END) - bs.total_assets) DESC "
        "LIMIT 10"
    )
    if not rows:
        print("   ✅ Line items match summary totals.")
    else:
        print(f"   ❌ {len(rows)} mismatches found:")
        for r in rows:
            print(f"      {r['name']} ({r['as_of_date']}): "
                  f"lines={r['lines_total_assets']} summary={r['summary_total_assets']} diff={r['diff']}")


def main():
    print("=== Milestone Properties Data Audit ===")
    client = get_client()

    check_row_counts(client)
    check_unmatched_gl_staging(client)
    check_unmatched_is_staging(client)
    check_properties_without_gl(client)
    check_duplicate_gl(client)
    check_is_coverage(client)
    check_gl_date_ranges(client)
    check_bs_coverage(client)
    check_bs_equation(client)
    check_bs_lines_vs_summary(client)

    print(f"\n{'='*40}")
    print("Audit complete.")
    print(f"{'='*40}")


if __name__ == "__main__":
    main()
