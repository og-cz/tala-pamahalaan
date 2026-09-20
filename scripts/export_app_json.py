"""
Turns data/processed/{people,offices,terms}.csv into the static JSON files
app/app.js reads, the same "plain files, no server" approach Hugis ng Boto
uses. Rerun this after build_from_openhalalan.py any time the source data
changes.

"Current holder" of an office is defined as whoever won the most recent
recorded election for it, not a strict today-falls-inside-this-term-window
check, since term_end is itself only an approximation (see
build_from_openhalalan.py's docstring). That's a deliberate simplification,
worth knowing if an office's most recent contest is missing from the source
file, in which case its last known winner will still show as "current" here
even if a real, un-recorded successor exists.

"Cumulative years in office" sums every term ever found for that person
across every office, not just the one they currently hold, using the same
fixed-term-length approximation. It's the single number this whole project
is built to surface: how long has this person actually held power, in any
seat.
"""

import json
from pathlib import Path

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED = PROJECT_ROOT / "data" / "processed"
APP_DATA = PROJECT_ROOT / "app" / "data"
APP_DATA.mkdir(parents=True, exist_ok=True)


def main():
    people = pd.read_csv(PROCESSED / "people.csv")
    offices = pd.read_csv(PROCESSED / "offices.csv")
    terms = pd.read_csv(PROCESSED / "terms.csv", parse_dates=["term_start", "term_end"])

    terms = terms.merge(offices, left_on="office_id", right_on="id", suffixes=("", "_office"))
    terms = terms.merge(people, left_on="person_id", right_on="id", suffixes=("", "_person"))
    # vote_share_pct/margin_pts aren't populated yet, build_from_openhalalan.py
    # only joins the winners file, not the separate per-candidate vote-count
    # file, so there's no runner-up to compute a margin against yet. Added as
    # explicit nulls here rather than left to crash the export.
    for col in ("vote_share_pct", "margin_pts"):
        if col not in terms.columns:
            terms[col] = pd.NA

    # cumulative years in ANY office, per person, across every term on record
    terms["term_years"] = (terms["term_end"] - terms["term_start"]).dt.days / 365.25
    cumulative = terms.groupby("person_id")["term_years"].sum().rename("cumulative_years")

    # Current holder(s) = every row sharing the latest term_start per office,
    # not just one. Governor, Vice Governor, Mayor, and Vice Mayor are
    # genuinely single-seat, so this is one row same as before. Councilor and
    # Provincial Board Member are NOT: a city elects several Councilors at
    # once under one shared "Councilor of X" office row (Adams, Ilocos Norte
    # elected 8 of them in 2025 alone), so picking a single max via idxmax()
    # silently hid the other 7. Keeping every tied row is what makes a real
    # council roster possible instead of one arbitrary name standing in for
    # a multi-seat office.
    max_term_start = terms.groupby("office_id")["term_start"].transform("max")
    current_all = terms[terms["term_start"] == max_term_start].merge(cumulative, on="person_id", how="left")

    # office rows don't keep the original raw "Position" label, so identity is
    # read back off the office name instead. "Governor of X" vs "Vice Governor
    # of X" and "Mayor of X" vs "Vice Mayor of X" don't collide since the Vice
    # variants share no common prefix with the non-Vice ones.
    is_governor = current_all["name"].str.startswith("Governor of")
    is_mayor = current_all["name"].str.startswith("Mayor of")
    is_vice_mayor = current_all["name"].str.startswith("Vice Mayor of")
    is_councilor = current_all["name"].str.startswith("Councilor of")

    # sanity check: Governor/Mayor/Vice Mayor should never actually tie for
    # a real current seat. If one does, that's a genuine data issue worth
    # seeing, not silently picking whichever row pandas happened to keep.
    for label, mask in [("Governor", is_governor), ("Mayor", is_mayor), ("Vice Mayor", is_vice_mayor)]:
        dupe_offices = current_all[mask].groupby("office_id").size()
        dupes = dupe_offices[dupe_offices > 1]
        if len(dupes):
            print(f"WARNING: {len(dupes)} {label} office(s) have more than one current holder tied "
                  f"at the same term_start, expected exactly one. Office ids: {list(dupes.index)[:5]}")

    # single-seat views take the first (only, barring the warning above) row
    # per office; current_all is kept as-is for the multi-seat Councilor roster.
    current = current_all.loc[current_all.groupby("office_id")["term_start"].idxmax()]
    # recomputed against `current`'s own (smaller, deduped) index -- reusing
    # the current_all-aligned masks here would silently misalign every row.
    is_governor = current["name"].str.startswith("Governor of")
    is_mayor = current["name"].str.startswith("Mayor of")
    is_vice_mayor = current["name"].str.startswith("Vice Mayor of")

    # --- provinces.geojson: current Governor per province, on real boundaries ---
    boundaries = json.loads((PROJECT_ROOT / "data" / "raw" / "ph_provinces_raw.geojson").read_text())
    # The winners file spells some province names with spaces where the
    # boundary file uses a hyphen (e.g. "TAWI TAWI" vs "Tawi-Tawi"), so both
    # sides normalize hyphens to spaces before joining on the name.
    governors = current[is_governor].set_index(
        current[is_governor]["province"].str.upper().str.replace("-", " ", regex=False)
    )

    matched, unmatched = 0, []
    for feature in boundaries["features"]:
        raw_name = feature["properties"].get("adm2_en")
        province_name = raw_name.upper().replace("-", " ") if raw_name else None
        row = governors.loc[province_name] if province_name and province_name in governors.index else None
        if row is not None:
            feature["properties"] = {
                "province": feature["properties"]["adm2_en"],
                "office_id": row["office_id"],
                "person_id": row["person_id"],
                "full_name": row["full_name"],
                "party": row["party"] if pd.notna(row["party"]) else None,
                "term_start": row["term_start"].strftime("%Y-%m-%d"),
                "cumulative_years": round(float(row["cumulative_years"]), 1),
            }
            matched += 1
        else:
            feature["properties"] = {"province": feature["properties"]["adm2_en"]}
            unmatched.append(feature["properties"]["province"])
    (APP_DATA / "provinces.geojson").write_text(json.dumps(boundaries, allow_nan=False))

    def person_stub(r):
        return {
            "person_id": r["person_id"],
            "full_name": r["full_name"],
            "party": r["party"] if pd.notna(r["party"]) else None,
            "term_start": r["term_start"].strftime("%Y-%m-%d"),
            "cumulative_years": round(float(r["cumulative_years"]), 1),
        }

    # --- cities_by_province.json: the current Mayor, Vice Mayor, and full ---
    # Councilor roster for every city, grouped by province. Vice Mayor is
    # single-seat like Mayor; Councilor is genuinely multi-seat, so every
    # current-term row for that office is kept, not just one.
    mayors = current[is_mayor]
    vice_mayors_by_key = {
        (r["province"], r["city"]): person_stub(r)
        for _, r in current[is_vice_mayor].iterrows()
    }
    councilors_by_key = {}
    for (_, r) in current_all[is_councilor].iterrows():
        key = (r["province"], r["city"])
        councilors_by_key.setdefault(key, []).append(person_stub(r))

    cities_by_province = {}
    for province, group in mayors.groupby("province"):
        cities_by_province[province] = [
            dict(
                person_stub(r),
                city=r["city"] if pd.notna(r["city"]) else None,
                office_id=r["office_id"],
                vice_mayor=vice_mayors_by_key.get((r["province"], r["city"])),
                councilors=sorted(
                    councilors_by_key.get((r["province"], r["city"]), []),
                    key=lambda c: c["full_name"],
                ),
            )
            for _, r in group.iterrows()
        ]
    (APP_DATA / "cities_by_province.json").write_text(json.dumps(cities_by_province, allow_nan=False))

    # --- person_timelines.json: full career for everyone shown anywhere in the app ---
    tracked_ids = set(current[is_governor | is_mayor | is_vice_mayor]["person_id"])
    tracked_ids |= set(current_all[is_councilor]["person_id"])
    timelines = {}
    for person_id, group in terms[terms["person_id"].isin(tracked_ids)].groupby("person_id"):
        group = group.sort_values("term_start")
        first = group.iloc[0]
        timelines[person_id] = {
            "full_name": first["full_name"],
            "cumulative_years": round(float(cumulative.get(person_id, 0.0)), 1),
            "match_confidence": first["match_confidence"],
            "terms": [
                {
                    "office_name": t["name"],
                    "branch": t["branch"],
                    "level": t["level"],
                    "province": t["province"] if pd.notna(t["province"]) else None,
                    "city": t["city"] if pd.notna(t["city"]) else None,
                    "party": t["party"] if pd.notna(t["party"]) else None,
                    "term_start": t["term_start"].strftime("%Y-%m-%d"),
                    "term_end": t["term_end"].strftime("%Y-%m-%d"),
                    "how_started": t["how_started"],
                    "how_ended": t["how_ended"] if pd.notna(t["how_ended"]) else None,
                    "vote_share_pct": None if pd.isna(t["vote_share_pct"]) else float(t["vote_share_pct"]),
                    "margin_pts": None if pd.isna(t["margin_pts"]) else float(t["margin_pts"]),
                }
                for _, t in group.iterrows()
            ],
        }
    (APP_DATA / "person_timelines.json").write_text(json.dumps(timelines, allow_nan=False))

    # --- all_officials.json: one flat row per current officeholder, nationwide,
    # not scoped to a single province like the map sidebar is. This is what
    # powers global search, the national Browse/filter page, and Compare, none
    # of which can be built out of the province-by-province files above since
    # those only ever hold one province's or one city's slice at a time.
    #
    # Deliberately built from fresh masks on current_all's own index rather
    # than reusing is_governor/is_mayor/is_vice_mayor from above -- those were
    # recomputed against `current`'s smaller (deduped) index for the
    # single-seat views, and OR-ing a `current`-indexed mask against
    # is_councilor (current_all-indexed) would silently misalign rows via
    # pandas' index-union behavior instead of raising, exactly the bug class
    # the comment above already warns about.
    all_mask = (
        current_all["name"].str.startswith("Governor of")
        | current_all["name"].str.startswith("Mayor of")
        | current_all["name"].str.startswith("Vice Mayor of")
        | current_all["name"].str.startswith("Councilor of")
    )
    all_current = current_all[all_mask]

    def position_of(name):
        if name.startswith("Vice Mayor of"):
            return "Vice Mayor"
        if name.startswith("Mayor of"):
            return "Mayor"
        if name.startswith("Councilor of"):
            return "Councilor"
        if name.startswith("Governor of"):
            return "Governor"
        return name

    all_officials = []
    for _, r in all_current.iterrows():
        all_officials.append({
            "row_id": f"{r['person_id']}|{r['office_id']}",
            "person_id": r["person_id"],
            "full_name": r["full_name"],
            "position": position_of(r["name"]),
            "office_name": r["name"],
            "branch": r["branch"],
            "level": r["level"],
            "province": r["province"] if pd.notna(r["province"]) else None,
            "city": r["city"] if pd.notna(r["city"]) else None,
            "party": r["party"] if pd.notna(r["party"]) else None,
            "term_start": r["term_start"].strftime("%Y-%m-%d"),
            "cumulative_years": round(float(r["cumulative_years"]), 1),
        })
    (APP_DATA / "all_officials.json").write_text(json.dumps(all_officials, allow_nan=False))

    print(f"provinces matched to a current Governor: {matched} of {len(boundaries['features'])}")
    if unmatched:
        print("unmatched provinces (no Governor row for this name):", unmatched)
    print(f"provinces with a Mayor list:  {len(cities_by_province)}")
    print(f"cities with a current Mayor:  {sum(len(v) for v in cities_by_province.values())}")
    cities_with_vm = sum(1 for v in cities_by_province.values() for c in v if c["vice_mayor"])
    total_councilors = sum(len(c["councilors"]) for v in cities_by_province.values() for c in v)
    cities_with_no_councilors = sum(1 for v in cities_by_province.values() for c in v if not c["councilors"])
    print(f"cities with a current Vice Mayor: {cities_with_vm}")
    print(f"total current Councilors across all cities: {total_councilors}")
    print(f"cities with a Mayor but zero Councilors on record: {cities_with_no_councilors}")
    print(f"people with a tracked timeline: {len(timelines)}")
    print(f"all_officials.json rows (every current seat, nationwide): {len(all_officials)}")
    for name, path in [
        ("provinces.geojson", APP_DATA / "provinces.geojson"),
        ("cities_by_province.json", APP_DATA / "cities_by_province.json"),
        ("person_timelines.json", APP_DATA / "person_timelines.json"),
        ("all_officials.json", APP_DATA / "all_officials.json"),
    ]:
        print(f"  {name}: {path.stat().st_size / 1_000_000:.1f} MB")


if __name__ == "__main__":
    main()
