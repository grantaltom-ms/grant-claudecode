#!/usr/bin/env python3
"""
Refresh all materialized views in Supabase.

Usage:
    python3 refresh_views.py

Refreshes:
    - mv_annual_property_summary
    - mv_monthly_expenses_by_category
    - mv_portfolio_annual
"""

from db import get_client


VIEWS = [
    "mv_annual_property_summary",
    "mv_monthly_expenses_by_category",
    "mv_portfolio_annual",
]


def main():
    print("=== Refreshing Materialized Views ===\n")
    client = get_client()

    # Use the existing refresh_materialized_views() function
    print("Calling refresh_materialized_views()...")
    client.rpc("refresh_materialized_views").execute()

    # Verify each view has data
    for view in VIEWS:
        result = client.rpc("exec_sql", {
            "query": f"SELECT COUNT(*) as row_count FROM {view}"
        }).execute()
        data = result.data
        if isinstance(data, str):
            import json
            data = json.loads(data)
        count = data[0]["row_count"] if data else "?"
        print(f"  {view}: {count} rows")

    print("\nDone.")


if __name__ == "__main__":
    main()
