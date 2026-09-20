// Thin wrapper around Supabase's auto-generated REST API (PostgREST).
// Plain fetch, no SDK, no build step, same "no framework" approach as the rest
// of this app. Every function here returns already-parsed JSON or throws.

(function () {
  const cfg = window.TALA_CONFIG || {};

  function restUrl(path) {
    if (!cfg.SUPABASE_URL) {
      throw new Error(
        "Supabase isn't configured yet. Fill in SUPABASE_URL and SUPABASE_ANON_KEY in config.js."
      );
    }
    return cfg.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path;
  }

  async function restGet(path) {
    const res = await fetch(restUrl(path), {
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("Supabase request failed (" + res.status + "): " + body);
    }
    return res.json();
  }

  // All offices of a given branch, optionally filtered by level.
  // e.g. fetchOffices({ branch: "executive", level: "provincial" })
  async function fetchOffices({ branch, level } = {}) {
    const params = ["select=*"];
    if (branch) params.push("branch=eq." + encodeURIComponent(branch));
    if (level) params.push("level=eq." + encodeURIComponent(level));
    return restGet("offices?" + params.join("&"));
  }

  // The current (term_end is null) holder of every office matching a filter,
  // joined with that person's basic info. This is what feeds the map.
  async function fetchCurrentHolders({ branch, level } = {}) {
    const params = [
      "select=*,people(*),offices(*)",
      "term_end=is.null",
    ];
    if (branch) params.push("offices.branch=eq." + encodeURIComponent(branch));
    if (level) params.push("offices.level=eq." + encodeURIComponent(level));
    return restGet("terms?" + params.join("&"));
  }

  // Every term for one person, in chronological order, elected and appointed
  // alike. This is the "before and after" career timeline.
  async function fetchPersonTimeline(personId) {
    const params = [
      "select=*,offices(*)",
      "person_id=eq." + encodeURIComponent(personId),
      "order=term_start.asc",
    ];
    return restGet("terms?" + params.join("&"));
  }

  // Every term ever held for a single office (its full holder history).
  async function fetchOfficeHistory(officeId) {
    const params = [
      "select=*,people(*)",
      "office_id=eq." + encodeURIComponent(officeId),
      "order=term_start.asc",
    ];
    return restGet("terms?" + params.join("&"));
  }

  window.TalaAPI = {
    fetchOffices,
    fetchCurrentHolders,
    fetchPersonTimeline,
    fetchOfficeHistory,
  };
})();
