-- Balance Sheet Line Items table
-- Run this in the Supabase SQL Editor before running import_balance_sheet.py

CREATE TABLE IF NOT EXISTS balance_sheet_lines (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    property_id bigint NOT NULL REFERENCES properties(id),
    as_of_date date NOT NULL,
    section text NOT NULL,          -- 'Assets', 'Liabilities', 'Capital'
    subsection text,                -- e.g. 'Cash' (nullable)
    account_name text NOT NULL,
    amount numeric DEFAULT 0,
    line_type text NOT NULL DEFAULT 'line_item',  -- 'line_item' or 'summary'
    import_batch text,
    created_at timestamptz DEFAULT now(),
    UNIQUE(property_id, as_of_date, account_name)
);

CREATE INDEX IF NOT EXISTS idx_bs_lines_property_date
    ON balance_sheet_lines(property_id, as_of_date);
CREATE INDEX IF NOT EXISTS idx_bs_lines_section
    ON balance_sheet_lines(section);
CREATE INDEX IF NOT EXISTS idx_bs_lines_batch
    ON balance_sheet_lines(import_batch);
