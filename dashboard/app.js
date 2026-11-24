/* Token Radar dashboard.
 *
 * Value model (radar-2), same constants as the generator that built the data:
 *   implied = TVL x peer ratio x growth x maturity
 *   peer ratio = median market cap / TVL of the live-token protocols in the
 *     same category, shrunk toward the market-wide median (weight 4) and
 *     capped at 3x TVL; global fallback 0.2138 when a category has no live
 *     peers. The shrinkage and cap keep one thin peer from setting the price
 *     for a whole category.
 *   growth = 1 + clamp(change_7d, -50, +150) / 100 x 0.6
 *   maturity = 0.7 + min(age_days, 1460) / 1460 x 0.5; unknown age = 365 days.
 * Board: every rankable pre-token protocol in the snapshot (289 rows), all 40
 * watchlist entries included, ranked by implied value. Live-token protocols
 * (128) are listed separately, priced by the market itself.
 * "Records no token" means the snapshot lists no market cap, no CoinGecko id
 * and no symbol for the protocol. It is a fact about the snapshot, not a
 * claim that the protocol will never issue one.
 */
(function () {
  "use strict";
  var R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) {
    document.body.innerHTML = "<p style='padding:40px'>Radar data failed to load.</p>";
    return;
  }
  var PAGE = 50;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function money(v) {
    if (v == null) return "—";
    var a = Math.abs(v);
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + Math.round(v);
  }
  function pct(v) {
    if (v == null) return "—";
    var s = (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
    return '<span class="' + (v >= 0 ? "up" : "down") + '">' + s + "</span>";
  }
  function age(v) { return v == null ? "—" : v + " d"; }

  function $(id) { return document.getElementById(id); }
  var state = { view: "board", scope: "all", q: "", cat: "", chain: "", sort: "value", detail: "", shown: PAGE };

  function readHash() {
    // A hash link is a complete state: reset to defaults first, then apply
    // the parameters it carries, so a link never inherits the previous view.
    state.view = "board"; state.scope = "all"; state.q = "";
    state.cat = ""; state.chain = ""; state.sort = "value"; state.detail = "";
    var h = location.hash.replace(/^#/, "");
    h.split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p.length !== 2) return;
      var k = decodeURIComponent(p[0]), v = decodeURIComponent(p[1]);
      if (k === "view" && (v === "board" || v === "live")) state.view = v;
      else if (k === "scope" && (v === "all" || v === "watchlist" || v === "early")) state.scope = v;
      else if (k === "q") state.q = v;
      else if (k === "cat") state.cat = v;
      else if (k === "chain") state.chain = v;
      else if (k === "sort") state.sort = v;
      else if (k === "detail") state.detail = v;
    });
  }
  function writeHash() {
    var parts = [];
    if (state.view !== "board") parts.push("view=" + state.view);
    if (state.scope !== "all") parts.push("scope=" + state.scope);
    if (state.q) parts.push("q=" + encodeURIComponent(state.q));
    if (state.cat) parts.push("cat=" + encodeURIComponent(state.cat));
    if (state.chain) parts.push("chain=" + encodeURIComponent(state.chain));
    if (state.sort !== "value") parts.push("sort=" + state.sort);
    if (state.detail) parts.push("detail=" + encodeURIComponent(state.detail));
    var h = parts.length ? "#" + parts.join("&") : "";
    if (location.hash !== h) history.replaceState(null, "", h || location.pathname);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var rows = R.rows.filter(function (r) {
      if (state.scope === "watchlist" && !r.watchlist) return false;
      if (state.scope === "early" && r.tvl_usd >= R.floor_usd) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var by = {
      value: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      change: function (a, b) { return (b.change_7d == null ? -1e18 : b.change_7d) - (a.change_7d == null ? -1e18 : a.change_7d); },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
      name: function (a, b) { return a.name.localeCompare(b.name); }
    };
    return rows.sort(by[state.sort] || by.value);
  }

  function renderMeta() {
    $("meta").textContent = "Snapshot: DefiLlama, " + R.as_of + " · " +
      R.rows.length + " ranked · " + R.watchlist_size + " on the watchlist · " +
      "floor " + money(R.floor_usd) + " · " + R.live_size + " live-token protocols listed separately.";
    $("formula").innerHTML = "<b>Implied value = TVL &times; peer ratio &times; growth &times; maturity.</b> " +
      "Peer ratio = median market cap / TVL of the live-token protocols in the same category, " +
      "shrunk toward the market median and capped at 3&times;. " +
      "Growth = 7-day TVL change, clamped to &minus;50&hellip;+150%. " +
      "Maturity = how long the protocol has run without a token.";
    var med = [];
    R.rows.forEach(function (r) { med.push(r.implied_value_usd); });
    med.sort(function (a, b) { return a - b; });
    var stats = [
      [String(R.rows.length), "pre-token protocols ranked"],
      [R.watchlist_size + " / " + R.watchlist_size, "watchlist entries covered"],
      [String(R.live_size), "live-token protocols listed"],
      [money(med[Math.floor(med.length / 2)]), "median implied value"]
    ];
    $("stats").innerHTML = stats.map(function (s) {
      return '<div class="stat"><div class="v">' + esc(s[0]) + '</div><div class="k">' + esc(s[1]) + "</div></div>";
    }).join("");
  }

  function renderSelects() {
    var cats = {}, chains = {};
    R.rows.forEach(function (r) {
      cats[r.category] = (cats[r.category] || 0) + 1;
      r.chains.forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
    });
    var catOpts = '<option value="">All categories</option>' + Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })
      .map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + " (" + cats[c] + ")</option>"; }).join("");
    var chainOpts = '<option value="">All chains</option>' + Object.keys(chains).sort(function (a, b) { return chains[b] - chains[a]; })
      .map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + " (" + chains[c] + ")</option>"; }).join("");
    $("cat").innerHTML = catOpts;
    $("chain").innerHTML = chainOpts;
    $("cat").value = state.cat;
    $("chain").value = state.chain;
  }

  function renderBoard() {
    var rows = filteredRows();
    var shown = rows.slice(0, state.shown);
    $("count").textContent = "Showing " + shown.length + " of " + rows.length + " ranked protocols" +
      (state.scope === "watchlist" ? " on the watchlist" : state.scope === "early" ? " below the " + money(R.floor_usd) + " floor" : "") + ".";
    $("rows").innerHTML = shown.map(function (r) {
      return "<tr data-slug=\"" + esc(r.slug) + "\"" + (state.detail === r.slug ? ' class="sel"' : "") + ">" +
        '<td class="num">' + r.rank + "</td>" +
        '<td><span class="name">' + esc(r.name) + "</span>" +
        (r.watchlist ? '<span class="tag">WATCHLIST</span>' : "") +
        '<br><span class="slug">' + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category) + "</td>" +
        "<td>" + esc(r.chains.slice(0, 3).join(", ")) + (r.chains.length > 3 ? " +" + (r.chains.length - 3) : "") + "</td>" +
        '<td class="num">' + money(r.tvl_usd) + "</td>" +
        '<td class="num">' + pct(r.change_7d) + "</td>" +
        '<td class="num">' + age(r.age_days) + "</td>" +
        '<td class="num implied">' + money(r.implied_value_usd) + "</td></tr>";
    }).join("");
    $("more").style.display = rows.length > state.shown ? "" : "none";
    Array.prototype.forEach.call(document.querySelectorAll("#rows tr"), function (tr) {
      tr.addEventListener("click", function () { selectDetail(tr.getAttribute("data-slug")); });
    });
  }

  function renderLive() {
    var rows = R.live.slice(0, state.shown);
    $("livecount").textContent = "Showing " + rows.length + " of " + R.live.length +
      " live-token protocols, priced by the market itself. Their market caps are the comparables behind the peer ratios.";
    $("liverows").innerHTML = rows.map(function (r, i) {
      return "<tr>" +
        '<td class="num">' + (i + 1) + "</td>" +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + "</span></td>" +
        "<td>" + esc(r.category) + "</td>" +
        "<td>" + esc(r.chains.slice(0, 3).join(", ")) + "</td>" +
        '<td class="num">' + money(r.tvl_usd) + "</td>" +
        '<td class="num implied">' + money(r.mcap_usd) + "</td>" +
        '<td class="num">' + pct(r.change_7d) + "</td></tr>";
    }).join("");
    $("more").style.display = R.live.length > state.shown ? "" : "none";
  }

  function selectDetail(slug) {
    state.detail = slug || "";
    writeHash();
    renderDetail();
    renderBoard();
    if (slug) {
      var el = $("detail");
      if (el && !el.hidden) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderDetail() {
    var el = $("detail");
    if (!state.detail) { el.hidden = true; el.innerHTML = ""; return; }
    var r = null;
    R.rows.forEach(function (x) { if (x.slug === state.detail) r = x; });
    if (!r) { el.hidden = true; el.innerHTML = ""; return; }
    var base = r.tvl_usd * r.peer_ratio;
    var peerNote = r.peer_category === "__global__"
      ? "global median (no live-token peer in " + r.category + ")"
      : "median of live-token " + r.category + " protocols, shrunk toward the market median, capped at 3x";
    var steps = r.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");
    el.innerHTML =
      "<h2>" + esc(r.name) + (r.watchlist ? ' <span class="tag">WATCHLIST</span>' : "") + "</h2>" +
      '<p class="note">Rank ' + r.rank + " of " + R.rows.length + " &middot; " + esc(r.slug) + " &middot; " + esc(r.category) + " &middot; " + esc(r.chains.join(", ")) + "</p>" +
      '<div class="facts">' +
      '<div class="fact"><div class="v">' + money(r.tvl_usd) + '</div><div class="k">TVL</div></div>' +
      '<div class="fact"><div class="v">' + (r.change_7d == null ? "—" : (r.change_7d >= 0 ? "+" : "") + r.change_7d.toFixed(1) + "%") + '</div><div class="k">7-day TVL change</div></div>' +
      '<div class="fact"><div class="v">' + age(r.age_days) + '</div><div class="k">Age without a token</div></div>' +
      '<div class="fact"><div class="v">' + money(r.implied_value_usd) + '</div><div class="k">Implied value</div></div>' +
      "</div>" +
      "<h3>How the value is built</h3>" +
      '<table class="breakdown"><tbody>' +
      "<tr><td>TVL &times; peer ratio (" + r.peer_ratio.toFixed(4) + ", " + esc(peerNote) + ")</td>" +
      '<td class="num">' + money(base) + "</td></tr>" +
      "<tr><td>&times; growth " + r.growth_mult.toFixed(4) + " (7-day change " +
      (r.change_7d == null ? "not reported" : r.change_7d.toFixed(1) + "%") + ", clamped)</td>" +
      '<td class="num">' + money(base * r.growth_mult) + "</td></tr>" +
      "<tr><td>&times; maturity " + r.maturity_mult.toFixed(4) + " (" +
      (r.age_days == null ? "listed date unknown, 365 days assumed" : r.age_days + " days") + ")</td>" +
      '<td class="num">' + money(base * r.growth_mult * r.maturity_mult) + "</td></tr>" +
      "<tr><td>Implied value</td>" + '<td class="num">' + money(r.implied_value_usd) + "</td></tr>" +
      "</tbody></table>" +
      "<h3>Farm plan</h3>" +
      '<ol class="steps">' + steps + "</ol>" +
      '<p class="note">This protocol records no token in the snapshot (no market cap, no CoinGecko id, no symbol). ' +
      "That is a fact about the snapshot, not a promise that a token will be issued. " +
      "Do the steps with money you can afford to lose, and never pay anyone to claim a reward.</p>";
    el.hidden = false;
  }

  function renderMethod() {
    var peers = Object.keys(R.peers).map(function (c) { return [c, R.peers[c]]; });
    peers.sort(function (a, b) { return b[1] - a[1]; });
    var top = peers.slice(0, 15).map(function (p) {
      return "<div><b>" + esc(p[0]) + "</b> &middot; " + p[1].toFixed(4) + "</div>";
    }).join("");
    $("method").innerHTML =
      "<h2>How the value is built</h2>" +
      "<p><b>Implied value = TVL &times; peer ratio &times; growth &times; maturity.</b> " +
      "Every input comes from the snapshot. TVL is the protocol&rsquo;s locked value. " +
      "The peer ratio is the median market-cap / TVL of the live-token protocols in the same category " +
      "&mdash; the market&rsquo;s own price for that kind of protocol &mdash; shrunk toward the market-wide median " +
      "(weight " + R.model.peer_shrinkage + ") and capped at " + R.model.peer_cap + "&times; TVL, so a single thin peer " +
      "cannot set the price for a whole category. When a category has no live-token peer, " +
      "the global median (" + R.model.peer_fallback.toFixed(4) + ") is used instead. " +
      "Growth is the protocol&rsquo;s seven-day TVL change, clamped to &minus;50&hellip;+150% and weighted 0.6, " +
      "so one spike cannot dominate the ranking. Maturity is 0.7 + min(age, 1460 days) / 1460 &times; 0.5: " +
      "a protocol that has run a long time without a token scores higher than a week-old one of the same size. " +
      "An unknown listing date is treated as 365 days.</p>" +
      "<h3>Peer ratios by category (median market cap / TVL)</h3>" +
      '<div class="peergrid">' + top + "</div>" +
      "<h3>What the board covers</h3>" +
      "<p>All " + R.rows.length + " rankable pre-token protocols in the snapshot: the 40 watchlist entries plus " +
      (R.rows.length - R.watchlist_size) + " more that meet the same bar &mdash; no token recorded, not a centralised " +
      "exchange, not a versioned name. " + R.live_size + " live-token protocols are listed separately, priced by the " +
      "market itself; their market caps are the comparables behind the peer ratios. " +
      R.token_no_mcap + " further protocols record a token but no market cap in the snapshot, so they are priced by neither list.</p>" +
      "<h3>Limits</h3>" +
      "<p>The snapshot is frozen at " + R.as_of + "; nothing here updates live. " +
      "Implied value is this entry&rsquo;s claim about what a token could be worth, not a prediction that one will " +
      "be issued or what it would trade at. Farm steps assume a small position (about $50&ndash;$250 of capital, " +
      "sized by TVL) and the gas prices of an ordinary week; they are generic guidance, not financial advice.</p>";
  }

  function renderAll() {
    $("boardwrap").hidden = state.view !== "board";
    $("livewrap").hidden = state.view !== "live";
    $("detail").hidden = state.view !== "board" || !state.detail;
    Array.prototype.forEach.call(document.querySelectorAll("#scope button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-scope") === state.scope);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#view button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-view") === state.view);
    });
    if (state.view === "board") { renderBoard(); renderDetail(); }
    else renderLive();
    writeHash();
  }

  function syncControls() {
    $("q").value = state.q;
    $("sort").value = state.sort;
    $("cat").value = state.cat;
    $("chain").value = state.chain;
  }

  function bind() {
    $("q").value = state.q;
    $("sort").value = state.sort;
    $("q").addEventListener("input", function () { state.q = $("q").value; state.shown = PAGE; renderAll(); });
    $("cat").addEventListener("change", function () { state.cat = $("cat").value; state.shown = PAGE; renderAll(); });
    $("chain").addEventListener("change", function () { state.chain = $("chain").value; state.shown = PAGE; renderAll(); });
    $("sort").addEventListener("change", function () { state.sort = $("sort").value; state.shown = PAGE; renderAll(); });
    $("more").addEventListener("click", function () { state.shown += PAGE; renderAll(); });
    Array.prototype.forEach.call(document.querySelectorAll("#scope button"), function (b) {
      b.addEventListener("click", function () { state.scope = b.getAttribute("data-scope"); state.shown = PAGE; renderAll(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("#view button"), function (b) {
      b.addEventListener("click", function () { state.view = b.getAttribute("data-view"); state.shown = PAGE; renderAll(); });
    });
    window.addEventListener("hashchange", function () { readHash(); syncControls(); state.shown = PAGE; renderAll(); });
  }

  readHash();
  renderMeta();
  renderSelects();
  renderMethod();
  bind();
  renderAll();
})();
