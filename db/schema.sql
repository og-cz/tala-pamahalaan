-- Tala Pamahalaan: core schema
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query) for a new project.
-- Three tables carry everything: who someone is, what a position is, and who held it when.
-- Every fact-bearing table carries its own source and confidence, so nothing needs retrofitting
-- later if this ever opens up to public correction.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- people: one row per real individual, never per term.
-- ---------------------------------------------------------------------------
create table people (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  first_name text,
  middle_name text,
  last_name text not null,
  suffix text,                          -- Jr., Sr., III, etc.
  slug text unique not null,            -- url-safe id, e.g. "juan-dela-cruz-ilocos-norte"
  birth_year int,                       -- rarely available; null is expected, not an error
  notes text,
  match_confidence text not null default 'unverified'
    check (match_confidence in (
      'verified',                     -- a human has confirmed every term below is one person
      'unverified_with_middle_name',  -- name match includes a COMELEC-sourced middle name
      'unverified',                   -- name + province/city match only, no middle name
      'unresolved_missing_name'       -- source row had a blank first or last name; never
                                       -- auto-merged with anything, needs manual review
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index people_last_name_idx on people (last_name);

-- ---------------------------------------------------------------------------
-- offices: one row per position, not per person and not per term.
-- parent_office_id builds the hierarchy: a Cabinet secretary's parent is the
-- Presidency; a Mayor's parent is that province's Governor seat; a Senator or
-- national Representative has no parent (co-equal branches, not nested).
-- ---------------------------------------------------------------------------
create table offices (
  id uuid primary key default gen_random_uuid(),
  name text not null,                   -- "Governor of Ilocos Norte", "Senator", "Secretary of Health"
  branch text not null
    check (branch in ('executive', 'legislative', 'judiciary')),
  level text not null
    check (level in ('national', 'provincial', 'city', 'municipal')),
  position_type text not null
    check (position_type in ('elected', 'appointed')),
  province text,                        -- null for national-level offices
  city text,                            -- null unless level = 'city' or 'municipal'
  district text,                        -- for House seats, e.g. "Ilocos Norte, 1st District"
  parent_office_id uuid references offices(id) deferrable initially deferred,
  -- deferrable: this column self-references this same table (a Mayor's row
  -- points at a Governor row), and a bulk CSV import can't guarantee every
  -- Governor row lands before the Mayor rows that reference it. Deferring
  -- the check to end-of-transaction means row order in the import doesn't
  -- matter, only that every reference resolves by the time it commits.
  slug text unique not null,
  created_at timestamptz not null default now()
);

create index offices_province_idx on offices (province);
create index offices_branch_level_idx on offices (branch, level);

-- ---------------------------------------------------------------------------
-- terms: the actual historical record. One row per person per stint in an office.
-- This is the table almost everything else in the app is a view of.
-- ---------------------------------------------------------------------------
create table terms (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id),
  office_id uuid not null references offices(id),
  party text,
  term_start date not null,
  term_end date,                        -- null means still serving
  how_started text not null
    check (how_started in ('elected', 'appointed', 'succession', 'special_election')),
  how_ended text
    check (how_ended in (
      'term_ended', 'resigned', 'died_in_office', 'impeached',
      'lost_reelection', 'removed', 'other'
    )),                                  -- null while ongoing
  -- election-only fields; null for every appointed term, by definition, not a data gap
  vote_share_pct numeric(5,2),
  margin_pts numeric(5,2),
  -- appointment-only field
  appointed_by text,                    -- name or office of the appointing authority
  source_url text not null,
  source_note text,
  confidence text not null default 'unverified'
    check (confidence in ('verified', 'unverified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index terms_person_idx on terms (person_id);
create index terms_office_idx on terms (office_id);
create index terms_dates_idx on terms (term_start, term_end);

-- ---------------------------------------------------------------------------
-- Row-level security: the public (anon) key can read everything, and can
-- write nothing. Every insert/update/delete has to go through the Supabase
-- dashboard or a service-role script, never through the published app.
-- ---------------------------------------------------------------------------
alter table people enable row level security;
alter table offices enable row level security;
alter table terms enable row level security;

create policy "public read people" on people for select using (true);
create policy "public read offices" on offices for select using (true);
create policy "public read terms" on terms for select using (true);

-- no insert/update/delete policies are created for the anon role on purpose:
-- with RLS enabled and no policy for those actions, they are refused by default.
