"""
Builds people.csv, offices.csv, and terms.csv from the OpenHalalan winners file,
ready to load into the Supabase tables in db/schema.sql.

Plain script, not a notebook, on purpose: this is a data pipeline you'll rerun
whenever new winners data shows up, not an analysis you read once.

Known, deliberate limitations (read before trusting the output):

1. Coverage in the source file is heavily local. Of ~157k rows, about 98% are
   Councilor, Vice Mayor, Mayor, or Provincial Board Member. Governor and Vice
   Governor have a few hundred rows each. Senator has only 48 rows and
   President/Vice President have only 2 each, across 9 election cycles where
   full rosters would be much larger. Do not treat this file as a complete
   national roster, it isn't one. National offices need a separate, manually
   sourced backbone (Wikipedia's per-position pages are a reasonable start)
   before this pipeline's output for them can be trusted.

2. Identity matching is deliberately conservative. A person is only linked
   across rows if they share last name, first name, middle name (when the
   source has it), AND the same province (and city, for city/municipal-level
   positions). This means a real person who moved from City Councilor to
   Provincial Governor will show up here as two unlinked people, not one,
   because that cross-level jump is exactly the harder matching problem
   flagged earlier: it needs a verified secondary source, not a name-based
   guess. Under-linking was chosen over over-linking on purpose.

3. term_end is inferred from a fixed term length per position (3 years for
   everything except President, Vice President, and Senator at 6 years), with
   term_start fixed at June 30 of the election year, which is the traditional
   inauguration date. This is a reasonable approximation, not a confirmed
   fact per term, so every row this script writes gets confidence='unverified'.

4. how_ended is left null for every row. This file only records who won each
   cycle, not why a predecessor left, so guessing 'term_ended' vs 'resigned'
   vs 'died_in_office' from winners data alone would be fabrication.
"""

import pandas as pd
from pathlib import Path
import re

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = PROJECT_ROOT / "data" / "raw" / "NLE_Winners_2004-2025.csv"
OUT_DIR = PROJECT_ROOT / "data" / "processed"
OUT_DIR.mkdir(parents=True, exist_ok=True)

TERM_LENGTH_YEARS = {
    "PRESIDENT": 6,
    "VICE PRESIDENT": 6,
    "SENATOR": 6,
    "MEMBER, HOUSE OF REPRESENTATIVES": 3,
    "GOVERNOR": 3,
    "VICE GOVERNOR": 3,
    "PROVINCIAL BOARD MEMBER": 3,
    "MAYOR": 3,
    "VICE MAYOR": 3,
    "COUNCILOR": 3,
}

BRANCH = {
    "PRESIDENT": "executive",
    "VICE PRESIDENT": "executive",
    "SENATOR": "legislative",
    "MEMBER, HOUSE OF REPRESENTATIVES": "legislative",
    "GOVERNOR": "executive",
    "VICE GOVERNOR": "executive",
    "PROVINCIAL BOARD MEMBER": "legislative",
    "MAYOR": "executive",
    "VICE MAYOR": "executive",
    "COUNCILOR": "legislative",
}

LEVEL = {
    "PRESIDENT": "national",
    "VICE PRESIDENT": "national",
    "SENATOR": "national",
    "MEMBER, HOUSE OF REPRESENTATIVES": "national",
    "GOVERNOR": "provincial",
    "VICE GOVERNOR": "provincial",
    "PROVINCIAL BOARD MEMBER": "provincial",
    "MAYOR": "city",
    "VICE MAYOR": "city",
    "COUNCILOR": "city",
}


def slugify(text):
    text = str(text).strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def office_name(position, province, city):
    if position in ("PRESIDENT", "VICE PRESIDENT", "SENATOR"):
        return position.title()
    if position == "MEMBER, HOUSE OF REPRESENTATIVES":
        return f"Representative, {city}, {province}".title() if pd.notna(city) else f"Representative, {province}".title()
    if position in ("GOVERNOR", "VICE GOVERNOR", "PROVINCIAL BOARD MEMBER"):
        return f"{position.title()} of {str(province).title()}"
    return f"{position.title()} of {str(city).title()}, {str(province).title()}"


