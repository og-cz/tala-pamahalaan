# Tala Pamahalaan

A living record of who has held office in the Philippines, elected and appointed, linked person to
person across every term and office they've held rather than treated as isolated election results.

## How to run this

No signup, no server process to manage, just static files served locally.

```
pip install pandas
python3 scripts/build_from_openhalalan.py   # raw CSV -> people.csv, offices.csv, terms.csv
python3 scripts/export_app_json.py          # those CSVs -> the JSON files app/ actually reads
cd app
python3 -m http.server
```

Then open `http://localhost:8000`. That's it, both scripts write into files the app already
expects, nothing else to configure.

## What this actually is

This started as a reskin of a different project (Hugis ng Boto, an election-results map) and has
since grown past it into a real multi-page app, but it deliberately kept that project's whole visual
language rather than inventing a new one: the dark, near-black neutral palette, one typeface for
everything, and color spent only where the data needs it (the map's choropleth scale, the timeline's
current-term marker), not on branding. Text is kept to the minimum needed to read the data; there's
no hero banner and no tagline under the wordmark, the numbers and the page structure are meant to
carry the page. It now has:

- **A home page** built around one thing: a real government hierarchy tree, region, then province,
  then city, then whoever currently holds each seat in it, all the way down to every sitting
  Councilor. Nothing is rendered until it's opened, a region expands to its provinces, a province to
  its cities, a city to its Mayor, Vice Mayor, and full Council, so the page stays fast with 19,647
  officials behind it rather than trying to draw them all at once. Metro Manila's four districts sit
  in the tree exactly like any province, just with "No Governor on record" where a Governor would be,
  since there genuinely isn't one, not because the district was left out. The national headline
  numbers sit above it, and the background on how the data is built and matched is tucked into a
  collapsed "About this data" section below it rather than sitting in front of the numbers.
- **A global search bar**, in the header on every page, that finds any of the 19,647 currently
  tracked officials by name and jumps straight to their own page, no drilling through a province and
  then a city first.
- **A map**, largely the same interaction as before (hover or click a province to lock it, then drill
  into a city), now one page among several rather than the whole app. Metro Manila's four districts,
  including the City of Manila, are hoverable and clickable like any other shape, showing a "No
  Governor" state and their own city list instead of being skipped.
- **A Browse page** that lists every current official nationwide at once, filterable by branch
  (executive or legislative), position (Governor, Mayor, Vice Mayor, Councilor), province, party, and
  a minimum years-in-office, sortable by any column. The map's sidebar only ever shows one province
  at a time; this is the same data with the country in view all at once.
- **A Compare page**: search for any two officials and see their total years in office, current
  position, and full term history side by side.
- **A page for every person and every city**, each with its own address (`#/person/<id>`,
  `#/city/<province>/<city>`) so a specific official or a specific city's government can be linked to
  directly, not only reached by clicking through the map. A person's page shows their full career as
  an actual timeline (a dot per term along a line, not a row of buttons) and, when they're on a
  party's record, a tree of every other current officeholder under that same party, so how someone's
  career connects to their party isn't something you'd have to already know to see.

## What's actually in the data

82 of 88 provinces have a current Governor mapped (the other 6 are Metro Manila districts and one
chartered city, which genuinely have no Governor to show, not a data gap, and are still browsable on
the map and by search), 1,880 cities have a
current Mayor, and every one of the 19,647 tracked officials has a full career page: every term
they've held, elected or appointed, not just the seat they're in now. That's the actual point of
this project: a Mayor's page shows their time as Councilor before it and anywhere else after, so the
pattern of how long someone has actually held power, in whatever seat, is visible in one place
instead of scattered across separate election results.

Opening a city shows who's currently serving alongside its Mayor: the Vice Mayor (1,869 of 1,880
cities have one on record) and the full sitting Council, since Councilor is a genuinely multi-seat
office, not a single winner, 15,636 current Councilor seats are recorded across every city, none
with zero. Every name in that roster links to their own full page, so a Councilor's record is
exactly as reachable as the Mayor's.

