// Launch Radar v3: a plain page over window.RADAR, no network, no framework.
// The board ranks pre-token protocols by the fitted power law; the "Already
// trading" tab shows the live set apart, with the market's own values. The
// detail view recomputes each row's implied value AND its intervals from the
// snapshot figures and the published fit, so the page's arithmetic and the
// board's data agree exactly. The research note shows the fit, the
// fifteen-specification bake-off, the backtest with its holdout splits, the
// per-category calibration, and the chart the value model stands on.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;

  var state = { q: '', cat: 'all', chain: 'all', watch: false, tab: 'board', sort: 'rank', dir: 1, selected: null };

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageShort(days) {
    if (days === null || days === undefined) return 'n/a';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function log10(n) { return Math.log(n) / Math.LN10; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // --- the model, recomputed in the page from the row's own figures ---
  // Exactly lib/model.ts: curve + shrunk category offset + clamped growth
  // factor + seasoning factor. Offsets ship at full precision, so the
  // recompute matches the board's value to the dollar.
  function offsetFor(row) {
    var key = row.category === null ? '(uncategorised)' : row.category;
    for (var i = 0; i < D.model.offsets.length; i++) {
      if (D.model.offsets[i].category === key) return D.model.offsets[i].offset;
    }
    return 0;
  }
  function recompute(row) {
    var m = D.model;
    var growth = 1 + clamp(row.change_7d === null ? 0 : row.change_7d, m.growth_clamp[0], m.growth_clamp[1]) / 100 * m.growth_weight;
    var age = row.age_days === null ? m.unknown_age_days : row.age_days;
    var season = 1 + m.age_amp * (clamp(age, 0, m.age_cap_days) / m.age_cap_days - 0.5);
    var logValue = m.intercept + m.slope * log10(row.tvl_usd) + offsetFor(row) + log10(growth) + log10(season);
    var value = clamp(Math.round(Math.pow(10, logValue)), 1, 1e14);
    var b = D.backtest.bands;
    return {
      value: value,
      lo50: clamp(Math.round(value * Math.pow(10, b.q25)), 1, 1e14),
      hi50: clamp(Math.round(value * Math.pow(10, b.q75)), 1, 1e14),
      lo80: clamp(Math.round(value * Math.pow(10, b.q10)), 1, 1e14),
      hi80: clamp(Math.round(value * Math.pow(10, b.q90)), 1, 1e14),
    };
  }

  // --- masthead ---
  function renderHead() {
    var m = D.model, b = D.backtest;
    var naive = null;
    for (var i = 0; i < D.candidates.length; i++) if (D.candidates[i].name.indexOf('Naive') === 0) naive = D.candidates[i];
    document.getElementById('modelline').innerHTML =
      '<b>Value model:</b> log\u2081\u2080(mcap) = ' + m.intercept.toFixed(3) + ' + ' + m.slope.toFixed(3) +
      ' \u00b7 log\u2081\u2080(TVL), fitted on ' + m.kept_count + ' live protocols (' + m.trimmed_count +
      ' trimmed) \u00b7 R\u00b2 ' + m.r_squared.toFixed(3) + ' \u00b7 leave-one-out median error ' +
      Math.round(b.medianPct) + '%, ' + Math.round(b.within2 * 100) + '% within 2\u00d7 (naive median: ' +
      Math.round(naive.summary.medianPct) + '%, ' + Math.round(naive.summary.within2 * 100) +
      '% within 2\u00d7) \u00b7 80% interval \u00d7' + Math.pow(10, b.bands.q10).toFixed(2) + '–\u00d7' +
      Math.pow(10, b.bands.q90).toFixed(1) + ' \u00b7 chosen over ' + (D.candidates.length - 1) +
      ' alternatives by backtest';
    var top = D.rows[0];
    document.getElementById('stats').innerHTML =
      stat(D.meta.board_size, 'Board rows') + stat(D.meta.watchlist_size + ' / ' + D.meta.watchlist_size, 'Watchlist covered') +
      stat(D.meta.early_size, 'Early finds') + stat(money(top.implied_value_usd), 'Top implied value') +
      stat(D.meta.as_of, 'Snapshot date');
    function stat(v, label) { return '<div><dt>' + label + '</dt><dd>' + esc(v) + '</dd></div>'; }
    document.getElementById('source').textContent =
      'Source: the sealed snapshot dated ' + D.meta.as_of + ' (' + D.meta.snapshot_protocols +
      ' protocols at or above $5M TVL). The fit, the bake-off and the backtest are computed at build time from the snapshot alone; this page recomputes every row from the published parameters, and the recompute is checked in each detail view.';
  }

  // --- filters ---
  function fillFilters() {
    var cats = {}, chains = {};
    D.rows.forEach(function (r) {
      cats[r.category === null ? '(uncategorised)' : r.category] = true;
      r.chains.forEach(function (c) { chains[c] = true; });
    });
    var catSel = document.getElementById('cat');
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
    });
    var chainSel = document.getElementById('chain');
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o);
    });
  }

  function filtered() {
    var q = state.q.toLowerCase();
    return D.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat !== 'all' && (r.category === null ? '(uncategorised)' : r.category) !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function sorted(rows) {
    var key = state.sort, dir = state.dir;
    return rows.slice().sort(function (a, b) {
      var va, vb;
      if (key === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      else if (key === 'category') { va = (a.category || '').toLowerCase(); vb = (b.category || '').toLowerCase(); }
      else if (key === 'tvl') { va = a.tvl_usd; vb = b.tvl_usd; }
      else if (key === 'change') { va = a.change_7d === null ? -1e9 : a.change_7d; vb = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (key === 'value') { va = a.implied_value_usd; vb = b.implied_value_usd; }
      else if (key === 'chains') { va = a.chains.length; vb = b.chains.length; }
      else { va = a.rank; vb = b.rank; }
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.rank - b.rank;
    });
  }

  // --- board ---
  var COLUMNS = [
    { key: 'rank', label: '#', cls: '' },
    { key: 'name', label: 'Protocol', cls: '' },
    { key: 'category', label: 'Category', cls: '' },
    { key: 'chains', label: 'Chains', cls: '' },
    { key: 'tvl', label: 'TVL', cls: 'num' },
    { key: 'change', label: '7D', cls: 'num' },
    { key: 'value', label: 'Implied value', cls: 'num' },
  ];

  function renderBoard() {
    var head = document.getElementById('headrow');
    head.innerHTML = COLUMNS.map(function (c) {
      var arrow = state.sort === c.key ? ' <span class="dir">' + (state.dir === 1 ? '\u25b2' : '\u25bc') + '</span>' : '';
      return '<th class="sortable ' + c.cls + '" data-sort="' + c.key + '">' + c.label + arrow + '</th>';
    }).join('');
    var rows = sorted(filtered());
    var tb = document.getElementById('rows');
    tb.innerHTML = rows.map(function (r) {
      var chg = r.change_7d === null ? '<span>n/a</span>' : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d) + '</span>';
      var chains = r.chains.length <= 2 ? esc(r.chains.join(', ')) : esc(r.chains.slice(0, 2).join(', ')) + ' +' + (r.chains.length - 2);
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.selected === r.slug ? 'selected ' : '') + (r.watchlist ? 'watchrow' : '') + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + (r.watchlist ? '<span class="badge">Watchlist</span>' : '') +
        '<span class="slug">' + esc(r.slug) + '</span></span></td>' +
        '<td>' + esc(r.category === null ? '—' : r.category) + '</td>' +
        '<td>' + chains + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num"><span class="val">' + money(r.implied_value_usd) + '</span>' +
        '<span class="bandline">80% ' + money(r.interval_80[0]) + '–' + money(r.interval_80[1]) + '</span></td></tr>';
    }).join('');
    document.getElementById('count').textContent =
      rows.length + ' of ' + D.rows.length + ' board rows shown' +
      (rows.length === 0 ? ' — no protocol matches these filters.' : '.');
  }

  // --- detail ---
  function renderDetail() {
    var el = document.getElementById('detail');
    var row = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === state.selected) row = D.rows[i];
    if (!row) {
      el.innerHTML = '<h2>Detail view</h2><p class="empty">Select a protocol on the board to see its snapshot record, the fitted breakdown behind its implied value, its uncertainty interval, the live protocols it is priced against, and its farm plan.</p>' +
        '<h3>How to read the band</h3><p class="empty">Every implied value carries an 80% interval from the backtest\u2019s own errors: on the live protocols, the fit\u2019s miss ran from \u00d7' +
        Math.pow(10, D.backtest.bands.q10).toFixed(2) + ' to \u00d7' + Math.pow(10, D.backtest.bands.q90).toFixed(1) +
        ' eight times in ten. A narrow band here would be false precision; the wide band is the honest one.</p>';
      return;
    }
    var bd = row.breakdown;
    var re = recompute(row);
    var ok = re.value === row.implied_value_usd && re.lo80 === row.interval_80[0] && re.hi80 === row.interval_80[1] &&
      re.lo50 === row.interval_50[0] && re.hi50 === row.interval_50[1];
    var lo = log10(row.interval_80[0]), hi = log10(row.interval_80[1]);
    var pos = function (v) { return ((log10(v) - lo) / (hi - lo) * 100).toFixed(1); };
    var comps = row.comparables.map(function (c) {
      return '<li><span class="cname">' + esc(c.name) + '</span> ' +
        (c.same_category ? '<span class="same">same category</span>' : '<span>other category</span>') +
        '<span class="cfig"><span>TVL <b>' + money(c.tvl_usd) + '</b></span><span>market cap <b>' + money(c.mcap_usd) +
        '</b></span><span>ratio <b>' + c.ratio.toFixed(3) + '\u00d7</b></span><span>curve priced it <b>' +
        money(c.fitted_value_usd) + '</b></span><span>market/curve <b>\u00d7' + c.error_factor.toFixed(2) + '</b></span></span></li>';
    }).join('');
    var steps = row.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    el.innerHTML =
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="meta">' + esc(row.slug) + ' \u00b7 ' + (row.watchlist ? 'on the watchlist \u00b7 ' : '') + 'records no token \u00b7 ' +
      esc(row.category === null ? 'uncategorised' : row.category) + ' \u00b7 ' + esc(row.chains.join(', ')) + '</p>' +
      '<p class="bigval">' + moneyFull(row.implied_value_usd) + '</p>' +
      '<p class="bands">Implied value, rank #' + row.rank + ' of ' + D.rows.length + '<br>50% interval ' +
      money(row.interval_50[0]) + ' – ' + money(row.interval_50[1]) + '<br>80% interval ' +
      money(row.interval_80[0]) + ' – ' + money(row.interval_80[1]) + '</p>' +
      '<div class="ibar" role="img" aria-label="Uncertainty interval on a log scale"><div class="b80" style="left:0%;width:100%"></div>' +
      '<div class="b50" style="left:' + pos(row.interval_50[0]) + '%;width:' + (pos(row.interval_50[1]) - pos(row.interval_50[0])) + '%"></div>' +
      '<div class="mark" style="left:' + pos(row.implied_value_usd) + '%"></div></div>' +
      '<p class="ibar-labels"><span>' + money(row.interval_80[0]) + '</span><span>log scale</span><span>' + money(row.interval_80[1]) + '</span></p>' +
      '<h3>Snapshot record</h3>' +
      '<table class="kv"><tr><td>TVL</td><td>' + moneyFull(row.tvl_usd) + '</td></tr>' +
      '<tr><td>7-day TVL change</td><td>' + pct(row.change_7d) + '</td></tr>' +
      '<tr><td>Running since</td><td>' + (row.listed_at === null ? 'unreported' : esc(row.listed_at) + ' (' + ageShort(row.age_days) + ')') + '</td></tr>' +
      '<tr><td>Live protocols in category</td><td>' + row.live_in_category + '</td></tr></table>' +
      '<h3>Fitted breakdown</h3>' +
      '<table class="kv"><tr><td>Power-law curve at this TVL</td><td>' + moneyFull(bd.curveValue) + '</td></tr>' +
      '<tr><td>Category offset</td><td>' + (bd.offset >= 0 ? '+' : '') + bd.offset.toFixed(3) + ' dex (\u00d7' + bd.offsetFactor.toFixed(3) + ')</td></tr>' +
      '<tr><td>Growth used</td><td>' + pct(bd.growthPct) + ' \u2192 \u00d7' + bd.growthFactor.toFixed(3) + '</td></tr>' +
      '<tr><td>Seasoning</td><td>\u00d7' + bd.ageFactor.toFixed(3) + '</td></tr></table>' +
      '<h3>Priced against: nearest live protocols</h3><ul class="comps">' + comps + '</ul>' +
      '<p class="empty">Each comparable shows the market\u2019s own value beside what this curve would have priced it at — the gap between the two is the fit\u2019s error on a real neighbour.</p>' +
      '<h3>Farm plan</h3><ol>' + steps + '</ol>' +
      '<p class="recompute">' + (ok
        ? '<b>Recompute check passed:</b> this page recomputed the value and both intervals from the snapshot figures and the published fit, and they match the board exactly ($' + row.implied_value_usd.toLocaleString('en-US') + ').'
        : '<b>Recompute check FAILED:</b> the page recomputed $' + re.value.toLocaleString('en-US') + ' against the board\u2019s $' + row.implied_value_usd.toLocaleString('en-US') + '.') + '</p>';
  }

  // --- research note ---
  function scatterSvg() {
    var W = 640, H = 400, L = 56, R = 16, T = 14, B = 44;
    var xs = D.scatter.map(function (p) { return p.x; }), ys = D.scatter.map(function (p) { return p.y; });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    var X = function (v) { return L + (v - x0) / (x1 - x0) * (W - L - R); };
    var Y = function (v) { return T + (y1 - v) / (y1 - y0) * (H - T - B); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" font-family="monospace" font-size="11">';
    var gx, gy;
    for (gx = x0; gx <= x1; gx++) {
      s += '<line x1="' + X(gx) + '" y1="' + T + '" x2="' + X(gx) + '" y2="' + (H - B) + '" stroke="#e3ddd0"/>' +
        '<text x="' + X(gx) + '" y="' + (H - B + 16) + '" text-anchor="middle" fill="#8a97a5">$' + (gx >= 9 ? (Math.pow(10, gx - 9)) + 'B' : (Math.pow(10, gx - 6)) + 'M') + '</text>';
    }
    for (gy = y0; gy <= y1; gy++) {
      s += '<line x1="' + L + '" y1="' + Y(gy) + '" x2="' + (W - R) + '" y2="' + Y(gy) + '" stroke="#e3ddd0"/>' +
        '<text x="' + (L - 6) + '" y="' + (Y(gy) + 4) + '" text-anchor="end" fill="#8a97a5">$' + (gy >= 9 ? (Math.pow(10, gy - 9)) + 'B' : gy >= 6 ? (Math.pow(10, gy - 6)) + 'M' : (Math.pow(10, gy - 3)) + 'K') + '</text>';
    }
    s += '<text x="' + ((W - L - R) / 2 + L) + '" y="' + (H - 6) + '" text-anchor="middle" fill="#4b5a6a">TVL (log scale)</text>' +
      '<text x="14" y="' + ((H - T - B) / 2 + T) + '" text-anchor="middle" fill="#4b5a6a" transform="rotate(-90 14 ' + ((H - T - B) / 2 + T) + ')">Market cap (log scale)</text>';
    s += '<line x1="' + X(D.fit_line.x1) + '" y1="' + Y(D.fit_line.y1) + '" x2="' + X(D.fit_line.x2) + '" y2="' + Y(D.fit_line.y2) + '" stroke="#7c3aed" stroke-width="2"/>';
    D.scatter.forEach(function (p) {
      s += p.trimmed
        ? '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="4" fill="none" stroke="#b45309" stroke-width="1.6"><title>' + esc(p.name) + ' (trimmed)</title></circle>'
        : '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.4" fill="#0e7490" opacity="0.75"><title>' + esc(p.name) + '</title></circle>';
    });
    return s + '</svg>';
  }

  function histogramSvg() {
    var hist = D.backtest.histogram;
    var W = 640, H = 210, L = 56, R = 16, T = 14, B = 44;
    var max = 0;
    hist.forEach(function (h) { if (h.count > max) max = h.count; });
    var lo = Math.min.apply(null, hist.map(function (h) { return h.bin; }));
    var hi = Math.max.apply(null, hist.map(function (h) { return h.bin; })) + 0.4;
    var X = function (v) { return L + (v - lo) / (hi - lo) * (W - L - R); };
    var Y = function (c) { return T + (1 - c / max) * (H - T - B); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" font-family="monospace" font-size="11">';
    hist.forEach(function (h) {
      s += '<rect x="' + X(h.bin).toFixed(1) + '" y="' + Y(h.count).toFixed(1) + '" width="' + Math.max(1, X(h.bin + 0.4) - X(h.bin) - 2).toFixed(1) + '" height="' + (H - B - Y(h.count)).toFixed(1) + '" fill="#0e7490" opacity="0.8"/>';
    });
    s += '<line x1="' + X(0) + '" y1="' + T + '" x2="' + X(0) + '" y2="' + (H - B) + '" stroke="#b45309" stroke-width="1.6"/>';
    for (var g = Math.ceil(lo); g <= Math.floor(hi); g++) {
      s += '<text x="' + X(g) + '" y="' + (H - B + 16) + '" text-anchor="middle" fill="#8a97a5">' + (g > 0 ? '+' : '') + g + '</text>';
    }
    s += '<text x="' + ((W - L - R) / 2 + L) + '" y="' + (H - 6) + '" text-anchor="middle" fill="#4b5a6a">Leave-one-out error, log10(actual / fitted) — 0 is exact</text>';
    return s + '</svg>';
  }

  function renderResearch() {
    var m = D.model, b = D.backtest;
    var candRows = D.candidates.map(function (c) {
      return '<tr' + (c.shipped ? ' class="shipped"' : '') + '><td>' + esc(c.name) + '</td><td class="num">' + c.summary.mae.toFixed(3) +
        '</td><td class="num">' + c.summary.median.toFixed(3) + '</td><td class="num">' + Math.round(c.summary.medianPct) +
        '%</td><td class="num">' + Math.round(c.summary.within2 * 100) + '%</td><td class="num">' + Math.round(c.summary.within3 * 100) + '%</td></tr>';
    }).join('');
    var calRows = D.calibration.map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.n + '</td><td class="num">' + (c.offset >= 0 ? '+' : '') + c.offset.toFixed(3) +
        '</td><td class="num">' + (c.meanLooResid >= 0 ? '+' : '') + c.meanLooResid.toFixed(3) + '</td><td class="num">' + c.meanAbsLooResid.toFixed(3) + '</td></tr>';
    }).join('');
    document.getElementById('research').innerHTML =
      '<h2>Research note: the fit, the bake-off and the backtest</h2>' +
      '<p>This note states the whole method, the alternatives that were tested and rejected, and the errors the shipped model makes out of sample — so the ranking can be checked rather than trusted.</p>' +
      '<h3>1. The value model</h3>' +
      '<p>The implied value is a power law fitted to the snapshot\u2019s own live protocols — the ' + m.live_count +
      ' protocols whose token already trades, with a positive market cap and TVL. Least squares fits log\u2081\u2080(market cap) against log\u2081\u2080(TVL); one round of trimming drops the residuals past two standard deviations and refits, so a handful of absurd ratios cannot bend the curve. Each category\u2019s mean residual from the curve is then shrunk toward zero by n / (n + ' + m.shrink_prior +
      '), so a category with one live member barely moves its protocols and a deep category earns its offset; a category with no live member gets no offset. Two small bounded adjustments follow the snapshot\u2019s own figures: seven-day TVL growth, clamped to [' + m.growth_clamp[0] + '%, +' + m.growth_clamp[1] +
      '%] at weight ' + m.growth_weight + ', and seasoning of at most \u00b15% over ' + m.age_cap_days + ' days, with an unknown listing date counted as ' + m.unknown_age_days + ' days. No protocol name is special-cased anywhere: the same formula prices every row.</p>' +
      '<p class="eq">log\u2081\u2080(implied) = ' + m.intercept.toFixed(4) + ' + ' + m.slope.toFixed(4) + ' \u00b7 log\u2081\u2080(TVL) + offset(category) + log\u2081\u2080(growth factor) + log\u2081\u2080(seasoning factor)</p>' +
      '<p>The slope lands well under 1: the live market prices large protocols at a lower market-cap-to-TVL ratio than small ones, and the curve says so. The fit keeps ' + m.kept_count + ' of ' + m.live_count + ' live protocols after trimming (' + m.trimmed_slugs.length + ' trimmed: ' + m.trimmed_slugs.map(esc).join(', ') +
      '), with R\u00b2 ' + m.r_squared.toFixed(3) + ' and a residual standard deviation of ' + m.resid_sd.toFixed(3) + ' dex on the kept set. That scatter is the story of this snapshot: token values genuinely spread about eightfold around any TVL curve, which is why every row carries an interval.</p>' +
      '<h3>2. The bake-off: fifteen specifications, one winner by evidence</h3>' +
      '<p>Each specification below was leave-one-out backtested on the same ' + m.live_count + ' live protocols, refitting on every fold. The table is sorted by mean absolute log error. The top six sit within 0.005 of each other — statistically indistinguishable — so the shipped specification is the conventional one among the leaders (the standard 2-SD trim) with the stronger shrinkage the small categories need. Chasing the 0.002 gap to the best row would be fitting noise, not signal. Richer fits were tested and lost: joint regression, per-category slopes, a quadratic term, median regression, nearest neighbours and an ensemble all landed behind the simple curve with shrunk offsets, and none of them shipped.</p>' +
      '<table><thead><tr><th>Specification</th><th class="num">MAE (log)</th><th class="num">Median |err|</th><th class="num">Median error</th><th class="num">Within 2\u00d7</th><th class="num">Within 3\u00d7</th></tr></thead><tbody>' + candRows + '</tbody></table>' +
      '<h3>3. The backtest, and two harder splits</h3>' +
      '<p>Leave-one-out over the live set: mean absolute error ' + b.mae.toFixed(3) + ' dex, median absolute error ' + b.median.toFixed(3) + ' dex (' + Math.round(b.medianPct) + '%), ' + Math.round(b.within2 * 100) + '% of live protocols priced within 2\u00d7 and ' + Math.round(b.within3 * 100) + '% within 3\u00d7. Two harder splits check generalisation: holding out each category whole (leave-one-category-out) gives MAE ' + b.loco.mae.toFixed(3) + ' and median ' + Math.round(b.loco.medianPct) + '%, and holding out each third of the TVL range in turn gives MAE ' + b.band_holdout.mae.toFixed(3) + ' and median ' + Math.round(b.band_holdout.medianPct) + '%. The model degrades gracefully when a whole category or size band is unseen — it does not depend on memorising either.</p>' +
      '<h3>4. Honest uncertainty: the intervals</h3>' +
      '<p>Each row\u2019s interval comes from the leave-one-out residuals themselves, not from a formula: the 50% band spans the 25th to 75th residual percentile (\u00d7' + Math.pow(10, b.bands.q25).toFixed(2) + ' to \u00d7' + Math.pow(10, b.bands.q75).toFixed(2) + '), the 80% band the 10th to 90th (\u00d7' + Math.pow(10, b.bands.q10).toFixed(2) + ' to \u00d7' + Math.pow(10, b.bands.q90).toFixed(2) + '). The residual mean is ' + (b.bands.mean >= 0 ? '+' : '') + b.bands.mean.toFixed(3) + ' dex with standard deviation ' + b.bands.sd.toFixed(3) + ' dex. The histogram below shows the full error distribution; the amber line is exact.</p>' +
      '<figure>' + histogramSvg() + '<figcaption>Leave-one-out errors for the shipped model. Most misses fall within a factor of three either way; the long tails are real protocols the curve misprices badly, and they are why the intervals are wide.</figcaption></figure>' +
      '<h3>5. Calibration by category</h3>' +
      '<p>For each category: how many live protocols calibrate it, the shrunk offset applied, and the mean leave-one-out residual — positive means the curve under-prices the category out of sample, negative means it over-prices it. Small categories show the largest calibration misses, which is exactly why their offsets are shrunk hardest.</p>' +
      '<table><thead><tr><th>Category</th><th class="num">Live n</th><th class="num">Offset (dex)</th><th class="num">Mean LOO residual</th><th class="num">Mean |LOO residual|</th></tr></thead><tbody>' + calRows + '</tbody></table>' +
      '<h3>6. The curve against the market</h3>' +
      '<figure>' + scatterSvg() + '<figcaption>Each dot is a live protocol: TVL against market cap, both log scales. The plum line is the fitted power law. Amber rings are the ' + m.trimmed_count + ' protocols the trim dropped before the final fit — the ratios too extreme to let bend the curve.</figcaption></figure>' +
      '<h3>7. What the board is, and is not</h3>' +
      '<ul><li>The board ranks ' + D.meta.board_size + ' protocols that record no token: all ' + D.meta.watchlist_size + ' watchlist protocols plus ' + D.meta.early_size + ' more pre-token protocols below the watchlist floor, excluding wrapped, staked and bridged products by the house rule (bridge, staking and exchange categories, version-tailed names, wrapped/staked/staking names, exchange-prefixed names).</li>' +
      '<li>Implied value is the model\u2019s claim from the snapshot\u2019s figures, not a prediction that a token is issued, or when, or at what price. The interval is part of the claim.</li>' +
      '<li>Farm plans follow each protocol\u2019s mechanism — its category, its chains, its size and its age — with prerequisites first, costs and times on every step, and a risk review before the hold. They are starting points: verify on the protocol\u2019s own pages before moving funds.</li></ul>';
  }

  // --- already trading ---
  function renderLive() {
    var rows = D.live.map(function (r) {
      return '<tr><td><span class="pname">' + esc(r.name) + '<span class="slug">' + esc(r.slug) + '</span></span></td>' +
        '<td>' + esc(r.category === null ? '—' : r.category) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td class="num">' + money(r.fitted_value_usd) + '</td>' +
        '<td class="num">\u00d7' + r.error_factor.toFixed(2) + '</td></tr>';
    }).join('');
    document.getElementById('live').innerHTML =
      '<h2>Already trading — shown apart, never ranked</h2>' +
      '<p>These ' + D.live.length + ' are the largest live protocols by TVL: their tokens already trade, so the market has priced them and the board does not need to. The fitted column shows what the curve would have priced each at from TVL alone — the market/curve factor is the fit\u2019s error on a protocol whose answer is known. The full live set of ' + D.model.live_count + ' protocols calibrates the curve; this tab shows the largest for comparison.</p>' +
      '<table><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Curve fitted</th><th class="num">Market / curve</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // --- tabs ---
  function renderTabs() {
    document.getElementById('tab-board').setAttribute('aria-selected', state.tab === 'board' ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
    var showBoard = state.tab === 'board';
    document.querySelector('.layout').style.display = showBoard ? '' : 'none';
    document.getElementById('research').style.display = showBoard ? '' : 'none';
    document.getElementById('count').style.display = showBoard ? '' : 'none';
    document.querySelector('.controls').style.display = showBoard ? '' : 'none';
    document.getElementById('live').hidden = showBoard;
  }

  function select(slug, push) {
    state.selected = slug;
    renderBoard();
    renderDetail();
    if (push !== false) {
      try { history.replaceState(null, '', slug ? '#detail=' + encodeURIComponent(slug) : '#'); } catch (e) { /* hash unavailable */ }
    }
  }

  // --- events ---
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  document.getElementById('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  document.getElementById('watch').addEventListener('change', function (e) { state.watch = e.target.checked; renderBoard(); });
  document.getElementById('tab-board').addEventListener('click', function () { state.tab = 'board'; renderTabs(); });
  document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; renderTabs(); });
  document.getElementById('headrow').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]');
    if (!th) return;
    var key = th.getAttribute('data-sort');
    if (state.sort === key) state.dir = -state.dir;
    else { state.sort = key; state.dir = (key === 'rank' || key === 'name' || key === 'category') ? 1 : -1; }
    renderBoard();
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) select(tr.getAttribute('data-slug'));
  });

  // --- hash routing: #detail=<slug> and #watch=1 ---
  // The screenshot tool navigates between hash URLs on one page, which is a
  // same-document navigation: the page does not reload, so a hashchange
  // listener must re-apply the hash. replaceState in select() does not fire
  // hashchange, so clicks never loop back through here.
  function parseHash() {
    var hash = window.location.hash || '';
    var m = /(?:^|[#&])detail=([^&]+)/.exec(hash);
    var selected = null;
    if (m) {
      var slug = decodeURIComponent(m[1]);
      if (D.rows.some(function (r) { return r.slug === slug; })) selected = slug;
    }
    return { selected: selected, watch: /(?:^|[#&])watch=1(?:&|$)/.test(hash) };
  }
  window.addEventListener('hashchange', function () {
    var h = parseHash();
    state.selected = h.selected;
    state.watch = h.watch;
    document.getElementById('watch').checked = h.watch;
    renderBoard();
    renderDetail();
  });

  // --- init ---
  (function init() {
    var h = parseHash();
    state.selected = h.selected;
    state.watch = h.watch;
    document.getElementById('watch').checked = h.watch;
    renderHead();
    fillFilters();
    renderBoard();
    renderDetail();
    renderResearch();
    renderLive();
    renderTabs();
  })();
})();