def main():
    df = pd.read_csv(RAW_PATH)
    df = df[df["Position"].isin(TERM_LENGTH_YEARS.keys())].copy()

    df["Province"] = df["Province"].fillna("")
    df["City"] = df["City"].fillna("")
    df["Middle Name"] = df["Middle Name"].fillna("")
    # Last/First Name missing on 7 and 82 rows respectively (checked directly
    # against the source file). Left as real NaN, pandas treats every NaN key
    # as equal to every other NaN key during drop_duplicates/groupby, so all
    # 89 of these rows silently merged into one fictional "person" spanning
    # unrelated provinces the first time this ran. Filling with "" avoids the
    # NaN-collapsing behavior, and the row-index suffix below stops them from
    # colliding with each other via a shared empty string instead.
    df["Last Name"] = df["Last Name"].fillna("")
    df["First Name"] = df["First Name"].fillna("")
    df["_incomplete_name"] = (df["Last Name"] == "") | (df["First Name"] == "")

    is_local = df["Position"].isin(["MAYOR", "VICE MAYOR", "COUNCILOR"])
    df["office_key"] = df["Position"] + "|" + df["Province"] + "|" + df["City"].where(is_local, "")

    base_key = (
        df["Last Name"].str.upper().str.strip() + "|"
        + df["First Name"].str.upper().str.strip() + "|"
        + df["Middle Name"].str.upper().str.strip() + "|"
        + df["Province"] + "|"
        + df["City"].where(is_local, "")
    )
    # A row with an incomplete name never merges with anything, including
    # another incomplete row, until a human resolves who it actually is.
    df["person_key"] = base_key.where(
        ~df["_incomplete_name"], "INCOMPLETE|" + df.index.astype(str)
    )

    # --- people -------------------------------------------------------
    def confidence_for(row):
        if row["_incomplete_name"]:
            return "unresolved_missing_name"
        if row["Middle Name"] != "":
            return "unverified_with_middle_name"
        return "unverified"

    people = (
        df.drop_duplicates("person_key")
        .assign(match_confidence=lambda d: d.apply(confidence_for, axis=1))
        [["person_key", "Last Name", "First Name", "Middle Name", "Full Name", "match_confidence"]]
        .reset_index(drop=True)
    )
    people["id"] = people.index.map(lambda i: f"p{i}")
    people["slug"] = (
        people["Last Name"].map(slugify) + "-" + people["First Name"].map(slugify)
        + "-" + people["id"]
    )
    people_out = people.rename(columns={
        "Last Name": "last_name", "First Name": "first_name",
        "Middle Name": "middle_name", "Full Name": "full_name",
    })[["id", "slug", "full_name", "first_name", "middle_name", "last_name", "match_confidence"]]

    # --- offices --------------------------------------------------------
    offices = df.drop_duplicates("office_key")[["office_key", "Position", "Province", "City"]].reset_index(drop=True)
    offices["id"] = offices.index.map(lambda i: f"o{i}")
    offices["name"] = offices.apply(lambda r: office_name(r["Position"], r["Province"], r["City"]), axis=1)
    offices["branch"] = offices["Position"].map(BRANCH)
    offices["level"] = offices["Position"].map(LEVEL)
    offices["position_type"] = "elected"
    offices["slug"] = offices["name"].map(slugify) + "-" + offices["id"]

    # Hierarchy: every city/municipal office nests under its province's
    # Governor seat. Governor/Vice Governor/Board Member and every national
    # office (President, VP, Senator, Representative) get no parent, they're
    # either the top of a geographic tree or a co-equal national branch, not
    # a subordinate of anything else in this table.
    governor_office_id = dict(
        offices[offices["Position"] == "GOVERNOR"].set_index("Province")["id"]
    )
    city_level_positions = {"MAYOR", "VICE MAYOR", "COUNCILOR"}
    offices["parent_office_id"] = offices.apply(
        lambda r: governor_office_id.get(r["Province"])
        if r["Position"] in city_level_positions else None,
        axis=1,
    )
    unmatched = offices[
        offices["Position"].isin(city_level_positions) & offices["parent_office_id"].isna()
    ]

    offices_out = offices.rename(columns={"Province": "province", "City": "city"})[
        ["id", "slug", "name", "branch", "level", "position_type", "province", "city", "parent_office_id"]
    ]

    # --- terms ------------------------------------------------------------
    person_id_map = dict(zip(people["person_key"], people["id"]))
    office_id_map = dict(zip(offices["office_key"], offices["id"]))

    df["person_id"] = df["person_key"].map(person_id_map)
    df["office_id"] = df["office_key"].map(office_id_map)
    df["term_start"] = pd.to_datetime(df["Year"].astype(str) + "-06-30")
    df["term_length"] = df["Position"].map(TERM_LENGTH_YEARS)
    df["term_end"] = df["term_start"] + pd.to_timedelta(df["term_length"] * 365.25, unit="D")

    terms_out = df[[
        "person_id", "office_id", "Party", "term_start", "term_end",
    ]].rename(columns={"Party": "party"})
    terms_out["how_started"] = "elected"
    terms_out["how_ended"] = None
    terms_out["confidence"] = "unverified"
    terms_out["source_url"] = "https://robertrleung.github.io/OpenHalalan/"
    terms_out["source_note"] = "NLE_Winners_2004-2025.csv, term dates inferred from a fixed term length, not confirmed per row"

    people_out.to_csv(OUT_DIR / "people.csv", index=False)
    offices_out.to_csv(OUT_DIR / "offices.csv", index=False)
    terms_out.to_csv(OUT_DIR / "terms.csv", index=False)

    print(f"people:  {len(people_out):,}")
    print(f"offices: {len(offices_out):,}")
    print(f"terms:   {len(terms_out):,}")
    print(f"city/muni offices linked to a province's Governor seat: "
          f"{offices['parent_office_id'].notna().sum():,} of "
          f"{offices['Position'].isin(city_level_positions).sum():,}")
    if len(unmatched):
        print(f"unmatched (no Governor office found for their province): {len(unmatched)}")
        print(sorted(unmatched['Province'].unique().tolist()))
    print()
    print("rows per position in source file:")
    print(df["Position"].value_counts())


if __name__ == "__main__":
    main()