The map still colors each province by cumulative years in office, using the same viridis color
scale as before (kept on purpose: it's a perceptually-uniform sequential ramp, checked not
eyeballed, and a choropleth's color scale is a data-correctness choice, not a branding one).
Everything around it, the header, the typography, the page layout, is new.

## Known rough edges, checked and left visible rather than smoothed over

92,941 people are linked from 157,333 terms. That matching is conservative on purpose: a person is
only linked across records if they share a name and the same province or city, so someone who moved
from a city council seat to a province-wide office will show up as two separate, unlinked entries,
not one, because that jump needs a more reliable match than name alone and this build doesn't guess
at it. 89 source rows had no first or last name at all; each got its own isolated identity rather
than merging into a shared blank one, after an earlier version of this script briefly and silently
collapsed all 89 of them into a single fictional person spanning unrelated provinces, caught before
it ever reached the app.

71 of 1,880 Mayor records have no city name on record in the source file and are filtered out of
the city list rather than shown with a blank name. Vote share and margin aren't populated for any
term yet, `build_from_openhalalan.py` only joins the winners file, not the separate per-candidate
vote-count file, so there's no runner-up to compute a margin against yet. `how_ended` is blank
everywhere: the source only records who won each cycle, not why a predecessor left, so guessing
would be fabrication.

34 Mayor offices and 27 Vice Mayor offices show more than one person tied for "current holder" at
the exact same term_start, a real duplication already present in the source winners file (both
seats are genuinely single-winner, so this isn't a multi-seat office like Councilor). The export
script logs a warning listing these when it runs rather than silently picking one at random; the
roster and the Browse page show whichever row pandas kept, which may not always be the correct name
until the source duplication is manually resolved.

The Browse page caps rendering at the top 300 matching rows for performance, since the full list is
19,647 officials, narrow with the filters to find someone specific rather than scrolling past a
capped table.

The home page's region groupings (Ilocos Region, CALABARZON, BARMM, and so on) are a hand-built,
static map from province to region, not something derived from the winners data, since no source
file here carries a region column; it's ordinary, unchanging geography, so hard-coding it once is
the honest approach rather than pretending it came from the pipeline. It surfaces two entries the
map's boundary shapes don't have room for: a "Special Geographic Area" branch (a real Bangsamoro
designation, not tied to any single province) and, alongside the current "Maguindanao del Norte" and
"Maguindanao del Sur" split, an older unsplit "Maguindanao" branch that's still how 44 of its cities
are labeled in the source file. Both are shown rather than dropped, on the same logic as everywhere
else in this project: a gap in how the data lines up is left visible, not quietly merged away.

## What isn't here yet

Party-list seats aren't in this data at all, the source file only records single-winner races, and
party-list seats come from a national vote-share formula, a different kind of result needing its
own separate source. Provincial Board Member (the province-level equivalent of a city Councilor) is
in the underlying data but isn't surfaced in the map's province view yet the way the city roster
surfaces Councilors. Appointed Executive positions (Cabinet secretaries) and the Judiciary (the
Supreme Court) also aren't in here yet, that layer was always going to be a smaller, hand-curated
addition rather than something this ETL script could produce. Senator, President, and Vice
President have only 48, 2, and 2 rows respectively across nine election cycles in this same source
file, nowhere near a complete roster, so those three offices aren't surfaced in the app yet either.

## Growing this into a real, live system later

Everything above runs entirely on static files, on purpose, since nothing here is published and
there's no reason to run a server for data only one person is looking at. `db/schema.sql` and
`app/api.js` are the upgrade path for later, when updating a record needs to happen without
rerunning both scripts and reloading the page: `schema.sql` is a Postgres schema for the same three
tables (`people`, `offices`, `terms`), written for Supabase specifically because it turns that
schema into a real REST API automatically, with a built-in editor for changing rows directly, no
backend code required. `api.js` already exposes the same three functions the app needs
(`fetchCurrentHolders`, `fetchPersonTimeline`, `fetchOfficeHistory`) against that API, so swapping
from static JSON to a live database later is a change confined to how those functions are
implemented, not a rewrite of `app.js`'s own routing or page logic. Picking that up means creating a
free Supabase project, running `schema.sql` in its SQL editor, and importing the three processed
CSVs through its Table Editor (`people.csv` first, then `offices.csv`, then `terms.csv`, since
`terms` refers to both of the others), then filling in `app/config.js` with that project's URL and
public anon key. The app's own hash-based routing (`#/person/123`, `#/city/abra/la-paz`) already
produces real, shareable addresses for every page without needing any server-side routing config,
so that part of "grow into a real system" is already done regardless of which backend eventually
sits behind it.
