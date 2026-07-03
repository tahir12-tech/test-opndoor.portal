alter table public.applications
  add column if not exists deed_viewed_at timestamptz;
