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

  // A second, independent hierarchy over the same 19,647 officials: branch
  // (executive/legislative, a real field on every row) then party (also a
  // real field, just often blank), instead of geography. Answers "who's in
  // this party" the same structural way the map answers "who governs this
  // province" -- a tree you open, not a sentence you have to already know
  // to search for.
  var BRANCH_LABELS = { executive: "Executive branch", legislative: "Legislative branch" };
  var BRANCH_ORDER = ["executive", "legislative"];
  var NO_PARTY_KEY = "__NONE__"; // sentinel for "party is blank on this record", shared with Browse's filter
  var PARTY_LEAF_CAP = 30; // officials shown per party node before paging
  var PARTY_BRANCH_CAP = 15; // parties shown directly under a branch before paging (there are 91-109 distinct parties per branch)
  var CITY_PAGE_CAP = 15; // cities shown directly under a province before paging (Cebu alone has 57)
  var COUNCILOR_PAGE_CAP = 12; // councilors shown under a city before paging (Mayor/Vice Mayor always shown; 39 cities have more than 15 councilors on record)

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
  // ---- branch/party list rows (same shape as the region/province rows
  // above, grouped by o.branch then o.party instead of by geography) ----
  function officialsByBranch(branchKey) {
    return allOfficials.filter(function (o) { return o.branch === branchKey; });
  }
  function partyGroupsForBranch(branchKey) {
    var byParty = {};
    officialsByBranch(branchKey).forEach(function (o) {
      var key = o.party || NO_PARTY_KEY;
      (byParty[key] = byParty[key] || []).push(o);
    });
    return Object.keys(byParty).sort(function (a, b) { return byParty[b].length - byParty[a].length; })
      .map(function (key) { return { key: key, officials: byParty[key] }; });
  }
  function officialsForParty(branchKey, partyKey) {
    return officialsByBranch(branchKey).filter(function (o) { return (o.party || NO_PARTY_KEY) === partyKey; })
      .slice().sort(function (a, b) { return b.cumulative_years - a.cumulative_years; });
  }
  function govBranchRowHtml(branchKey) {
    var count = officialsByBranch(branchKey).length;
    return '<li class="tree-node" data-kind="branch" data-branch="' + esc(branchKey) + '">' +
      '<div class="tree-row" data-toggle tabindex="0" role="button">' +
        '<span class="tree-caret" aria-hidden="true"></span>' +
        '<span class="tree-name">' + esc(BRANCH_LABELS[branchKey]) + "</span>" +
        '<span class="tree-meta">' + count.toLocaleString() + " officials</span>" +
      "</div>" +
      '<ul class="tree-children" hidden></ul>' +
    "</li>";
  }
  function govPartyRowHtml(branchKey, partyKey, count) {
    var label = partyKey === NO_PARTY_KEY ? "No party on record" : partyKey;
    return '<li class="tree-node" data-kind="party" data-branch="' + esc(branchKey) + '" data-party="' + esc(partyKey) + '">' +
      '<div class="tree-row" data-toggle tabindex="0" role="button">' +
        '<span class="tree-caret" aria-hidden="true"></span>' +
        '<span class="tree-name">' + esc(label) + "</span>" +
        '<span class="tree-meta">' + count.toLocaleString() + (count === 1 ? " official" : " officials") + "</span>" +
      "</div>" +
      '<ul class="tree-children" hidden></ul>' +
    "</li>";
  }
  // An in-place pager (up/down, "X-Y of Z"), not a link that leaves the
  // page: some parties run into the hundreds of officials, so "see
  // everything" means paging through it right here. A small "view in
  // Browse" link stays as an escape hatch for whoever prefers the table.
  // Page position is keyed by branch/party and shared with the diagram, so
  // switching views mid-browse doesn't reset your place (see
  // hierarchyPageState, defined with the diagram engine below).
  // browseFilter is a subset of {branch, party, province} -- whatever the
  // paged list was grouped by -- so the escape-hatch link can jump to
  // Browse pre-filtered to the same slice, however it was reached.
  function govPagerHtml(key, page, total, pageSize, browseFilter) {
    var totalPages = Math.ceil(total / pageSize);
    if (totalPages <= 1) return "";
    browseFilter = browseFilter || {};
    var from = page * pageSize + 1, to = Math.min(total, (page + 1) * pageSize);
    return '<li class="tree-node tree-leaf tree-pager" data-pager-key="' + esc(key) + '">' +
      '<div class="tree-pager-row">' +
        '<button type="button" class="tree-pager-btn" data-pager-dir="up"' + (page <= 0 ? " disabled" : "") + ' aria-label="Previous page">&#9650;</button>' +
        '<span class="tree-pager-label">' + from + "–" + to + " of " + total.toLocaleString() + "</span>" +
        '<button type="button" class="tree-pager-btn" data-pager-dir="down"' + (page >= totalPages - 1 ? " disabled" : "") + ' aria-label="Next page">&#9660;</button>' +
        '<a class="tree-pager-browse" href="#/browse" data-browse-branch="' + esc(browseFilter.branch || "") + '" data-browse-party="' + esc(browseFilter.party || "") + '" ' +
        'data-browse-province="' + esc(browseFilter.province || "") + '">View in Browse ↗</a>' +
      "</div></li>";
  }
  // dispatches a paged-list key ("branch:<b>", "party:<b>:<p>",
  // "province:<p>", "city:<p>:<c>") back to the function that rendered it,
  // so a single pager click handler can re-render any of the four without
  // needing to know which one it's looking at ahead of time.
  function rerenderPagedList(key) {
    var i = key.indexOf(":");
    var kind = key.slice(0, i), rest = key.slice(i + 1);
    if (kind === "branch") return renderPartyGroupPage(rest);
    if (kind === "province") return renderProvinceCitiesPage(rest);
    if (kind === "party" || kind === "city") {
      var j = rest.indexOf(":");
      var a = rest.slice(0, j), b = rest.slice(j + 1);
      return kind === "party" ? renderPartyOfficialsPage(a, b) : renderCityOfficialsPage(a, b);
    }
    return "";
  }
  function renderPartyGroupPage(branchKey) {
    var key = "branch:" + branchKey;
    var groups = partyGroupsForBranch(branchKey);
    var page = pageFor(key);
    var pageGroups = groups.slice(page * PARTY_BRANCH_CAP, (page + 1) * PARTY_BRANCH_CAP);
    var html = pageGroups.map(function (g) { return govPartyRowHtml(branchKey, g.key, g.officials.length); }).join("");
    return (html || govEmptyRowHtml("No officials on record for this branch.")) +
      govPagerHtml(key, page, groups.length, PARTY_BRANCH_CAP, { branch: branchKey });
  }
  function renderPartyOfficialsPage(branchKey, partyKey) {
    var key = "party:" + branchKey + ":" + partyKey;
    var officials = officialsForParty(branchKey, partyKey);
    var page = pageFor(key);
    var pageOfficials = officials.slice(page * PARTY_LEAF_CAP, (page + 1) * PARTY_LEAF_CAP);
    var html = pageOfficials.map(function (o) { return govLeafRowHtml(o.position, o); }).join("");
    return (html || govEmptyRowHtml("No officials on record for this party.")) +
      govPagerHtml(key, page, officials.length, PARTY_LEAF_CAP, { branch: branchKey, party: partyKey });
  }
  function citiesForProvince(provinceKey) {
    return (citiesByProvinceNorm[provinceKey] || []).filter(function (c) { return c.city; }).slice()
      .sort(function (a, b) { return (a.city || "").localeCompare(b.city || ""); });
  }
  function renderProvinceCitiesPage(provinceKey) {
    var key = "province:" + provinceKey;
    var cities = citiesForProvince(provinceKey);
    var page = pageFor(key);
    var pageCities = cities.slice(page * CITY_PAGE_CAP, (page + 1) * CITY_PAGE_CAP);
    var html = pageCities.map(function (c) { return govCityRowHtml(provinceKey, c); }).join("");
    return (html || govEmptyRowHtml("No cities on record for this province.")) +
      govPagerHtml(key, page, cities.length, CITY_PAGE_CAP, { province: provinceKey });
  }
  function renderCityOfficialsPage(provinceKey, cityName) {
    var row = citiesForProvince(provinceKey).find(function (c) { return c.city === cityName; });
    if (!row || !row.full_name) return govEmptyRowHtml("No officials on record for this city.");
    var key = "city:" + provinceKey + ":" + cityName;
    var councilors = row.councilors || [];
    var page = pageFor(key);
    var pageCouncilors = councilors.slice(page * COUNCILOR_PAGE_CAP, (page + 1) * COUNCILOR_PAGE_CAP);
    var html = govLeafRowHtml("Mayor", row);
    if (row.vice_mayor) html += govLeafRowHtml("Vice Mayor", row.vice_mayor);
    html += pageCouncilors.map(function (c) { return govLeafRowHtml("Councilor", c); }).join("");
    return html + govPagerHtml(key, page, councilors.length, COUNCILOR_PAGE_CAP, { province: provinceKey });
  }
  function partyTreeHtmlRoot() {
    return '<ul class="tree-root"><li class="tree-node tree-node-root">' +
      '<div class="tree-row tree-row-root">' +
        '<span class="tree-name">Officials by branch and party</span>' +
        '<span class="tree-meta">' + nationalStats.totalOfficials.toLocaleString() + " officials &middot; " + BRANCH_ORDER.length + " branches</span>" +
      "</div>" +
      '<ul class="tree-children">' + BRANCH_ORDER.map(govBranchRowHtml).join("") + "</ul>" +
    "</li></ul>";
  }
  function toggleGovNode(li, childUl) {
    var kind = li.getAttribute("data-kind");
    if (childUl.getAttribute("data-built") !== "1") {
      if (kind === "region") {
        childUl.innerHTML = REGION_PROVINCES[li.getAttribute("data-region")].map(govProvinceRowHtml).join("");
      } else if (kind === "province") {
        childUl.innerHTML = renderProvinceCitiesPage(li.getAttribute("data-province"));
      } else if (kind === "city") {
        childUl.innerHTML = renderCityOfficialsPage(li.getAttribute("data-province"), li.getAttribute("data-city"));
      } else if (kind === "branch") {
        childUl.innerHTML = renderPartyGroupPage(li.getAttribute("data-branch"));
      } else if (kind === "party") {
        childUl.innerHTML = renderPartyOfficialsPage(li.getAttribute("data-branch"), li.getAttribute("data-party"));
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
    // the pager row: up/down page in place, or the "View in Browse" link
    // jumps out pre-filtered to whatever slice it was paging.
    container.addEventListener("click", function (e) {
      var btn = e.target.closest(".tree-pager-btn");
      if (btn) {
        var pagerLi = btn.closest(".tree-pager");
        var key = pagerLi.getAttribute("data-pager-key");
        setPage(key, pageFor(key) + (btn.getAttribute("data-pager-dir") === "up" ? -1 : 1));
        pagerLi.parentElement.innerHTML = rerenderPagedList(key);
        return;
      }
      var browseLink = e.target.closest(".tree-pager-browse");
      if (!browseLink) return;
      applyBrowseHierarchyFilter({
        branch: browseLink.getAttribute("data-browse-branch"),
        party: browseLink.getAttribute("data-browse-party"),
        province: browseLink.getAttribute("data-browse-province"),
      });
    });
  }

  // ------------------------------------------------------------------ government hierarchy DIAGRAM
  // A pannable, zoomable node-and-connector view of the same hierarchy the
  // list above renders, for actually seeing the shape of the structure (how
  // wide a region is, how big a city council is) rather than reading it as
  // text rows. Deliberately a separate small data model (plain JS objects
  // with lazily-built .children) instead of reusing the list's HTML-string
  // builders, since a diagram needs real x/y coordinates to lay out and draw
  // connectors from, not markup. Grows downward (depth = row, siblings
  // spread left-right within a row), the familiar org-chart shape, rather
  // than left-to-right.
  var DIAG_LEVEL_H = 150;    // vertical gap between one depth level (row) and the next
  var DIAG_NODE_W = 232;     // fixed card width, must match the CSS .diagram-node width exactly
  var DIAG_NODE_ANCHOR_H = 64; // assumed card height, used only to anchor connector curves
  var DIAG_SIBLING_W = 260;  // horizontal slot per leaf-equivalent column
  // one hue (red), three monotone-lightness steps, validated with the
  // dataviz skill's ordinal-ramp check against every surface this app draws
  // a diagram node on (light: card #ffffff 3.01:1, sunken #ececec 2.55:1;
  // dark: card #1c1c1c 2.29:1, sunken #0a0a0a 2.65:1, all >= the 2:1 ordinal
  // floor). Used only here and shared by both hierarchy diagrams (geography
  // and branch/party) so "top tier" and "bottom tier" read the same way in
  // either one; leaf officials stay neutral in both.
  var DIAG_LEVEL_COLOR = {
    region: "#ec6d6d", province: "#d62a2a", city: "#a71b1b",
    branch: "#ec6d6d", party: "#d62a2a",
  };

  function govDiagramRegionNode(regionName) {
    var provinces = REGION_PROVINCES[regionName];
    return {
      id: "region:" + regionName, kind: "region", label: regionName,
      meta: provinces.length + (provinces.length === 1 ? " province" : " provinces"),
      expanded: false, childrenLoaded: false, children: [], regionName: regionName,
    };
  }
  function govDiagramProvinceNode(provinceKey) {
    var gov = governorByProvince[provinceKey];
    var cityCount = (citiesByProvinceNorm[provinceKey] || []).filter(function (c) { return c.city; }).length;
    return {
      id: "province:" + provinceKey, kind: "province", label: displayProvinceName(provinceKey),
      roleLabel: gov ? "Gov." : null,
      personLabel: gov ? titleCase(gov.full_name) : "No Governor on record",
      personHref: gov ? personLink(gov.person_id) : null,
      years: gov ? fmtYears(gov.cumulative_years) + " yrs" : null,
      meta: cityCount + (cityCount === 1 ? " city" : " cities"),
      expanded: false, childrenLoaded: false, children: [], provinceKey: provinceKey,
    };
  }
  function govDiagramCityNode(provinceKey, cityRow) {
    return {
      id: "city:" + provinceKey + ":" + cityRow.city, kind: "city", label: titleCase(cityRow.city),
      roleLabel: cityRow.full_name ? "Mayor" : null,
      personLabel: cityRow.full_name ? titleCase(cityRow.full_name) : "No Mayor on record",
      personHref: cityRow.full_name ? personLink(cityRow.person_id) : null,
      years: cityRow.full_name ? fmtYears(cityRow.cumulative_years) + " yrs" : null,
      meta: null,
      expanded: false, childrenLoaded: false, children: [], provinceKey: provinceKey, cityName: cityRow.city,
    };
  }
  function govDiagramOfficialNode(roleLabel, official) {
    return {
      id: "official:" + official.person_id + ":" + roleLabel, kind: "official",
      label: titleCase(official.full_name), roleLabel: roleLabel,
      years: fmtYears(official.cumulative_years) + " yrs", personHref: personLink(official.person_id),
      expanded: false, childrenLoaded: true, children: [],
    };
  }
  function govDiagramRoot() {
    return {
      id: "root", kind: "root", label: "Philippine local government",
      meta: REGION_ORDER.length + " regions &middot; 88 provinces &middot; " + nationalStats.totalCities.toLocaleString() + " cities",
      expanded: true, childrenLoaded: true, children: REGION_ORDER.map(govDiagramRegionNode),
    };
  }
  // ---- branch/party diagram nodes (same node shape, grouped by o.branch
  // and o.party instead of geography; see the list-view versions above) ----
  function govDiagramBranchNode(branchKey) {
    return {
      id: "branch:" + branchKey, kind: "branch", label: BRANCH_LABELS[branchKey],
      meta: officialsByBranch(branchKey).length.toLocaleString() + " officials",
      expanded: false, childrenLoaded: false, children: [], branchKey: branchKey,
    };
  }
  function govDiagramPartyNode(branchKey, partyKey, count) {
    var label = partyKey === NO_PARTY_KEY ? "No party on record" : partyKey;
    return {
      id: "party:" + branchKey + ":" + partyKey, kind: "party", label: label,
      meta: count.toLocaleString() + (count === 1 ? " official" : " officials"),
      expanded: false, childrenLoaded: false, children: [], branchKey: branchKey, partyKey: partyKey,
    };
  }
  function govDiagramPartyOfficialNode(o) {
    return {
      id: "party-official:" + o.person_id + ":" + o.term_start, kind: "official",
      label: titleCase(o.full_name), roleLabel: o.position,
      years: fmtYears(o.cumulative_years) + " yrs", personHref: personLink(o.person_id),
      location: o.office_name,
      expanded: false, childrenLoaded: true, children: [],
    };
  }
  // A compact in-canvas pager (up/down arrows + "X-Y of Z"), not a link that
  // leaves the page: there are 90-100+ parties per branch and some parties
  // run into the hundreds of officials, so "view everything" has to mean
  // paging through it right here, not a hard cap with an escape hatch.
  // Page position is shared with the list view via a common key, so
  // switching views mid-browse doesn't reset your place.
  var hierarchyPageState = {};
  function pageFor(key) { return hierarchyPageState[key] || 0; }
  function setPage(key, page) { hierarchyPageState[key] = Math.max(0, page); }
  function govDiagramPagerNode(parentId, key, browseFilter, page, total, pageSize) {
    return {
      id: "pager:" + key, kind: "pager", parentId: parentId, pagerKey: key,
      page: page, total: total, pageSize: pageSize,
      expanded: false, childrenLoaded: true, children: [], browseFilter: browseFilter || {},
    };
  }
  function govDiagramPartyRoot() {
    return {
      id: "party-root", kind: "root", label: "Officials by branch and party",
      meta: nationalStats.totalOfficials.toLocaleString() + " officials &middot; " + BRANCH_ORDER.length + " branches",
      expanded: true, childrenLoaded: true, children: BRANCH_ORDER.map(govDiagramBranchNode),
    };
  }
  function govDiagramLoadChildren(node) {
    if (node.childrenLoaded) return;
    if (node.kind === "region") {
      node.children = REGION_PROVINCES[node.regionName].map(govDiagramProvinceNode);
    } else if (node.kind === "province") {
      var pKeyC = "province:" + node.provinceKey;
      var cities = citiesForProvince(node.provinceKey);
      var pageC = pageFor(pKeyC);
      var pageCities = cities.slice(pageC * CITY_PAGE_CAP, (pageC + 1) * CITY_PAGE_CAP);
      var kidsC = pageCities.map(function (c) { return govDiagramCityNode(node.provinceKey, c); });
      if (cities.length > CITY_PAGE_CAP) {
        kidsC.push(govDiagramPagerNode(node.id, pKeyC, { province: node.provinceKey }, pageC, cities.length, CITY_PAGE_CAP));
      }
      node.children = kidsC;
    } else if (node.kind === "city") {
      var row = citiesForProvince(node.provinceKey).find(function (c) { return c.city === node.cityName; });
      var kids = [];
      if (row && row.full_name) {
        kids.push(govDiagramOfficialNode("Mayor", row));
        if (row.vice_mayor) kids.push(govDiagramOfficialNode("Vice Mayor", row.vice_mayor));
        var pKeyO = "city:" + node.provinceKey + ":" + node.cityName;
        var councilors = row.councilors || [];
        var pageO = pageFor(pKeyO);
        var pageCouncilors = councilors.slice(pageO * COUNCILOR_PAGE_CAP, (pageO + 1) * COUNCILOR_PAGE_CAP);
        pageCouncilors.forEach(function (c) { kids.push(govDiagramOfficialNode("Councilor", c)); });
        if (councilors.length > COUNCILOR_PAGE_CAP) {
          kids.push(govDiagramPagerNode(node.id, pKeyO, { province: node.provinceKey }, pageO, councilors.length, COUNCILOR_PAGE_CAP));
        }
      }
      node.children = kids;
    } else if (node.kind === "branch") {
      var pKey1 = "branch:" + node.branchKey;
      var groups = partyGroupsForBranch(node.branchKey);
      var page1 = pageFor(pKey1);
      var pageGroups = groups.slice(page1 * PARTY_BRANCH_CAP, (page1 + 1) * PARTY_BRANCH_CAP);
      var kids3 = pageGroups.map(function (g) { return govDiagramPartyNode(node.branchKey, g.key, g.officials.length); });
      if (groups.length > PARTY_BRANCH_CAP) {
        kids3.push(govDiagramPagerNode(node.id, pKey1, { branch: node.branchKey }, page1, groups.length, PARTY_BRANCH_CAP));
      }
      node.children = kids3;
    } else if (node.kind === "party") {
      var pKey2 = "party:" + node.branchKey + ":" + node.partyKey;
      var officials = officialsForParty(node.branchKey, node.partyKey);
      var page2 = pageFor(pKey2);
      var pageOfficials = officials.slice(page2 * PARTY_LEAF_CAP, (page2 + 1) * PARTY_LEAF_CAP);
      var kids2 = pageOfficials.map(govDiagramPartyOfficialNode);
      if (officials.length > PARTY_LEAF_CAP) {
        kids2.push(govDiagramPagerNode(node.id, pKey2, { branch: node.branchKey, party: node.partyKey }, page2, officials.length, PARTY_LEAF_CAP));
      }
      node.children = kids2;
    }
    node.childrenLoaded = true;
  }
  function govDiagramFindById(node, id) {
    if (node.id === id) return node;
    for (var i = 0; i < node.children.length; i++) {
      var found = govDiagramFindById(node.children[i], id);
      if (found) return found;
    }
    return null;
  }
  function govDiagramLayout(root) {
    function measure(node, depth) {
      node.y = depth * DIAG_LEVEL_H;
      if (!node.expanded || !node.children.length) { node._subW = DIAG_SIBLING_W; return node._subW; }
      var w = 0;
      node.children.forEach(function (c) { w += measure(c, depth + 1); });
      node._subW = Math.max(w, DIAG_SIBLING_W);
      return node._subW;
    }
    measure(root, 0);
    function place(node, left) {
      node.x = left + node._subW / 2;
      if (node.expanded && node.children.length) {
        var cursor = left;
        node.children.forEach(function (c) { place(c, cursor); cursor += c._subW; });
      }
    }
    place(root, 0);
  }
  function govDiagramFlatten(root) {
    var nodes = [], edges = [];
    function walk(node, parent) {
      nodes.push(node);
      if (parent) edges.push([parent, node]);
      if (node.expanded) node.children.forEach(function (c) { walk(c, node); });
    }
    walk(root, null);
    return { nodes: nodes, edges: edges };
  }
  function govDiagramEdgePath(a, b) {
    var x1 = a.x, y1 = a.y + DIAG_NODE_ANCHOR_H, x2 = b.x, y2 = b.y, midY = (y1 + y2) / 2;
    var color = DIAG_LEVEL_COLOR[b.kind] || "var(--border-strong)";
    return '<path d="M' + x1 + "," + y1 + " C" + x1 + "," + midY + " " + x2 + "," + midY + " " + x2 + "," + y2 +
      '" class="diagram-edge" style="stroke:' + color + '" />';
  }
  var DIAG_TOGGLEABLE = { region: 1, province: 1, city: 1, branch: 1, party: 1 };
  function govDiagramNodeHtml(node) {
    var toggleable = !!DIAG_TOGGLEABLE[node.kind];
    var cls = "diagram-node diagram-node-" + node.kind + (node.expanded ? " is-open" : "");
    var style = "left:" + (node.x - DIAG_NODE_W / 2) + "px;top:" + node.y + "px;";
    var accent = DIAG_LEVEL_COLOR[node.kind];
    if (accent) style += "--diagram-accent:" + accent + ";";
    var inner;
    if (node.kind === "root" || node.kind === "region" || node.kind === "branch") {
      inner = '<div class="diagram-node-title">' + esc(node.label) + "</div>" +
        '<div class="diagram-node-meta">' + node.meta + "</div>";
    } else if (node.kind === "party") {
      inner = '<div class="diagram-node-title">' + esc(node.label) + "</div>" +
        '<div class="diagram-node-meta">' + esc(node.meta) + "</div>";
    } else if (node.kind === "province" || node.kind === "city") {
      var personBit = node.personHref
        ? (node.roleLabel ? esc(node.roleLabel) + " " : "") + '<a href="' + node.personHref + '">' + esc(node.personLabel) + "</a>" + (node.years ? " &middot; " + node.years : "")
        : '<span class="diagram-node-empty">' + esc(node.personLabel) + "</span>";
      inner = '<div class="diagram-node-title">' + esc(node.label) + "</div>" +
        '<div class="diagram-node-meta">' + personBit + "</div>" +
        (node.meta ? '<div class="diagram-node-count">' + esc(node.meta) + "</div>" : "");
    } else if (node.kind === "pager") {
      var totalPages = Math.ceil(node.total / node.pageSize);
      var from = node.page * node.pageSize + 1, to = Math.min(node.total, (node.page + 1) * node.pageSize);
      inner = '<div class="diagram-pager">' +
          '<button type="button" class="diagram-pager-btn" data-pager-dir="up" data-pager-id="' + esc(node.id) + '"' + (node.page <= 0 ? " disabled" : "") + ' aria-label="Previous page">&#9650;</button>' +
          '<div class="diagram-pager-count">' + from + "–" + to + " of " + node.total.toLocaleString() + "</div>" +
          '<button type="button" class="diagram-pager-btn" data-pager-dir="down" data-pager-id="' + esc(node.id) + '"' + (node.page >= totalPages - 1 ? " disabled" : "") + ' aria-label="Next page">&#9660;</button>' +
        "</div>" +
        '<a class="diagram-pager-browse" href="#/browse" data-browse-branch="' + esc(node.browseFilter.branch || "") + '" ' +
        'data-browse-party="' + esc(node.browseFilter.party || "") + '" data-browse-province="' + esc(node.browseFilter.province || "") + '">View all in Browse</a>';
    } else {
      inner = '<div class="diagram-node-role">' + esc(node.roleLabel) + "</div>" +
        '<div class="diagram-node-title"><a href="' + node.personHref + '">' + esc(node.label) + "</a></div>" +
        '<div class="diagram-node-meta">' + esc(node.years) + "</div>" +
        (node.location ? '<div class="diagram-node-count">' + esc(node.location) + "</div>" : "");
    }
    return '<div class="' + cls + '" style="' + style + '" data-id="' + esc(node.id) + '"' +
      (toggleable ? ' data-toggle tabindex="0" role="button"' : "") + ">" +
      (toggleable ? '<span class="diagram-caret" aria-hidden="true"></span>' : "") +
      '<div class="diagram-node-body">' + inner + "</div></div>";
  }
  function renderGovDiagram(root, viewport) {
    govDiagramLayout(root);
    var flat = govDiagramFlatten(root);
    var maxX = DIAG_SIBLING_W, maxY = DIAG_LEVEL_H;
    flat.nodes.forEach(function (n) {
      maxX = Math.max(maxX, n.x + DIAG_NODE_W / 2);
      maxY = Math.max(maxY, n.y + DIAG_NODE_ANCHOR_H + 40);
    });
    var canvas = viewport.querySelector(".diagram-canvas");
    canvas.style.width = (maxX + 40) + "px";
    canvas.style.height = (maxY + 40) + "px";
    canvas.innerHTML =
      '<svg class="diagram-edges" width="' + (maxX + 40) + '" height="' + (maxY + 40) + '">' +
        flat.edges.map(function (e) { return govDiagramEdgePath(e[0], e[1]); }).join("") +
      "</svg>" +
      flat.nodes.map(govDiagramNodeHtml).join("");
  }
  function wireGovDiagram(viewport, toolbar, root) {
    var canvas = viewport.querySelector(".diagram-canvas");
    var panX = 24, panY = 24, zoom = 1;
    var MIN_Z = 0.3, MAX_Z = 2;
    var canvasW = 0, canvasH = 0; // unscaled content size, refreshed on every render
    var PAN_SLACK = 150; // how far past the content's true edge you can still drag, so it never fully disappears but also never feels boxed-in
    // Keeps the canvas from being dragged or zoomed away into empty space:
    // the diagram can only pan within its own content size plus a little
    // slack, so you can always find your way back without hunting.
    function clampPan(x, y) {
      if (!canvasW || !canvasH) return { x: x, y: y };
      var rect = viewport.getBoundingClientRect();
      var contentW = canvasW * zoom, contentH = canvasH * zoom;
      var minX = Math.min(0, rect.width - contentW) - PAN_SLACK, maxXPan = PAN_SLACK;
      var minY = Math.min(0, rect.height - contentH) - PAN_SLACK, maxYPan = PAN_SLACK;
      return {
        x: Math.max(minX, Math.min(maxXPan, x)),
        y: Math.max(minY, Math.min(maxYPan, y)),
      };
    }
    function applyTransform() {
      var clamped = clampPan(panX, panY);
      panX = clamped.x; panY = clamped.y;
      canvas.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
    }
    function rerender() {
      renderGovDiagram(root, viewport);
      canvasW = canvas.offsetWidth; canvasH = canvas.offsetHeight;
      applyTransform();
    }
    rerender();
    resetView(); // center the root horizontally instead of an arbitrary fixed offset

    // After expanding a branch, its new children can land off-screen (the
    // whole point of a country-sized tree is that most of it isn't visible
    // at once), which reads as "I clicked and nothing happened." Snap-pan the
    // toggled node to a fixed, comfortable spot instead, with room below it
    // for whatever just opened.
    function animatePanTo(targetPanX, targetPanY) {
      canvas.classList.add("is-animating");
      panX = targetPanX; panY = targetPanY;
      applyTransform();
      window.setTimeout(function () { canvas.classList.remove("is-animating"); }, 280);
    }
    function panToReveal(node) {
      var rect = viewport.getBoundingClientRect();
      var targetScreenY = Math.min(70, rect.height * 0.14);
      var targetScreenX = rect.width * 0.5;
      animatePanTo(targetScreenX - node.x * zoom, targetScreenY - node.y * zoom);
    }
    function toggleNode(node) {
      if (!node.childrenLoaded) govDiagramLoadChildren(node);
      node.expanded = !node.expanded;
      rerender();
      if (node.expanded) panToReveal(node);
    }

    var dragging = false, dragged = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
    function pointerDown(x, y) {
      dragging = true; dragged = false;
      startX = x; startY = y; startPanX = panX; startPanY = panY;
      viewport.classList.add("is-dragging");
    }
    function pointerMove(x, y) {
      if (!dragging) return;
      var dx = x - startX, dy = y - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
      if (dragged) { panX = startPanX + dx; panY = startPanY + dy; applyTransform(); }
    }
    function pointerUp() { dragging = false; viewport.classList.remove("is-dragging"); }

    function onMouseDown(e) { if (e.button === 0) pointerDown(e.clientX, e.clientY); }
    function onMouseMove(e) { pointerMove(e.clientX, e.clientY); }
    function onMouseUp() { pointerUp(); }
    function onTouchStart(e) { if (e.touches.length === 1) pointerDown(e.touches[0].clientX, e.touches[0].clientY); }
    function onTouchMove(e) { if (e.touches.length === 1) { pointerMove(e.touches[0].clientX, e.touches[0].clientY); if (dragged) e.preventDefault(); } }
    function onTouchEnd() { pointerUp(); }
    function onWheel(e) {
      e.preventDefault();
      var rect = viewport.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      var newZoom = Math.min(MAX_Z, Math.max(MIN_Z, zoom * factor));
      panX = mx - (mx - panX) * (newZoom / zoom);
      panY = my - (my - panY) * (newZoom / zoom);
      zoom = newZoom;
      applyTransform();
    }
    function onClick(e) {
      if (dragged) { dragged = false; e.preventDefault(); return; }
      var pagerBtn = e.target.closest(".diagram-pager-btn");
      if (pagerBtn) {
        var pnode = govDiagramFindById(root, pagerBtn.getAttribute("data-pager-id"));
        if (pnode) {
          setPage(pnode.pagerKey, pageFor(pnode.pagerKey) + (pagerBtn.getAttribute("data-pager-dir") === "up" ? -1 : 1));
          var parent = govDiagramFindById(root, pnode.parentId);
          if (parent) { parent.childrenLoaded = false; govDiagramLoadChildren(parent); }
          rerender();
        }
        return;
      }
      var browseLink = e.target.closest(".diagram-pager-browse");
      if (browseLink) {
        applyBrowseHierarchyFilter({
          branch: browseLink.getAttribute("data-browse-branch"),
          party: browseLink.getAttribute("data-browse-party"),
          province: browseLink.getAttribute("data-browse-province"),
        });
        return; // let the real <a href> navigate too
      }
      if (e.target.closest("a")) return;
      var el = e.target.closest(".diagram-node[data-toggle]");
      if (!el) return;
      var node = govDiagramFindById(root, el.getAttribute("data-id"));
      if (!node) return;
      toggleNode(node);
    }
    function onKeydown(e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var el = e.target.closest(".diagram-node[data-toggle]");
      if (!el) return;
      e.preventDefault();
      var node = govDiagramFindById(root, el.getAttribute("data-id"));
      if (!node) return;
      toggleNode(node);
    }
    function zoomBy(factor) {
      var rect = viewport.getBoundingClientRect();
      var mx = rect.width / 2, my = rect.height / 2;
      var newZoom = Math.min(MAX_Z, Math.max(MIN_Z, zoom * factor));
      panX = mx - (mx - panX) * (newZoom / zoom);
      panY = my - (my - panY) * (newZoom / zoom);
      zoom = newZoom;
      applyTransform();
    }
    function resetView() {
      // canvasW/canvasH (used by clampPan) were measured by the mount-time
      // rerender() call, which can happen while this panel is still
      // [hidden] -- display:none, so canvas.offsetWidth/Height come back 0
      // and clampPan silently stops clamping (its own zero-size guard).
      // Re-measure here too, since resetView() is exactly the function the
      // Map page calls once this panel is actually shown for the first time.
      canvasW = canvas.offsetWidth; canvasH = canvas.offsetHeight;
      zoom = 1;
      var rect = viewport.getBoundingClientRect();
      panX = rect.width / 2 - root.x * zoom;
      panY = 24;
      applyTransform();
    }

    viewport.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: false });
    viewport.addEventListener("touchend", onTouchEnd);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("click", onClick);
    viewport.addEventListener("keydown", onKeydown);

    var zoomInBtn = toolbar.querySelector("[data-diagram-zoom-in]");
    var zoomOutBtn = toolbar.querySelector("[data-diagram-zoom-out]");
    var resetBtn = toolbar.querySelector("[data-diagram-reset]");
    if (zoomInBtn) zoomInBtn.addEventListener("click", function () { zoomBy(1.25); });
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", function () { zoomBy(1 / 1.25); });
    if (resetBtn) resetBtn.addEventListener("click", resetView);

    return {
      teardown: function () {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      },
      // exposed so the Map page can re-center this diagram the first time
      // its panel actually becomes visible -- while hidden ([hidden] is
      // display:none), the viewport has no real size yet, so centering
      // math run at mount time would center against a 0x0 box.
      resetView: resetView,
    };
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
  // No hero banner on purpose: the numbers and three big entry cards are the
  // page. The government hierarchy now lives on the Map page (as one of its
  // three views), so Home's only job is the national headline numbers and a
  // fast, obvious way into Map, Browse, or Compare.
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
        '<div class="entry-cards">' +
          '<a class="entry-card" href="#/map">' +
            '<div class="entry-card-title">Map</div>' +
            '<div class="entry-card-desc">The province choropleth, plus the full government hierarchy by region and by party, one switch away.</div>' +
            '<div class="entry-card-go">Open the map &rarr;</div>' +
          "</a>" +
          '<a class="entry-card" href="#/browse">' +
            '<div class="entry-card-title">Browse</div>' +
            '<div class="entry-card-desc">Every current official nationwide in one table, filterable by branch, position, province, party, and years in office.</div>' +
            '<div class="entry-card-go">Browse officials &rarr;</div>' +
          "</a>" +
          '<a class="entry-card" href="#/compare">' +
            '<div class="entry-card-title">Compare</div>' +
            '<div class="entry-card-desc">Put any two current officials side by side, full career timeline included.</div>' +
            '<div class="entry-card-go">Compare two &rarr;</div>' +
          "</a>" +
        "</div>" +
        '<details class="home-about">' +
          "<summary>About this data</summary>" +
          '<div class="home-about-body">' +
            "<div><h3>Person, not office</h3><p>Tracks the person across every office and term they've " +
            "held, elected or appointed, not just the seat they're in now, so a long career hidden across " +
            "several seats is visible in one place.</p></div>" +
            "<div><h3>Not tracked yet</h3><p>Party-list seats, appointed Executive positions, and the " +
            "Judiciary aren't in this data. Senator, President, and Vice President have too few rows in " +
            "the source to be a complete roster, so both hierarchies on the Map page stop at what these " +
            "19,647 current local and legislative records can actually back.</p></div>" +
            "<div><h3>How people are matched</h3><p>By name plus province or city, not a government ID, " +
            "since none exists in this data. Someone who moved between office levels may show up as two " +
            "unlinked entries rather than one.</p></div>" +
          "</div>" +
        "</details>" +
      "</div>";
  }
  function statTile(value, label) {
    return '<div class="stat-tile"><div class="stat-value mono">' + value + '</div><div class="stat-label">' + label + "</div></div>";
  }

  // shared by both hierarchy views on the Map page: the toolbar + diagram +
  // list markup is identical, only the ids/lede/diagram-root differ.
  function hierarchyPanelHtml(opts) {
    return '<div class="tree-head">' +
        '<div>' +
          '<div class="section-title">' + esc(opts.title) + "</div>" +
          '<p class="tree-lede">' + opts.lede + "</p>" +
        "</div>" +
        '<div class="diagram-toolbar" id="' + opts.prefix + '-diagram-toolbar">' +
          '<button type="button" data-diagram-zoom-out title="Zoom out" aria-label="Zoom out">&minus;</button>' +
          '<button type="button" data-diagram-reset title="Reset view">Reset</button>' +
          '<button type="button" data-diagram-zoom-in title="Zoom in" aria-label="Zoom in">+</button>' +
          '<button type="button" class="view-toggle" id="' + opts.prefix + '-view-toggle">List view</button>' +
        "</div>" +
      "</div>" +
      '<div class="diagram-viewport" id="' + opts.prefix + '-diagram" tabindex="0"><div class="diagram-canvas"></div></div>' +
      '<div class="gov-tree" id="' + opts.prefix + '-tree" hidden>' + opts.treeHtml + "</div>";
  }
  function wireHierarchyPanel(prefix, diagramRoot) {
    wireGovTree(document.getElementById(prefix + "-tree"));
    var diagramViewport = document.getElementById(prefix + "-diagram");
    var diagramToolbar = document.getElementById(prefix + "-diagram-toolbar");
    var listEl = document.getElementById(prefix + "-tree");
    var toggleBtn = document.getElementById(prefix + "-view-toggle");
    var diagramHandle = wireGovDiagram(diagramViewport, diagramToolbar, diagramRoot);
    // Panning and zooming a canvas is a desktop-shaped interaction; on a
    // phone-width screen the diagram's first frame is mostly cut-off cards
    // with nothing to explain why, so start on the fully-usable list there
    // instead. Diagram view stays one tap away either way.
    if (window.innerWidth < 720) {
      listEl.hidden = false;
      diagramViewport.hidden = true;
      diagramToolbar.hidden = true;
      toggleBtn.textContent = "Diagram view";
    }
    toggleBtn.addEventListener("click", function () {
      var showingList = !listEl.hidden;
      listEl.hidden = showingList;
      diagramViewport.hidden = !showingList;
      diagramToolbar.hidden = !showingList;
      toggleBtn.textContent = showingList ? "List view" : "Diagram view";
      // the panel's own [hidden] state doesn't affect the diagram viewport
      // (list/diagram toggle within the same panel, which is already
      // visible), but re-centering here too is cheap insurance and covers
      // the case where the diagram is revealed for the first time this way.
      if (!diagramViewport.hidden) diagramHandle.resetView();
    });
    return diagramHandle;
  }

  // ================================================================== MAP
  // Three views behind one switch: the province choropleth (the original
  // page), and the two hierarchy trees that used to live on Home. Moving
  // them here means "explore the map" and "explore the org chart" are the
  // same page, not two things to remember separately.
  var MAP_VIEWS = ["map", "geo", "party"];
  function renderMapPage(root) {
    root.innerHTML =
      '<div class="map-view-root">' +
        '<div class="view-switch" id="map-view-switch">' +
          '<button type="button" data-view="map">Map</button>' +
          '<button type="button" data-view="geo">Region hierarchy</button>' +
          '<button type="button" data-view="party">Party &amp; branch</button>' +
        "</div>" +
        '<div class="map-view-panel" id="panel-map">' + mapShellHtml() + "</div>" +
        '<div class="map-view-panel hierarchy-panel" id="panel-geo" hidden>' +
          hierarchyPanelHtml({
            prefix: "geo", title: "Government hierarchy by region",
            lede: "Region, then province, then city. Open a branch to see who currently holds it, all the way down to every sitting Councilor.",
            treeHtml: govTreeHtml(),
          }) +
        "</div>" +
        '<div class="map-view-panel hierarchy-panel" id="panel-party" hidden>' +
          hierarchyPanelHtml({
            prefix: "party", title: "Government hierarchy by branch and party",
            lede: "Executive, then Legislative, then every party with a current officeholder. Open one to see exactly who's in it, from Governors down to Councilors.",
            treeHtml: partyTreeHtmlRoot(),
          }) +
        "</div>" +
      "</div>";

    var mapTeardown = mountMap(root);
    var geoHandle = wireHierarchyPanel("geo", govDiagramRoot());
    var partyHandle = wireHierarchyPanel("party", govDiagramPartyRoot());

    var panels = { map: document.getElementById("panel-map"), geo: document.getElementById("panel-geo"), party: document.getElementById("panel-party") };
    var switchEl = document.getElementById("map-view-switch");
    // Both hierarchy panels are mounted (and their diagrams laid out) while
    // still [hidden] -- display:none, so getBoundingClientRect() on their
    // viewport is 0x0 at that point and any centering math run then is
    // garbage. Re-run resetView() the first time each panel is actually
    // shown, once its viewport has a real size.
    var revealed = { geo: false, party: false };
    function setView(view) {
      MAP_VIEWS.forEach(function (v) { panels[v].hidden = v !== view; });
      switchEl.querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-view") === view); });
      // the Leaflet map's internal size cache goes stale while its panel is
      // display:none; refresh it whenever the Map view becomes visible again.
      if (view === "map" && window.__talaMap) window.__talaMap.invalidateSize();
      if ((view === "geo" || view === "party") && !revealed[view]) {
        revealed[view] = true;
        (view === "geo" ? geoHandle : partyHandle).resetView();
      }
    }
    switchEl.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-view]");
      if (btn) setView(btn.getAttribute("data-view"));
    });
    setView("map");

    currentTeardown = function () {
      if (mapTeardown) mapTeardown();
      if (geoHandle) geoHandle.teardown();
      if (partyHandle) partyHandle.teardown();
    };
  }
  function mapShellHtml() {
    return (
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
      "</div>"
    );
  }
  // All the map's interaction logic, split out from its markup (mapShellHtml
  // above) so renderMapPage can build the DOM for all three views first and
  // mount each one's behavior after, the same shape as wireHierarchyPanel.
  function mountMap(root) {
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

    // sequential ramp: dark red -> yellow, one continuous hue sweep (0deg
    // to 48deg) with relative luminance rising monotonically stop to stop
    // (checked, not eyeballed -- see the values in the comment below), so
    // it reads red at the low end and yellow at the high end, not the
    // black/purple start a full inferno or viridis ramp would have.
    // #760505 .0397  #9e1807 .0794  #c53409 .1435  #ed590c .2518
    // #f48930 .3734  #f5b258 .5196  #f7d281 .6745  #f9e9a9 .8128
    var ramp = ["#760505", "#9e1807", "#c53409", "#ed590c",
      "#f48930", "#f5b258", "#f7d281", "#f9e9a9"];
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

    return function () {
      if (onResize) window.removeEventListener("resize", onResize);
      if (map) { try { map.remove(); } catch (e) { /* noop */ } }
    };
  }

  // ================================================================== BROWSE
  var browseState = { branch: "", position: "", province: "", party: "", minYears: "", name: "", sortCol: "cumulative_years", sortDir: "desc" };
  // Used by both hierarchy trees' "+N more" links: jump to Browse pre-filtered
  // to exactly the branch/party the list was folded from, rather than a dead
  // end at the leaf cap.
  function applyBrowseHierarchyFilter(filter) {
    filter = filter || {};
    browseState = {
      branch: filter.branch || "", position: "", province: filter.province || "",
      party: filter.party || "", minYears: "", name: "",
      sortCol: "cumulative_years", sortDir: "desc",
    };
    location.hash = "#/browse";
  }
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
          filterField("filter-party", "Party", ['<option value="">All parties</option><option value="' + NO_PARTY_KEY + '">No party on record</option>'].concat(parties.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }))) +
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
      if (s.party === NO_PARTY_KEY) { if (o.party) return false; }
      else if (s.party && o.party !== s.party) return false;
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
    out.innerHTML = compareTimelineChartHtml(oa, ob) +
      '<div class="compare-grid">' + compareColHtml(oa) + compareColHtml(ob) + "</div>";
  }
  // A real, from-the-actual-data comparison chart: every term each of the two
  // has held, laid out on one shared calendar-year axis so overlap and gaps
  // are visible at a glance. Not a vote breakdown, this data has no vote
  // counts or precinct-level results anywhere (the source file only records
  // who won each race; see the README's "known rough edges" and "what isn't
  // here yet"), so this is the honest version of "richer comparison": real
  // term_start/term_end spans, not invented turnout numbers.
  var COMPARE_COLOR_A = { light: "#2a78d6", dark: "#3987e5" }; // dataviz reference palette, categorical slot 1
  var COMPARE_COLOR_B = { light: "#eb6834", dark: "#d95926" }; // categorical slot 2
  function compareTimelineChartHtml(oa, ob) {
    var pa = timelines[oa.person_id], pb = timelines[ob.person_id];
    var termsA = pa ? pa.terms.slice() : [];
    var termsB = pb ? pb.terms.slice() : [];
    var allTerms = termsA.concat(termsB);
    if (!allTerms.length) return "";
    var today = new Date();
    function yearFrac(dateStr) {
      var d = new Date(dateStr + "T00:00:00");
      return d.getFullYear() + d.getMonth() / 12 + d.getDate() / 365;
    }
    var starts = allTerms.map(function (t) { return yearFrac(t.term_start); });
    var ends = allTerms.map(function (t) { return yearFrac(t.term_end || today.toISOString().slice(0, 10)); });
    var minYear = Math.floor(Math.min.apply(null, starts));
    var maxYear = Math.ceil(Math.max(yearFrac(today.toISOString().slice(0, 10)), Math.max.apply(null, ends)));
    var span = Math.max(maxYear - minYear, 1);
    var VB_W = 720, PAD_L = 6, PAD_R = 6, ROW_H = 30, ROW_GAP = 14, AXIS_H = 22;
    var chartW = VB_W - PAD_L - PAD_R;
    function xFor(yf) { return PAD_L + ((yf - minYear) / span) * chartW; }
    function barsRow(terms, rowY, colorVarName) {
      return terms.map(function (t) {
        var x1 = xFor(yearFrac(t.term_start));
        var x2 = xFor(yearFrac(t.term_end || today.toISOString().slice(0, 10)));
        var w = Math.max(x2 - x1, 4);
        var endYear = t.term_end ? new Date(t.term_end + "T00:00:00").getFullYear() : "present";
        var titleText = esc(t.office_name) + (t.party ? " (" + esc(t.party) + ")" : "") + ", " +
          new Date(t.term_start + "T00:00:00").getFullYear() + "–" + endYear;
        return '<rect x="' + x1.toFixed(1) + '" y="' + rowY + '" width="' + w.toFixed(1) + '" height="16" rx="4" ' +
          'fill="var(' + colorVarName + ')"><title>' + titleText + "</title></rect>";
      }).join("");
    }
    var rowAY = AXIS_H + 6, rowBY = AXIS_H + 6 + ROW_H + ROW_GAP;
    var totalH = rowBY + ROW_H;
    var yearTicks = [];
    var tickCount = span > 18 ? 4 : span > 8 ? 3 : 2;
    for (var i = 0; i <= tickCount; i++) {
      var yr = Math.round(minYear + (span * i) / tickCount);
      // the two end labels would otherwise get clipped by the viewBox edge
      // under text-anchor:middle, since their tick sits right at the margin
      var anchor = i === 0 ? "start" : i === tickCount ? "end" : "middle";
      yearTicks.push('<text x="' + xFor(yr).toFixed(1) + '" y="' + (AXIS_H - 8) + '" text-anchor="' + anchor + '" class="compare-axis-label">' + yr + "</text>" +
        '<line x1="' + xFor(yr).toFixed(1) + '" x2="' + xFor(yr).toFixed(1) + '" y1="' + (AXIS_H - 4) + '" y2="' + totalH + '" class="compare-axis-tick" />');
    }
    return '<div class="compare-timeline-card">' +
      '<div class="compare-timeline-head">' +
        '<div class="section-title" style="margin-bottom:0;">Career timeline, side by side</div>' +
        '<div class="compare-legend">' +
          '<span class="compare-legend-item"><span class="compare-legend-swatch" style="background:var(--compare-a)"></span>' + esc(titleCase(oa.full_name)) + "</span>" +
          '<span class="compare-legend-item"><span class="compare-legend-swatch" style="background:var(--compare-b)"></span>' + esc(titleCase(ob.full_name)) + "</span>" +
        "</div>" +
      "</div>" +
      '<div class="compare-timeline-scroll">' +
        '<svg class="compare-timeline-svg" viewBox="0 0 ' + VB_W + " " + totalH + '" preserveAspectRatio="xMinYMin meet">' +
          yearTicks.join("") +
          barsRow(termsA, rowAY, "--compare-a") +
          barsRow(termsB, rowBY, "--compare-b") +
        "</svg>" +
      "</div>" +
      '<p class="compare-timeline-note">Each bar is one term on record, hover a bar for the office, party, and years. ' +
      "This is built from real term start and end dates, not vote counts, this data has no vote totals or " +
      "precinct-level results for any race.</p>" +
    "</div>";
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
