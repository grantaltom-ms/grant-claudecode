-- start_time/end_time carry a Graph event's dateTime half of a
-- {dateTime, timeZone} pair -- a *local wall-clock* string that is only
-- meaningful together with the separate time_zone column, exactly like
-- Microsoft Graph's own event create/update payload shape.
--
-- timestamptz was the wrong type for that: writing a naive string like
-- '2026-09-04T07:00:00' into a timestamptz column silently reinterprets
-- it as UTC (Postgres has no way to know it means 7am in time_zone), so
-- the zone was lost at write time. On read, that corrupted instant came
-- back as e.g. '2026-09-04T07:00:00+00:00' and got forwarded to Graph
-- as-is -- which created the event at 7:00 AM UTC (midnight Pacific)
-- instead of 7:00 AM Pacific as the user actually asked for.
--
-- Storing these as plain text preserves the wall-clock string exactly as
-- given, with no reinterpretation, matching what Graph itself expects.
alter table public.calendar_event_drafts
  alter column start_time type text using start_time::text,
  alter column end_time type text using end_time::text;
