-- Run this in Supabase SQL Editor

create table trust_cache (
  address text primary key,
  score float not null,
  trusted boolean not null,
  composite jsonb not null,
  signals jsonb not null,
  sources text[] not null,
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  pass_count integer not null default 0,
  dispute_count integer not null default 0
);

alter table trust_cache enable row level security;
create policy "allow anon all" on trust_cache for all to anon using (true) with check (true);

-- Update checks totals to include cache stats
create or replace function get_check_totals()
returns json language sql stable as $$
  select json_build_object(
    'total_checks', (select count(*) from checks),
    'trusted_count', (select count(*) from checks where trusted),
    'unique_addresses', (select count(*) from trust_cache),
    'avg_score', (select coalesce(round(avg(score)::numeric, 1), 0) from checks)
  );
$$;

-- Cache stats RPC
create or replace function get_cache_stats()
returns json language sql stable as $$
  select json_build_object(
    'cached_addresses', count(*),
    'active_cache', count(*) filter (where expires_at > now()),
    'expired_cache', count(*) filter (where expires_at <= now()),
    'top_trusted', (
      select coalesce(json_agg(t), '[]'::json) from (
        select address, score, pass_count
        from trust_cache
        where pass_count > 0
        order by pass_count desc
        limit 5
      ) t
    ),
    'flagged', (
      select coalesce(json_agg(f), '[]'::json) from (
        select address, score, dispute_count
        from trust_cache
        where dispute_count > 2
        order by dispute_count desc
        limit 10
      ) f
    )
  );
$$;
