-- Run this in Supabase SQL Editor (https://supabase.com/dashboard > SQL Editor)

-- Table
create table checks (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  trusted boolean not null,
  score float not null,
  endpoint text not null,
  duration_ms integer not null,
  payment_success boolean not null default false,
  composite_breakdown jsonb,
  created_at timestamptz not null default now()
);

-- Index for common queries
create index idx_checks_created_at on checks (created_at desc);
create index idx_checks_address on checks (address);

-- Enable RLS but allow inserts from anon key
alter table checks enable row level security;
create policy "allow anon insert" on checks for insert to anon with check (true);
create policy "allow anon select" on checks for select to anon using (true);

-- RPC: aggregate totals
create or replace function get_check_totals()
returns json language sql stable as $$
  select json_build_object(
    'total_checks', count(*),
    'trusted_count', count(*) filter (where trusted),
    'unique_addresses', count(distinct address),
    'avg_score', coalesce(round(avg(score)::numeric, 1), 0)
  )
  from checks;
$$;

-- RPC: top reasons checks fail (parses the reasons from composite_breakdown)
-- Since we store breakdown not reasons, we count by failure pattern
create or replace function get_top_failing_reasons()
returns json language sql stable as $$
  select coalesce(json_agg(r), '[]'::json) from (
    select reason, count(*) as count from (
      select
        case
          when (composite_breakdown->>'erc8004')::float = 0 then 'No ERC-8004 registration'
          when (composite_breakdown->>'x402History')::float = 0 then 'No x402 payment history'
          when (composite_breakdown->>'balance')::float < 1 then 'Low ETH balance'
          when (composite_breakdown->>'walletAge')::float < 1 then 'New wallet'
          when (composite_breakdown->>'activity')::float < 1 then 'Low activity'
          else 'Other'
        end as reason
      from checks
      where not trusted
    ) sub
    group by reason
    order by count desc
    limit 5
  ) r;
$$;
