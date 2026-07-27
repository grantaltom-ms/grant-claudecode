// lib/supabase.js
// Shared Supabase client for this project's own database. The two backfill
// files that read from Milestone's separate property-management Supabase
// project (backfill-owner-investors.js, backfill-source-memory.js) keep their
// own client factories — that's an intentional cross-project connection, not
// duplication of this one.

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
