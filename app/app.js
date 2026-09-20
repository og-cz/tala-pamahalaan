(function () {
  "use strict";

  // ------------------------------------------------------------------ data
  var provincesGeo = null;      // FeatureCollection, one feature per province
  var citiesByProvince = null;  // { PROVINCE: [ {city, full_name, party, cumulative_years, person_id, vice_mayor, councilors, ...} ] }
  var timelines = null;         // { person_id: { full_name, cumulative_years, match_confidence, terms: [...] } }
  var allOfficials = null;      // [ {row_id, person_id, full_name, position, office_name, branch, level, province, city, party, term_start, cumulative_years} ]

  var citiesByProvinceNorm = {};
  var nationalStats = null;     // computed once data is in, used by Home + elsewhere

  var currentTeardown = null;   // cleanup for whatever page is currently mounted (mainly the map)
  var compareSlotA = null;      // person_id, persisted across navigation so a "Compare" link can preload one side
  var compareSlotB = null;

  Promise.all([
    fetch("data/provinces.geojson").then(function (r) { return r.json(); }),
    fetch("data/cities_by_province.json").then(function (r) { return r.json(); }),
    fetch("data/person_timelines.json").then(function (r) { return r.json(); }),
    fetch("data/all_officials.json").then(function (r) { return r.json(); }),
  ]).then(function (results) {
    provincesGeo = results[0];
    citiesByProvince = results[1];
    timelines = results[2];
    allOfficials = results[3];

    Object.keys(citiesByProvince).forEach(function (p) {
      citiesByProvinceNorm[normalizeProvince(p)] = citiesByProvince[p];
    });
    computeNationalStats();
    buildGovernorIndex();
    wireGlobalSearch();
    window.addEventListener("hashchange", renderRoute);
    renderRoute();
  }).catch(function (err) {
    console.error("Tala Pamahalaan: failed to load data -", err);
    document.getElementById("view-root").innerHTML =
      '<div class="load-msg">The data files failed to load. If you’re opening this file directly, ' +
      "serve the app/ folder instead (<code>python3 -m http.server</code>), browsers block plain " +
      "file:// fetches.</div>";
  });

  // ------------------------------------------------------------------ small helpers
  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtYears(y) {
    if (y == null) return "…";
    return y.toFixed(1);
  }
  function fmtDate(iso) {
    if (!iso) return "present";
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }
  function titleCase(s) {
    if (!s) return s;
    return s.replace(/\w\S*/g, function (t) { return t.charAt(0).toUpperCase() + t.substr(1).toLowerCase(); });
  }
  // provinces.geojson uses the boundary file's mixed-case, hyphenated names
  // ("Ilocos Norte", "Tawi-Tawi"); cities_by_province.json / all_officials.json
  // keys are the raw winners-file spelling (all caps, "TAWI TAWI" with a space).
  function normalizeProvince(s) {
    return (s || "").toUpperCase().replace(/-/g, " ");
  }
  // The boundary file spells Metro Manila's 4 districts very differently from
  // the winners file ("NCR, City of Manila, First District (Not a Province)"
  // vs "NCR FIRST DISTRICT"), which used to mean these districts, Manila
  // included, had no Governor stat AND no way to look up their city list.
  // This maps either spelling to the one the rest of the app's data actually
  // uses, so a district can still be located and clicked into.
  function canonicalProvinceName(rawName) {
    var up = (rawName || "").toUpperCase();
    var m = up.match(/(FIRST|SECOND|THIRD|FOURTH)\s+DISTRICT/);
    if (up.indexOf("NCR") !== -1 && m) return "NCR " + m[1] + " DISTRICT";
    return rawName;
  }
  function displayProvinceName(name) {
    return titleCase(name).replace(/\bNcr\b/, "NCR");
  }
  function personLink(personId) {
    return "#/person/" + encodeURIComponent(personId);
  }
  function cityLink(province, city) {
    return "#/city/" + encodeURIComponent(province) + "/" + encodeURIComponent(city);
  }

  function computeNationalStats() {
    var features = provincesGeo.features.filter(function (f) { return f.properties.cumulative_years != null; });
    var totalCities = Object.keys(citiesByProvince).reduce(function (n, p) { return n + citiesByProvince[p].length; }, 0);
    var totalYears = 0;
    for (var i = 0; i < allOfficials.length; i++) totalYears += allOfficials[i].cumulative_years;
    var longest = allOfficials.reduce(function (a, b) { return b.cumulative_years > a.cumulative_years ? b : a; }, allOfficials[0]);
    nationalStats = {
      provincesMapped: features.length,
      totalCities: totalCities,
      totalOfficials: allOfficials.length,
      uniquePeople: new Set(allOfficials.map(function (o) { return o.person_id; })).size,
      avgYears: totalYears / allOfficials.length,
      longest: longest,
    };
  }

  // ------------------------------------------------------------------ government hierarchy tree
  // The Philippines' 88 provinces (Metro Manila's 4 districts included, even
  // though they have no province-level government of their own) grouped into
  // their 17 regions. This is static real-world geography, not derived from
  // the winners data. Keyed the same way citiesByProvinceNorm already is
  // (upper-case, hyphens as spaces), so every key here is guaranteed to have
  // a matching city list.
  var REGION_PROVINCES = {
    "National Capital Region (NCR)": ["NCR FIRST DISTRICT", "NCR SECOND DISTRICT", "NCR THIRD DISTRICT", "NCR FOURTH DISTRICT"],
    "Cordillera Administrative Region (CAR)": ["ABRA", "APAYAO", "BENGUET", "IFUGAO", "KALINGA", "MOUNTAIN PROVINCE"],
    "Region I, Ilocos Region": ["ILOCOS NORTE", "ILOCOS SUR", "LA UNION", "PANGASINAN"],
    "Region II, Cagayan Valley": ["BATANES", "CAGAYAN", "ISABELA", "NUEVA VIZCAYA", "QUIRINO"],
    "Region III, Central Luzon": ["AURORA", "BATAAN", "BULACAN", "NUEVA ECIJA", "PAMPANGA", "TARLAC", "ZAMBALES"],
    "Region IV-A, CALABARZON": ["BATANGAS", "CAVITE", "LAGUNA", "QUEZON", "RIZAL"],
    "MIMAROPA Region": ["MARINDUQUE", "OCCIDENTAL MINDORO", "ORIENTAL MINDORO", "PALAWAN", "ROMBLON"],
    "Region V, Bicol Region": ["ALBAY", "CAMARINES NORTE", "CAMARINES SUR", "CATANDUANES", "MASBATE", "SORSOGON"],
    "Region VI, Western Visayas": ["AKLAN", "ANTIQUE", "CAPIZ", "GUIMARAS", "ILOILO", "NEGROS OCCIDENTAL"],
    "Region VII, Central Visayas": ["BOHOL", "CEBU", "NEGROS ORIENTAL", "SIQUIJOR"],
    "Region VIII, Eastern Visayas": ["BILIRAN", "EASTERN SAMAR", "LEYTE", "NORTHERN SAMAR", "SAMAR", "SOUTHERN LEYTE"],
    "Region IX, Zamboanga Peninsula": ["ZAMBOANGA DEL NORTE", "ZAMBOANGA DEL SUR", "ZAMBOANGA SIBUGAY"],
    "Region X, Northern Mindanao": ["BUKIDNON", "CAMIGUIN", "LANAO DEL NORTE", "MISAMIS OCCIDENTAL", "MISAMIS ORIENTAL"],
    "Region XI, Davao Region": ["DAVAO DE ORO", "DAVAO DEL NORTE", "DAVAO DEL SUR", "DAVAO OCCIDENTAL", "DAVAO ORIENTAL"],
    "Region XII, SOCCSKSARGEN": ["COTABATO", "SARANGANI", "SOUTH COTABATO", "SULTAN KUDARAT"],
    "Region XIII, Caraga": ["AGUSAN DEL NORTE", "AGUSAN DEL SUR", "DINAGAT ISLANDS", "SURIGAO DEL NORTE", "SURIGAO DEL SUR"],
    "Bangsamoro Autonomous Region (BARMM)": ["BASILAN", "LANAO DEL SUR", "MAGUINDANAO", "MAGUINDANAO DEL NORTE", "MAGUINDANAO DEL SUR", "SULU", "TAWI TAWI", "SPECIAL GEOGRAPHIC AREA"],
  };
  var REGION_ORDER = Object.keys(REGION_PROVINCES);

  var governorByProvince = null; // { PROVINCE: officialRow }, built once the data is in
  function buildGovernorIndex() {
    governorByProvince = {};
    allOfficials.forEach(function (o) {
      if (o.position === "Governor") governorByProvince[normalizeProvince(o.province)] = o;
    });
  }

  function govLeafRowHtml(roleLabel, official) {
    return '<li class="tree-node tree-leaf"><div class="tree-row tree-row-leaf">' +
      '<span class="tree-role-label">' + esc(roleLabel) + "</span>" +
      '<a class="tree-name" href="' + personLink(official.person_id) + '">' + esc(titleCase(official.full_name)) + "</a>" +
      '<span class="tree-meta mono">' + fmtYears(official.cumulative_years) + " yrs</span>" +
      "</div></li>";
  }
  function govEmptyRowHtml(text) {
    return '<li class="tree-node tree-leaf"><div class="tree-row tree-row-leaf tree-empty">' + esc(text) + "</div></li>";
  }
  function buildCityChildrenHtml(cityRow) {
    if (!cityRow || !cityRow.full_name) return govEmptyRowHtml("No officials on record for this city.");
    var html = govLeafRowHtml("Mayor", cityRow);
    if (cityRow.vice_mayor) html += govLeafRowHtml("Vice Mayor", cityRow.vice_mayor);
    (cityRow.councilors || []).forEach(function (c) { html += govLeafRowHtml("Councilor", c); });
    return html;
  }
  function govCityRowHtml(provinceKey, cityRow) {
    var mayorBit = cityRow.full_name
      ? 'Mayor <a href="' + personLink(cityRow.person_id) + '">' + esc(titleCase(cityRow.full_name)) + "</a> &middot; " + fmtYears(cityRow.cumulative_years) + " yrs"
      : "No Mayor on record";
    return '<li class="tree-node" data-kind="city" data-province="' + esc(provinceKey) + '" data-city="' + esc(cityRow.city) + '">' +
      '<div class="tree-row" data-toggle tabindex="0" role="button">' +
        '<span class="tree-caret" aria-hidden="true"></span>' +
        '<span class="tree-name">' + esc(titleCase(cityRow.city)) + "</span>" +
        '<span class="tree-role">' + mayorBit + "</span>" +
      "</div>" +
      '<ul class="tree-children" hidden></ul>' +
    "</li>";
  }
  function govProvinceRowHtml(provinceKey) {
    var gov = governorByProvince[provinceKey];
    var cities = (citiesByProvinceNorm[provinceKey] || []).filter(function (c) { return c.city; });
    var govBit = gov
      ? 'Gov. <a href="' + personLink(gov.person_id) + '">' + esc(titleCase(gov.full_name)) + "</a> &middot; " + fmtYears(gov.cumulative_years) + " yrs"
      : "No Governor on record";
    return '<li class="tree-node" data-kind="province" data-province="' + esc(provinceKey) + '">' +
      '<div class="tree-row" data-toggle tabindex="0" role="button">' +
        '<span class="tree-caret" aria-hidden="true"></span>' +
        '<span class="tree-name">' + esc(displayProvinceName(provinceKey)) + "</span>" +
        '<span class="tree-role">' + govBit + "</span>" +
        '<span class="tree-meta">' + cities.length + (cities.length === 1 ? " city" : " cities") + "</span>" +
      "</div>" +
      '<ul class="tree-children" hidden></ul>' +
    "</li>";
  }
  function govRegionRowHtml(regionName) {
    var provinces = REGION_PROVINCES[regionName];
    return '<li class="tree-node" data-kind="region" data-region="' + esc(regionName) + '">' +
      '<div class="tree-row" data-toggle tabindex="0" role="button">' +
        '<span class="tree-caret" aria-hidden="true"></span>' +
        '<span class="tree-name">' + esc(regionName) + "</span>" +
        '<span class="tree-meta">' + provinces.length + (provinces.length === 1 ? " province" : " provinces") + "</span>" +
      "</div>" +
      '<ul class="tree-children" hidden></ul>' +
    "</li>";
  }
  function govTreeHtml() {
    return '<ul class="tree-root"><li class="tree-node tree-node-root">' +
      '<div class="tree-row tree-row-root">' +
        '<span class="tree-name">Philippine local government</span>' +
        '<span class="tree-meta">' + REGION_ORDER.length + " regions &middot; 88 provinces &middot; " + nationalStats.totalCities.toLocaleString() + " cities</span>" +
      "</div>" +
      '<ul class="tree-children">' + REGION_ORDER.map(govRegionRowHtml).join("") + "</ul>" +
    "</li></ul>";
  }
  function toggleGovNode(li, childUl) {
    var kind = li.getAttribute("data-kind");
    if (childUl.getAttribute("data-built") !== "1") {
      if (kind === "region") {
        childUl.innerHTML = REGION_PROVINCES[li.getAttribute("data-region")].map(govProvinceRowHtml).join("");
      } else if (kind === "province") {
        var provinceKey = li.getAttribute("data-province");
        // a handful of Mayor records have no city name on record at all (see
        // the README's "known rough edges"); skip those here the same way
        // the map's own city list already does, rather than show a blank row.
        var cities = (citiesByProvinceNorm[provinceKey] || []).filter(function (c) { return c.city; }).slice()
          .sort(function (a, b) { return (a.city || "").localeCompare(b.city || ""); });
        childUl.innerHTML = cities.length
          ? cities.map(function (c) { return govCityRowHtml(provinceKey, c); }).join("")
          : govEmptyRowHtml("No cities on record for this province.");
      } else if (kind === "city") {
        var pKey = li.getAttribute("data-province");
        var cName = li.getAttribute("data-city");
        var row = (citiesByProvinceNorm[pKey] || []).find(function (c) { return c.city === cName; });
        childUl.innerHTML = buildCityChildrenHtml(row);
      }
      childUl.setAttribute("data-built", "1");
    }
    var isOpen = li.classList.toggle("is-open");
    childUl.hidden = !isOpen;
  }
  function wireGovTree(container) {
    function handle(e) {
      if (e.target.closest("a")) return; // let links navigate, don't also toggle
      var row = e.target.closest(".tree-row[data-toggle]");
      if (!row || !container.contains(row)) return;
      var li = row.parentElement;
      var childUl = li.querySelector(".tree-children");
      if (!childUl) return;
      toggleGovNode(li, childUl);
    }
    container.addEventListener("click", handle);
    container.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!e.target.closest(".tree-row[data-toggle]")) return;
      e.preventDefault();
      handle(e);
    });
  }

  // ------------------------------------------------------------------ router
  var ROUTE_ORDER = ["home", "map", "browse", "compare"];
  function renderRoute() {
    if (currentTeardown) { try { currentTeardown(); } catch (e) { /* noop */ } currentTeardown = null; }
    hideSearchResults();
    var root = document.getElementById("view-root");
    var hash = location.hash.replace(/^#\/?/, "");
    var parts = hash.split("/").filter(Boolean).map(function (p) { return decodeURIComponent(p); });
    var routeKey = parts[0] || "home";
    document.querySelectorAll("#topnav a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === routeKey);
    });
    root.scrollTop = 0;
    try {
      if (parts.length === 0) renderHomePage(root);
      else if (parts[0] === "map") renderMapPage(root);
      else if (parts[0] === "browse") renderBrowsePage(root);
      else if (parts[0] === "compare") renderComparePage(root);
      else if (parts[0] === "person" && parts[1]) renderPersonPage(root, parts[1]);
      else if (parts[0] === "city" && parts[1] && parts[2]) renderCityPage(root, parts[1], parts[2]);
      else renderHomePage(root);
    } catch (err) {
      console.error("Tala Pamahalaan: failed to render route -", hash, err);
      root.innerHTML = '<div class="load-msg">Something went wrong showing this page. ' +
        '<a href="#/">Back to Home</a>.</div>';
    }
  }

  // ------------------------------------------------------------------ global search (topbar)
  function officialSearchMatches(query, limit) {
    var q = query.trim().toLowerCase();
    if (!q) return [];
    var out = [];
    for (var i = 0; i < allOfficials.length && out.length < limit; i++) {
      if (allOfficials[i].full_name.toLowerCase().indexOf(q) !== -1) out.push(allOfficials[i]);
    }
    return out;
  }
  function searchResultRowHtml(o) {
    return '<a class="search-result-row" href="' + personLink(o.person_id) + '" data-person="' + esc(o.person_id) + '">' +
      '<span class="search-result-name">' + esc(titleCase(o.full_name)) + "</span>" +
      '<span class="search-result-meta">' + esc(o.office_name) + "</span></a>";
  }
  function wireGlobalSearch() {
    var input = document.getElementById("global-search");
    var results = document.getElementById("search-results");
    input.addEventListener("input", function () {
      var matches = officialSearchMatches(input.value, 20);
      if (!matches.length) {
        results.innerHTML = input.value.trim()
          ? '<div class="search-empty">No official matches “' + esc(input.value.trim()) + '”.</div>'
          : "";
        results.hidden = !input.value.trim();
        return;
      }
      results.innerHTML = matches.map(searchResultRowHtml).join("");
      results.hidden = false;
    });
    input.addEventListener("focus", function () {
      if (input.value.trim() && !results.innerHTML) input.dispatchEvent(new Event("input"));
      else if (input.value.trim()) results.hidden = false;
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { hideSearchResults(); input.blur(); }
    });
    results.addEventListener("click", function (e) {
      var row = e.target.closest(".search-result-row");
      if (!row) return;
      e.preventDefault();
      input.value = "";
      hideSearchResults();
      location.hash = personLink(row.getAttribute("data-person"));
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-wrap")) hideSearchResults();
    });
  }
  function hideSearchResults() {
    var results = document.getElementById("search-results");
    if (results) { results.hidden = true; }
  }

  // a small reusable typeahead used by the Compare page's two picker inputs
  function attachPickerSearch(inputEl, resultsEl, onPick) {
    inputEl.addEventListener("input", function () {
      var matches = officialSearchMatches(inputEl.value, 12);
      if (!matches.length) {
        resultsEl.innerHTML = inputEl.value.trim()
          ? '<div class="search-empty">No matches.</div>' : "";
        resultsEl.hidden = !inputEl.value.trim();
        return;
      }
      resultsEl.innerHTML = matches.map(function (o) {
        return '<div class="search-result-row" data-person="' + esc(o.person_id) + '">' +
          '<span class="search-result-name">' + esc(titleCase(o.full_name)) + "</span>" +
          '<span class="search-result-meta">' + esc(o.office_name) + "</span></div>";
      }).join("");
      resultsEl.hidden = false;
    });
    resultsEl.addEventListener("click", function (e) {
      var row = e.target.closest(".search-result-row");
      if (!row) return;
      onPick(row.getAttribute("data-person"));
      inputEl.value = "";
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
    });
  }

  // ------------------------------------------------------------------ shared floating tooltip for timeline chips
  var chipTip = null;
  function ensureChipTip() {
    if (chipTip) return chipTip;
    chipTip = document.createElement("div");
    chipTip.className = "chip-tooltip";
    chipTip.setAttribute("role", "tooltip");
    chipTip.hidden = true;
    document.body.appendChild(chipTip);
    return chipTip;
  }
  function showChipTooltip(el, text) {
    var tip = ensureChipTip();
    tip.textContent = text;
    tip.hidden = false;
    tip.classList.remove("chip-tooltip-below");
    var r = el.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left + r.width / 2 - tipRect.width / 2), window.innerWidth - tipRect.width - 8);
    var top = r.top - tipRect.height - 10;
    if (top < 8) { top = r.bottom + 10; tip.classList.add("chip-tooltip-below"); }
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function hideChipTooltip() { if (chipTip) chipTip.hidden = true; }
  function wireChipTooltip(el, text) {
    el.addEventListener("mouseenter", function () { showChipTooltip(el, text); });
    el.addEventListener("mouseleave", hideChipTooltip);
    el.addEventListener("focus", function () { showChipTooltip(el, text); });
    el.addEventListener("blur", hideChipTooltip);
    el.setAttribute("aria-label", text);
  }
  // Draws an actual timeline (a spine with dot markers), not a row of
  // button-like chips: terms are ordered oldest to newest, a line connects
  // consecutive terms, and the currently-focused term gets a larger, filled
  // dot instead of a different background color on a box.
  function renderTimelineChips(track, terms, isFocusedTerm) {
    track.innerHTML = "";
    var ordered = terms.slice().sort(function (a, b) { return a.term_start.localeCompare(b.term_start); });
    ordered.forEach(function (t, i) {
      var isThisSeat = isFocusedTerm ? isFocusedTerm(t) : false;
      var point = document.createElement("div");
      point.className = "timeline-point" + (isThisSeat ? " current" : "");
      point.tabIndex = 0;
      var dot = document.createElement("span");
      dot.className = "timeline-dot";
      var year = document.createElement("span");
      year.className = "timeline-year";
      year.textContent = new Date(t.term_start).getFullYear();
      point.appendChild(dot);
      point.appendChild(year);
      var label = t.office_name + (t.party ? " (" + t.party + ")" : "") +
        ", " + fmtDate(t.term_start) + " to " + fmtDate(t.term_end) +
        (t.how_started === "appointed" ? ", appointed" : ", elected");
      wireChipTooltip(point, label);
      track.appendChild(point);
      if (i < ordered.length - 1) {
        var line = document.createElement("span");
        line.className = "timeline-line";
        track.appendChild(line);
      }
    });
  }
  function howTableRowsHtml(terms) {
    return terms.map(function (t) {
      return "<tr><td>" + new Date(t.term_start).getFullYear() + "</td>" +
        "<td>" + esc(t.office_name) + "</td>" +
        "<td>" + esc(t.party || "no party on record") + "</td>" +
        "<td>" + esc(t.how_started) + "</td>" +
        "<td>" + esc(t.how_ended || "ongoing / not recorded") + "</td></tr>";
    }).join("");
  }

  // ================================================================== HOME
  // No hero banner on purpose: the numbers and the three entry points are the
  // page. Anything explanatory is one line per stat, or tucked into the
  // collapsed "About this data" section at the bottom for whoever wants it.
  function renderHomePage(root) {
    var s = nationalStats;
    root.innerHTML =
      '<div class="page">' +
        '<div class="stat-grid">' +
          statTile(s.totalOfficials.toLocaleString(), "Current officials tracked") +
          statTile(fmtYears(s.avgYears) + " yrs", "Average time in office") +
          statTile(REGION_ORDER.length, "Regions") +
          statTile(s.totalCities.toLocaleString(), "Cities covered") +
        "</div>" +
        '<nav class="quick-links">' +
          '<a href="#/map">Map</a><a href="#/browse">Browse</a><a href="#/compare">Compare</a>' +
        "</nav>" +
        '<div class="section-title">Government hierarchy</div>' +
        '<p class="tree-lede">Region, then province, then city. Open a branch to see who currently holds it, all the way down to every sitting Councilor.</p>' +
        '<div class="gov-tree" id="gov-tree">' + govTreeHtml() + "</div>" +
        '<details class="home-about">' +
          "<summary>About this data</summary>" +
          '<div class="home-about-body">' +
            "<div><h3>Person, not office</h3><p>Tracks the person across every office and term they've " +
            "held, elected or appointed, not just the seat they're in now, so a long career hidden across " +
            "several seats is visible in one place.</p></div>" +
            "<div><h3>Not tracked yet</h3><p>Party-list seats, appointed Executive positions, and the " +
            "Judiciary aren't in this data. Senator, President, and Vice President have too few rows in " +
            "the source to be a complete roster, so the hierarchy above stops at the local government " +
            "level, region down to city, rather than reaching up to a national branch it can't back with " +
            "real records.</p></div>" +
            "<div><h3>How people are matched</h3><p>By name plus province or city, not a government ID, " +
            "since none exists in this data. Someone who moved between office levels may show up as two " +
            "unlinked entries rather than one.</p></div>" +
          "</div>" +
        "</details>" +
      "</div>";
    wireGovTree(document.getElementById("gov-tree"));
  }
  function statTile(value, label) {
    return '<div class="stat-tile"><div class="stat-value mono">' + value + '</div><div class="stat-label">' + label + "</div></div>";
  }

  // ================================================================== MAP
  function renderMapPage(root) {
    root.innerHTML =
      '<div class="map-shell">' +
        '<div class="map-col">' +
          '<div id="map"></div>' +
          '<div class="legend">' +
            '<div class="legend-title" id="legend-title">Years in office (current Governor)</div>' +
            '<div class="legend-bar"></div>' +
            '<div class="legend-scale"><span id="legend-min">…</span><span id="legend-max">…</span></div>' +
            '<div class="legend-note">How many years the current Governor has held any public office, this seat or any other, on record since 2001.</div>' +
          "</div>" +
        "</div>" +
        '<aside class="sidebar"><div class="sidebar-inner">' +
          '<div class="story-intro"><b>Hover or click a province to lock it.</b> Click through to any city to see its full current government, not just the Mayor.</div>' +
          '<div class="stat-row">' +
            '<div class="stat-tile"><div class="stat-value mono" id="stat-national">…</div><div class="stat-label">Avg. years in office</div></div>' +
            '<div class="stat-tile"><div class="stat-value mono" id="stat-provinces">…</div><div class="stat-label">Provinces mapped</div></div>' +
            '<div class="stat-tile"><div class="stat-value mono" id="stat-n">…</div><div class="stat-label">Cities tracked</div></div>' +
          "</div>" +
          '<div class="card" id="detail-card">' +
            '<div class="card-eyebrow-row"><span class="card-eyebrow" id="detail-eyebrow">Now viewing</span>' +
            '<button class="card-reset" id="detail-reset" hidden type="button">Reset to national</button></div>' +
            '<div class="card-province" id="detail-name">Philippines (national)</div>' +
            '<div class="card-figure" id="detail-figure">…</div>' +
            '<div class="card-sub" id="detail-sub">Loading…</div>' +
            '<div class="card-hint" id="detail-hint">Hover or tap a province on the map, or a row below. Click one to lock it.</div>' +
          "</div>" +
          '<div id="rank-lists-wrap">' +
            '<div><div class="section-title">Longest-serving current Governors</div><ul class="rank-list" id="rank-top"></ul></div>' +
            '<div><div class="section-title">Most recently elected Governors</div><ul class="rank-list" id="rank-bottom"></ul></div>' +
          "</div>" +
          '<div id="locality-list-section" hidden>' +
            '<div class="section-title" id="locality-list-title">Cities</div>' +
            '<input type="text" id="locality-search" class="locality-search" placeholder="Search a city…" autocomplete="off">' +
            '<ul class="locality-list" id="locality-list"></ul>' +
          "</div>" +
          '<div id="locality-detail-section" hidden>' +
            '<button class="back-link" id="locality-back" type="button">‹ Back to <span id="locality-back-province">city list</span></button>' +
            '<div class="locality-heading"><div><div class="locality-city" id="locality-city-name">…</div>' +
            '<div class="locality-region" id="locality-region">…</div></div>' +
            '<a class="card-link" id="locality-permalink" href="#">Full city page ↗</a></div>' +
            '<p class="locality-headline" id="locality-headline">Loading…</p>' +
            '<div class="timeline" id="locality-timeline"></div>' +
            '<div id="locality-roster-section"><div class="section-title">Currently serving alongside them</div><ul class="rank-list" id="locality-roster"></ul></div>' +
            '<details class="how-determined"><summary>Full term-by-term record</summary>' +
            '<div class="how-table-scroll"><table class="how-table"><thead><tr><th>Year</th><th>Office</th><th>Party</th><th>How started</th><th>How ended</th></tr></thead>' +
            '<tbody id="locality-how-table-body"></tbody></table></div>' +
            '<p class="how-note">"How ended" is usually unrecorded: the source file only lists who won each election, not why a predecessor left, so that column stays honest about what isn’t known yet rather than guessing.</p>' +
            "</details>" +
          "</div>" +
        "</div></aside>" +
      "</div>";

    var byProvince = {};
    var lockedProvince = null;
    var activeTooltipLayer = null;
    var domainMin = 0, domainMax = 1;

    var features = provincesGeo.features.filter(function (f) { return f.properties.cumulative_years != null; });
    var years = features.map(function (f) { return f.properties.cumulative_years; });
    domainMin = Math.min.apply(null, years);
    domainMax = Math.max.apply(null, years);
    var nationalAvg = years.reduce(function (a, b) { return a + b; }, 0) / years.length;

    document.getElementById("stat-national").textContent = fmtYears(nationalAvg);
    document.getElementById("stat-provinces").textContent = features.length;
    document.getElementById("stat-n").textContent = nationalStats.totalCities.toLocaleString();
    document.getElementById("legend-min").textContent = fmtYears(domainMin) + " yrs";
    document.getElementById("legend-max").textContent = fmtYears(domainMax) + " yrs";

    // sequential ramp: viridis, relative luminance rises monotonically stop to
    // stop, checked not eyeballed. Kept independent of the app's own brand
    // palette on purpose -- a choropleth ramp needs perceptual uniformity,
    // not brand matching.
    var ramp = ["#440154", "#482878", "#3e4a89", "#31688e", "#26828e",
      "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];
    var rampRgb = ramp.map(function (h) {
      h = h.replace("#", "");
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    });
    function colorFor(v, min, max) {
      var t = max > min ? (v - min) / (max - min) : 0;
      t = Math.max(0, Math.min(1, t));
      var pos = t * (rampRgb.length - 1);
      var i = Math.floor(pos);
      var frac = pos - i;
      var a = rampRgb[i], b = rampRgb[Math.min(i + 1, rampRgb.length - 1)];
      return "rgb(" + [
        Math.round(a[0] + (b[0] - a[0]) * frac),
        Math.round(a[1] + (b[1] - a[1]) * frac),
        Math.round(a[2] + (b[2] - a[2]) * frac),
      ].join(",") + ")";
    }

    function paintNational() {
      document.getElementById("detail-eyebrow").textContent = "Now viewing";
      document.getElementById("detail-name").textContent = "Philippines (national)";
      document.getElementById("detail-figure").innerHTML = fmtYears(nationalAvg) + "<sup> yrs avg</sup>";
      document.getElementById("detail-sub").textContent =
        "Average years the current Governor has held office, across every mapped province.";
      document.getElementById("detail-hint").hidden = false;
      document.getElementById("detail-reset").hidden = true;
      document.getElementById("locality-list-section").hidden = true;
      document.getElementById("locality-detail-section").hidden = true;
    }
    function paintProvince(name) {
      var f = provincesGeo.features.find(function (ft) { return canonicalProvinceName(ft.properties.province) === name; });
      if (!f) return;
      var p = f.properties;
      document.getElementById("detail-eyebrow").textContent = "Now viewing";
      document.getElementById("detail-name").textContent = displayProvinceName(name);
      if (p.cumulative_years == null) {
        document.getElementById("detail-figure").textContent = "No Governor";
        document.getElementById("detail-sub").textContent =
          "This area has no province-level Governor on record (Metro Manila is governed differently). Browse its cities below.";
      } else {
        document.getElementById("detail-figure").innerHTML = fmtYears(p.cumulative_years) + "<sup> yrs</sup>";
        document.getElementById("detail-sub").innerHTML =
          "<b>" + esc(p.full_name) + "</b> (" + esc(p.party || "no party on record") + "), Governor since " +
          fmtDate(p.term_start) + ". Total time in any public office: " + fmtYears(p.cumulative_years) +
          ' years. <a class="card-link" href="' + personLink(p.person_id) + '">Full profile ↗</a>';
      }
      document.getElementById("detail-hint").hidden = true;
    }
    function lockTo(name) {
      lockedProvince = name;
      paintProvince(name);
      document.getElementById("detail-reset").hidden = false;
      renderLocalityList(name);
    }
    document.getElementById("detail-reset").addEventListener("click", function () {
      lockedProvince = null;
      Object.keys(byProvince).forEach(function (p) { styleDefault(byProvince[p]); });
      paintNational();
    });

    function refreshRankLists() {
      var sorted = features.slice().sort(function (a, b) { return b.properties.cumulative_years - a.properties.cumulative_years; });
      function row(f) {
        var li = document.createElement("li");
        li.className = "rank-row";
        li.innerHTML = '<span class="rank-name">' + esc(titleCase(f.properties.province)) + "</span>" +
          '<span class="rank-value mono">' + fmtYears(f.properties.cumulative_years) + " yrs</span>";
        li.addEventListener("click", function () { lockTo(f.properties.province); });
        return li;
      }
      var top = document.getElementById("rank-top");
      var bottom = document.getElementById("rank-bottom");
      top.innerHTML = ""; bottom.innerHTML = "";
      sorted.slice(0, 8).forEach(function (f) { top.appendChild(row(f)); });
      sorted.slice(-8).reverse().forEach(function (f) { bottom.appendChild(row(f)); });
    }

    function renderLocalityList(province) {
      var cities = (citiesByProvinceNorm[normalizeProvince(province)] || [])
        .filter(function (c) { return c.city; })
        .slice().sort(function (a, b) { return a.city.localeCompare(b.city); });
      document.getElementById("locality-list-title").textContent = "Cities in " + displayProvinceName(province);
      var list = document.getElementById("locality-list");
      list.innerHTML = "";
      cities.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "locality-row";
        li.innerHTML = '<span class="locality-dot"></span><span>' + esc(titleCase(c.city)) + "</span>" +
          '<span class="rank-value mono" style="margin-left:auto;">' + fmtYears(c.cumulative_years) + " yrs</span>";
        li.addEventListener("click", function () { showLocalityDetail(c, c, "Mayor"); });
        list.appendChild(li);
      });
      document.getElementById("locality-list-section").hidden = false;
      document.getElementById("locality-detail-section").hidden = true;
      document.getElementById("locality-back-province").textContent = displayProvinceName(province);
    }
    document.getElementById("locality-search").addEventListener("input", function (e) {
      var q = e.target.value.trim().toLowerCase();
      document.querySelectorAll("#locality-list .locality-row").forEach(function (row) {
        row.style.display = row.textContent.toLowerCase().indexOf(q) === -1 ? "none" : "";
      });
    });
    document.getElementById("locality-back").addEventListener("click", function () {
      document.getElementById("locality-list-section").hidden = false;
      document.getElementById("locality-detail-section").hidden = true;
    });

    function renderRoster(cityRow, focusPerson) {
      var list = document.getElementById("locality-roster");
      list.innerHTML = "";
      var seats = [{ title: "Mayor", person: cityRow }];
      if (cityRow.vice_mayor) seats.push({ title: "Vice Mayor", person: cityRow.vice_mayor });
      (cityRow.councilors || []).forEach(function (c) { seats.push({ title: "Councilor", person: c }); });
      seats.forEach(function (seat) {
        var isFocused = seat.person.person_id === focusPerson.person_id && seat.person.term_start === focusPerson.term_start;
        var li = document.createElement("li");
        li.className = "rank-row" + (isFocused ? " roster-focused" : "");
        li.innerHTML = '<span class="rank-name">' + esc(seat.person.full_name) + "</span>" +
          '<span class="rank-value mono">' + seat.title + "</span>";
        if (!isFocused) li.addEventListener("click", function () { showLocalityDetail(cityRow, seat.person, seat.title); });
        list.appendChild(li);
      });
      document.getElementById("locality-roster-section").hidden = seats.length <= 1;
    }

    function showLocalityDetail(cityRow, focusPerson, focusTitle) {
      var person = timelines[focusPerson.person_id];
      document.getElementById("locality-list-section").hidden = true;
      document.getElementById("locality-detail-section").hidden = false;
      document.getElementById("locality-city-name").textContent = titleCase(cityRow.city);
      document.getElementById("locality-region").textContent = displayProvinceName(lockedProvince);
      document.getElementById("locality-permalink").setAttribute("href", cityLink(lockedProvince, cityRow.city));

      renderRoster(cityRow, focusPerson);

      if (!person) {
        document.getElementById("locality-headline").textContent = "No linked career record for this officeholder yet.";
        document.getElementById("locality-timeline").innerHTML = "";
        return;
      }
      var terms = person.terms;
      var otherOffices = {};
      terms.forEach(function (t) { if (t.term_start !== focusPerson.term_start) otherOffices[t.office_name] = true; });
      var otherCount = Object.keys(otherOffices).length;

      document.getElementById("locality-headline").innerHTML =
        "<b>" + esc(person.full_name) + "</b> (current " + esc(focusTitle) + " of " + esc(titleCase(cityRow.city)) +
        ") has held public office for a total of " + fmtYears(person.cumulative_years) +
        " years, across " + terms.length + " term" + (terms.length === 1 ? "" : "s") + (otherCount
          ? ", including time in " + otherCount + " other position" + (otherCount === 1 ? "" : "s") + " beyond this seat."
          : ".") +
        ' <a class="card-link" href="' + personLink(focusPerson.person_id) + '">Full profile ↗</a>';

      renderTimelineChips(document.getElementById("locality-timeline"), terms, function (t) { return t.term_start === focusPerson.term_start; });
      document.getElementById("locality-how-table-body").innerHTML = howTableRowsHtml(terms);
    }

    function styleDefault(lyr) { lyr.setStyle({ weight: 1.1, color: oceanColor() }); }
    function styleHover(lyr) { lyr.setStyle({ weight: 2.4, color: "#ffffff" }); }
    function oceanColor() { return getComputedStyle(document.documentElement).getPropertyValue("--surface-page").trim() || "#f4f4f4"; }

    var map = null;
    var onResize = null;
    try {
      if (typeof L === "undefined") throw new Error("Leaflet did not load");
      map = L.map("map", { zoomControl: true, attributionControl: false, minZoom: 5, maxZoom: 9, zoomSnap: 0.25 });
      var layer = L.geoJSON(provincesGeo, {
        style: function (feature) {
          var p = feature.properties;
          var fill = p.cumulative_years != null ? colorFor(p.cumulative_years, domainMin, domainMax) : "#2a2a2a";
          return { fillColor: fill, fillOpacity: 0.92, color: oceanColor(), weight: 1.1 };
        },
        onEachFeature: function (feature, lyr) {
          var p = feature.properties;
          if (!p.province) return; // a stray boundary shape with no province name at all, nothing to bind
          var name = canonicalProvinceName(p.province);
          if (p.cumulative_years != null) {
            lyr.bindTooltip(
              '<span class="tip-name">' + esc(titleCase(name)) + "</span><br>" +
              '<span class="tip-share">' + esc(p.full_name) + ", " + fmtYears(p.cumulative_years) + " yrs</span>",
              { className: "province-tip", sticky: true, direction: "top", offset: [0, -6] }
            );
          } else {
            // Metro Manila's 4 districts (Manila included): no province-level
            // Governor exists to show, but they're still clickable through to
            // their own city list, same as any other province.
            lyr.bindTooltip(
              '<span class="tip-name">' + esc(displayProvinceName(name)) + "</span><br>" +
              '<span class="tip-share">No Governor, click to browse cities</span>',
              { className: "province-tip", sticky: true, direction: "top", offset: [0, -6] }
            );
          }
          // Track the one tooltip currently open and force-close it before
          // opening the next: fast mouse movement (or a jump across a gap
          // between disjoint island shapes) can skip firing mouseout on the
          // previous layer, and Leaflet also opens a tooltip on "click" (its
          // built-in touch-tap support), which mouseover/mouseout tracking
          // alone never sees on a touch device with no hover at all. Both
          // paths route through this same tracker so nothing is left stuck.
          function trackActiveTooltip() {
            if (activeTooltipLayer && activeTooltipLayer !== lyr) activeTooltipLayer.closeTooltip();
            activeTooltipLayer = lyr;
          }
          lyr.on("mouseover", function () {
            trackActiveTooltip();
            if (name !== lockedProvince) { styleHover(lyr); if (!lockedProvince) paintProvince(name); }
          });
          lyr.on("mouseout", function () {
            if (activeTooltipLayer === lyr) { lyr.closeTooltip(); activeTooltipLayer = null; }
            if (name !== lockedProvince) { styleDefault(lyr); if (!lockedProvince) paintNational(); }
          });
          lyr.on("click", function () { trackActiveTooltip(); lockTo(name); });
          byProvince[name] = lyr;
        },
      }).addTo(map);
      map.fitBounds(layer.getBounds(), { padding: [20, 20] });
      onResize = function () { map.invalidateSize(); };
      window.addEventListener("resize", onResize);
      map.getContainer().addEventListener("mouseleave", function () {
        if (activeTooltipLayer) { activeTooltipLayer.closeTooltip(); activeTooltipLayer = null; }
      });
      window.__talaMap = map;
      window.__talaLayer = layer;
    } catch (err) {
      console.error("Tala Pamahalaan: map failed to initialize -", err);
      document.getElementById("map").innerHTML =
        '<div style="padding:24px;color:var(--text-muted);font-size:14px;line-height:1.5;">The map layer ' +
        "failed to load (likely a blocked script host or an offline network). The province breakdown and " +
        "rankings on the right are unaffected.</div>";
    }

    paintNational();
    refreshRankLists();

    currentTeardown = function () {
      if (onResize) window.removeEventListener("resize", onResize);
      if (map) { try { map.remove(); } catch (e) { /* noop */ } }
    };
  }

  // ================================================================== BROWSE
  var browseState = { branch: "", position: "", province: "", party: "", minYears: "", name: "", sortCol: "cumulative_years", sortDir: "desc" };
  function renderBrowsePage(root) {
    var provinces = Array.from(new Set(allOfficials.map(function (o) { return o.province; }).filter(Boolean))).sort();
    var parties = Array.from(new Set(allOfficials.map(function (o) { return o.party; }).filter(Boolean))).sort();
    root.innerHTML =
      '<div class="page page-wide">' +
        '<div class="page-header"><div class="eyebrow">Nationwide</div>' +
        '<h1 class="page-title">Browse every current official</h1>' +
        '<p class="page-lede">' + nationalStats.totalOfficials.toLocaleString() + " officials across every province, filterable by branch, position, party, and years in office. Click any row for that person's full career.</p></div>" +
        '<div class="filter-bar">' +
          filterField("filter-branch", "Branch", ['<option value="">All branches</option><option value="executive">Executive</option><option value="legislative">Legislative</option>']) +
          filterField("filter-position", "Position", ['<option value="">All positions</option><option>Governor</option><option>Mayor</option><option>Vice Mayor</option><option>Councilor</option>']) +
          filterField("filter-province", "Province", ['<option value="">All provinces</option>'].concat(provinces.map(function (p) { return '<option value="' + esc(p) + '">' + esc(titleCase(p)) + "</option>"; }))) +
          filterField("filter-party", "Party", ['<option value="">All parties</option>'].concat(parties.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }))) +
          '<div class="filter-field"><label for="filter-minyears">Min. years</label><input type="number" id="filter-minyears" min="0" step="1" placeholder="0"></div>' +
          '<div class="filter-field"><label for="filter-name">Name contains</label><input type="text" id="filter-name" placeholder="Search within results…"></div>' +
          '<button class="filter-clear" id="filter-clear-btn" type="button">Clear filters</button>' +
          '<span class="filter-count" id="filter-count"></span>' +
        "</div>" +
        '<div class="table-scroll"><table class="results-table"><thead><tr>' +
          '<th data-col="full_name">Name</th><th data-col="position">Position</th><th data-col="office_name">Office / location</th>' +
          '<th data-col="party">Party</th><th data-col="cumulative_years" class="sorted">Years in office</th>' +
          '</tr></thead><tbody id="browse-body"></tbody></table></div>' +
      "</div>";

    ["filter-branch", "filter-position", "filter-province", "filter-party"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", function (e) {
        var key = id === "filter-branch" ? "branch" : id === "filter-position" ? "position" : id === "filter-province" ? "province" : "party";
        browseState[key] = e.target.value;
        applyBrowseFilters();
      });
    });
    var debounceTimer = null;
    function debouncedFilter() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyBrowseFilters, 120);
    }
    document.getElementById("filter-minyears").addEventListener("input", function (e) { browseState.minYears = e.target.value; debouncedFilter(); });
    document.getElementById("filter-name").addEventListener("input", function (e) { browseState.name = e.target.value; debouncedFilter(); });
    document.getElementById("filter-clear-btn").addEventListener("click", function () {
      browseState = { branch: "", position: "", province: "", party: "", minYears: "", name: "", sortCol: "cumulative_years", sortDir: "desc" };
      renderBrowsePage(root);
    });
    document.querySelectorAll(".results-table thead th").forEach(function (th) {
      th.addEventListener("click", function () {
        var col = th.getAttribute("data-col");
        if (browseState.sortCol === col) browseState.sortDir = browseState.sortDir === "desc" ? "asc" : "desc";
        else { browseState.sortCol = col; browseState.sortDir = col === "full_name" || col === "office_name" ? "asc" : "desc"; }
        applyBrowseFilters();
      });
    });
    // restore previous filter values into the freshly-rendered controls
    document.getElementById("filter-branch").value = browseState.branch;
    document.getElementById("filter-position").value = browseState.position;
    document.getElementById("filter-province").value = browseState.province;
    document.getElementById("filter-party").value = browseState.party;
    document.getElementById("filter-minyears").value = browseState.minYears;
    document.getElementById("filter-name").value = browseState.name;

    applyBrowseFilters();
  }
  function filterField(id, label, optionsHtmlArr) {
    return '<div class="filter-field"><label for="' + id + '">' + label + '</label><select id="' + id + '">' + optionsHtmlArr.join("") + "</select></div>";
  }
  var BROWSE_LIMIT = 300;
  function applyBrowseFilters() {
    var s = browseState;
    var minY = parseFloat(s.minYears);
    var nameQ = s.name.trim().toLowerCase();
    var filtered = allOfficials.filter(function (o) {
      if (s.branch && o.branch !== s.branch) return false;
      if (s.position && o.position !== s.position) return false;
      if (s.province && o.province !== s.province) return false;
      if (s.party && o.party !== s.party) return false;
      if (!isNaN(minY) && o.cumulative_years < minY) return false;
      if (nameQ && o.full_name.toLowerCase().indexOf(nameQ) === -1) return false;
      return true;
    });
    var col = s.sortCol, dir = s.sortDir === "asc" ? 1 : -1;
    filtered.sort(function (a, b) {
      var av = a[col], bv = b[col];
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return ((av || 0) - (bv || 0)) * dir;
    });
    document.querySelectorAll(".results-table thead th").forEach(function (th) {
      th.classList.toggle("sorted", th.getAttribute("data-col") === col);
      th.classList.toggle("asc", th.getAttribute("data-col") === col && s.sortDir === "asc");
    });
    var body = document.getElementById("browse-body");
    var shown = filtered.slice(0, BROWSE_LIMIT);
    if (!shown.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No officials match these filters.</div></td></tr>';
    } else {
      body.innerHTML = shown.map(function (o) {
        return '<tr data-person="' + esc(o.person_id) + '">' +
          "<td>" + esc(titleCase(o.full_name)) + "</td>" +
          '<td><span class="pill' + (o.branch === "legislative" ? " legislative" : "") + '">' + esc(o.position) + "</span></td>" +
          "<td>" + esc(o.office_name) + "</td>" +
          "<td>" + esc(o.party || "no party on record") + "</td>" +
          '<td class="num">' + fmtYears(o.cumulative_years) + "</td></tr>";
      }).join("");
    }
    document.querySelectorAll("#browse-body tr[data-person]").forEach(function (tr) {
      tr.addEventListener("click", function () { location.hash = personLink(tr.getAttribute("data-person")); });
    });
    var countLabel = filtered.length > BROWSE_LIMIT
      ? "Showing top " + BROWSE_LIMIT + " of " + filtered.length.toLocaleString() + " matching, narrow the filters to see more"
      : "Showing " + filtered.length.toLocaleString() + " of " + allOfficials.length.toLocaleString();
    document.getElementById("filter-count").textContent = countLabel;
  }

  // ================================================================== COMPARE
  function renderComparePage(root) {
    root.innerHTML =
      '<div class="page">' +
        '<div class="page-header"><div class="eyebrow">Side by side</div>' +
        '<h1 class="page-title">Compare two careers</h1>' +
        '<p class="page-lede">Search for any two current officials to compare how long each has actually held public office, and in what.</p></div>' +
        '<div class="compare-pickers">' +
          compareSlotHtml("a") +
          compareSlotHtml("b") +
        "</div>" +
        '<div id="compare-output"></div>' +
      "</div>";

    ["a", "b"].forEach(function (slot) {
      var input = document.getElementById("compare-input-" + slot);
      var results = document.getElementById("compare-results-" + slot);
      if (!input || !results) return; // this slot is already filled, no picker input rendered for it
      attachPickerSearch(input, results, function (personId) {
        if (slot === "a") compareSlotA = personId; else compareSlotB = personId;
        renderComparePage(root);
      });
    });
    document.querySelectorAll(".compare-slot-clear").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.getAttribute("data-slot") === "a") compareSlotA = null; else compareSlotB = null;
        renderComparePage(root);
      });
    });
    renderCompareOutput();
  }
  function compareSlotHtml(slot) {
    var personId = slot === "a" ? compareSlotA : compareSlotB;
    var official = personId ? allOfficials.find(function (o) { return o.person_id === personId; }) : null;
    var filled = official
      ? '<div class="compare-slot-name">' + esc(titleCase(official.full_name)) + "</div>" +
        '<div class="compare-slot-meta">' + esc(official.office_name) + "</div>" +
        '<button class="compare-slot-clear" type="button" data-slot="' + slot + '">Change</button>'
      : '<div class="compare-slot-empty">No one selected yet</div>';
    return '<div class="compare-picker">' +
      (official ? "" : '<input type="text" id="compare-input-' + slot + '" class="global-search" style="padding-left:12px;margin-bottom:8px;" placeholder="Search official ' + (slot === "a" ? "A" : "B") + '…" autocomplete="off">' +
        '<div id="compare-results-' + slot + '" class="search-results" style="position:static;box-shadow:none;border:none;padding:0;" hidden></div>') +
      '<div class="compare-slot">' + filled + "</div></div>";
  }
  function renderCompareOutput() {
    var out = document.getElementById("compare-output");
    if (!compareSlotA || !compareSlotB) { out.innerHTML = ""; return; }
    var oa = allOfficials.find(function (o) { return o.person_id === compareSlotA; });
    var ob = allOfficials.find(function (o) { return o.person_id === compareSlotB; });
    if (!oa || !ob) { out.innerHTML = ""; return; }
    out.innerHTML = '<div class="compare-grid">' + compareColHtml(oa) + compareColHtml(ob) + "</div>";
  }
  function compareColHtml(o) {
    var person = timelines[o.person_id];
    var terms = person ? person.terms.slice().sort(function (a, b) { return b.term_start.localeCompare(a.term_start); }) : [];
    return '<div class="compare-col">' +
      '<div class="card-eyebrow">' + esc(o.position) + "</div>" +
      '<div class="card-province" style="margin-top:4px;"><a class="card-link" style="font:inherit;color:inherit;text-decoration:none" href="' + personLink(o.person_id) + '">' + esc(titleCase(o.full_name)) + "</a></div>" +
      '<div class="card-sub">' + esc(o.office_name) + (o.party ? " · " + esc(o.party) : "") + "</div>" +
      '<div class="compare-figure">' + fmtYears(o.cumulative_years) + "<sup> yrs total</sup></div>" +
      '<ul class="compare-terms">' + terms.map(function (t) {
        return "<li><b>" + new Date(t.term_start).getFullYear() + "</b>, " + esc(t.office_name) + (t.party ? " (" + esc(t.party) + ")" : "") + "</li>";
      }).join("") + "</ul>" +
    "</div>";
  }

  // ================================================================== PERSON
  function renderPersonPage(root, personId) {
    var person = timelines[personId];
    var official = allOfficials.find(function (o) { return o.person_id === personId; });
    if (!person || !official) {
      root.innerHTML = '<div class="page"><div class="load-msg">No record found for this person. ' +
        '<a href="#/browse">Browse every official</a> or <a href="#/">go home</a>.</div></div>';
      return;
    }
    var terms = person.terms.slice().sort(function (a, b) { return b.term_start.localeCompare(a.term_start); });
    var cityHref = official.city ? cityLink(official.province, official.city) : null;

    root.innerHTML =
      '<div class="page">' +
        '<div class="page-header"><div class="eyebrow">Current ' + esc(official.position) + "</div>" +
        '<h1 class="page-title">' + esc(titleCase(person.full_name)) + "</h1>" +
        '<p class="page-lede">' + esc(official.office_name) + (official.party ? " · " + esc(official.party) : "") +
        " · in office since " + fmtDate(official.term_start) + "</p></div>" +
        '<div class="card" style="max-width:340px;">' +
          '<div class="card-eyebrow">Total time in any public office</div>' +
          '<div class="card-figure">' + fmtYears(person.cumulative_years) + "<sup> yrs</sup></div>" +
          '<div class="card-sub">Across ' + terms.length + " term" + (terms.length === 1 ? "" : "s") + " on record since 2001.</div>" +
        "</div>" +
        '<div class="btn-row">' +
          (cityHref ? '<a class="btn" href="' + cityHref + '">View full ' + esc(titleCase(official.city)) + " government ↗</a>" : "") +
          '<a class="btn" href="#/map">View on the map</a>' +
          '<button class="btn btn-primary" id="compare-cta" type="button">Compare with someone else</button>' +
        "</div>" +
        '<div class="home-section">' +
          "<h2>Full career timeline</h2>" +
          '<div class="timeline" id="person-timeline"></div>' +
          '<details class="how-determined" open><summary>Full term-by-term record</summary>' +
          '<div class="how-table-scroll"><table class="how-table"><thead><tr><th>Year</th><th>Office</th><th>Party</th><th>How started</th><th>How ended</th></tr></thead>' +
          '<tbody>' + howTableRowsHtml(terms) + "</tbody></table></div></details>" +
        "</div>" +
        partyTreeHtml(official) +
      "</div>";

    renderTimelineChips(document.getElementById("person-timeline"), terms, function (t) { return t.term_start === official.term_start; });
    document.getElementById("compare-cta").addEventListener("click", function () {
      compareSlotA = personId;
      location.hash = "#/compare";
    });
  }

  // a party/group node tree: the party as a root node, other current
  // officials under that same party as children, connected with drawn
  // lines rather than an indented bullet list, so the shared affiliation
  // reads as a structure rather than a sentence.
  function partyTreeHtml(official) {
    if (!official.party) return "";
    var peers = allOfficials.filter(function (o) { return o.party === official.party && o.person_id !== official.person_id; });
    if (!peers.length) return "";
    peers.sort(function (a, b) { return b.cumulative_years - a.cumulative_years; });
    var PARTY_TREE_LIMIT = 15;
    var shown = peers.slice(0, PARTY_TREE_LIMIT);
    var more = peers.length - shown.length;
    var childrenHtml = shown.map(function (p) {
      return '<a class="party-node" href="' + personLink(p.person_id) + '">' + esc(titleCase(p.full_name)) +
        '<span class="party-node-meta">' + esc(p.position) + ", " + fmtYears(p.cumulative_years) + " yrs</span></a>";
    }).join("");
    if (more > 0) {
      childrenHtml += '<span class="party-node muted">+' + more + " more</span>";
    }
    return '<div class="home-section">' +
      "<h2>Same party</h2>" +
      '<div class="party-tree">' +
        '<span class="party-node root">' + esc(official.party) +
        '<span class="party-node-meta">' + (peers.length + 1).toLocaleString() + " current officials nationwide</span></span>" +
        '<span class="party-tree-stem"></span>' +
        '<div class="party-tree-children">' + childrenHtml + "</div>" +
      "</div>" +
    "</div>";
  }

  // ================================================================== CITY
  function renderCityPage(root, provinceParam, cityParam) {
    var cities = citiesByProvinceNorm[normalizeProvince(provinceParam)] || [];
    var cityRow = cities.find(function (c) { return (c.city || "").toUpperCase() === cityParam.toUpperCase(); });
    if (!cityRow) {
      root.innerHTML = '<div class="page"><div class="load-msg">No record found for this city. ' +
        '<a href="#/map">Explore the map</a> or <a href="#/">go home</a>.</div></div>';
      return;
    }
    var seats = [{ title: "Mayor", person: cityRow }];
    if (cityRow.vice_mayor) seats.push({ title: "Vice Mayor", person: cityRow.vice_mayor });
    (cityRow.councilors || []).forEach(function (c) { seats.push({ title: "Councilor", person: c }); });

    root.innerHTML =
      '<div class="page">' +
        '<div class="page-header"><div class="eyebrow">' + esc(displayProvinceName(provinceParam)) + "</div>" +
        '<h1 class="page-title">' + esc(titleCase(cityRow.city)) + "</h1>" +
        '<p class="page-lede">The current local government on record: ' + seats.length + " seat" + (seats.length === 1 ? "" : "s") + ", led by Mayor " + esc(titleCase(cityRow.full_name)) + ".</p></div>" +
        '<div class="section-title">Currently serving</div>' +
        '<ul class="rank-list">' + seats.map(function (seat) {
          return '<li><a class="rank-row" href="' + personLink(seat.person.person_id) + '">' +
            '<span class="rank-name">' + esc(titleCase(seat.person.full_name)) + "</span>" +
            '<span class="rank-value mono">' + seat.title + " · " + fmtYears(seat.person.cumulative_years) + " yrs</span></a></li>";
        }).join("") + "</ul>" +
        '<div class="btn-row"><a class="btn" href="#/map">View ' + esc(displayProvinceName(provinceParam)) + " on the map</a></div>" +
      "</div>";
  }
})();
