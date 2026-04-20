"""Shared Supabase client initialization."""

import os
import sys
from supabase import create_client, Client


def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print("Error: SUPABASE_URL and SUPABASE_KEY environment variables required.")
        sys.exit(1)
    return create_client(url, key)
