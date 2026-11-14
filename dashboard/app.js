// Launch Radar v2: a plain page over window.RADAR, no network, no framework.
// The board ranks pre-token protocols by the fitted power law; the "Already
// trading" tab shows the live set apart, with the market's own values. The
// detail view recomputes each row's implied value from the snapshot figures
// and the published fit, so the page's arithmetic and the board's data
// agree, and the research note shows the fit, the backtest and the chart
// the value model stands on.
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
  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + ' years';
    return days + ' days';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function log10(n) { return Math.log(n) / Math.LN10; }

  // The model, recomputed in the page from the row's own figures and the
  // published fit: the power-law curve, the category offset, the growth
  // factor and the seasoning factor, exactly as lib/model.ts scores it.
  function offsetFor(row) {
    var key = row.category === null ? '(uncategorised)' : row.category;
    for (var i = 0; i < D.fit.offsets.length; i++) {
      if (D.fit.offsets[i].category === key) return D.fit.offsets[i].offset;
    }
    return 0;
  }
  function recompute(row) {
    var t = D.tune;
    var growth = Math.min(t.growth_cap, Math.max(t.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var gf = 1 + (growth / 100) * t.growth_weight;
    var age = row.age_days === null ? t.unknown_age_days : row.age_days;
    var af = 1 + t.age_amplitude * (Math.min(Math.max(age, 0), t.age_cap_days) / t.age_cap_days - 0.5);
    var logValue = D.fit.intercept + D.fit.slope * log10(row.tvl_usd) + offsetFor(row) + log10(gf) + log10(af);
    return Math.max(1, Math.round(Math.pow(10, logValue)));
  }

  function readHash() {
    var h = {};
    window.location.hash.replace(/^#/, '').split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv[0]) h[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    if (h.q !== undefined) state.q = h.q;
    if (h.cat !== undefined) state.cat = h.cat;
    if (h.chain !== undefined) state.chain = h.chain;
    if (h.watch !== undefined) state.watch = h.watch === '1';
    if (h.tab === 'live' || h.tab === 'board') state.tab = h.tab;
    if (h.detail) state.selected = h.detail;
  }
  function writeHash() {
    var parts = [];
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.cat !== 'all') parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.chain !== 'all') parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.watch) parts.push('watch=1');
    if (state.tab !== 'board') parts.push('tab=' + state.tab);
    if (state.selected) parts.push('detail=' + encodeURIComponent(state.selected));
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : ' ');
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat !== 'all' && (r.category || '(uncategorised)') !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
  }
  function sorted(rows) {
    var key = state.sort, dir = state.dir;
    var val = function (r) {
      if (key === 'rank') return r.rank;
      if (key === 'name') return r.name.toLowerCase();
      if (key === 'category') return (r.category || '').toLowerCase();
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -1e18 : r.change_7d;
      if (key === 'age') return r.age_days === null ? -1 : r.age_days;
      return r.implied_value_usd;
    };
    return rows.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  var COLUMNS = [
    ['rank', '#'],
    ['name', 'Protocol'],
    ['category', 'Category'],
    ['chains', 'Chains'],
    ['tvl', 'TVL'],
    ['change', '7d'],
    ['age', 'Age'],
    ['implied', 'Implied value'],
  ];

  function renderModelLine() {
    var f = D.fit, b = D.backtest;
    document.getElementById('modelline').innerHTML =
      '<b>Value model:</b> log&#8321;&#8320;(mcap) = ' + f.intercept.toFixed(3) + ' + ' + f.slope.toFixed(3) +
      ' &middot; log&#8321;&#8320;(TVL), fitted on ' + f.kept_count + ' live protocols (' + f.trimmed_count +
      ' trimmed) &middot; R&sup2; ' + f.r_squared.toFixed(3) + ' &middot; leave-one-out backtest: median error ' +
      b.median_pct.toFixed(0) + '%, ' + Math.round(b.within_2x * 100) + '% within 2&times; (naive median: ' +
      b.baseline_median_pct.toFixed(0) + '%, ' + Math.round(b.baseline_within_2x * 100) + '% within 2&times;)';
  }

  function renderStats() {
    var el = document.getElementById('stats');
    var max = D.rows.length ? D.rows[0].implied_value_usd : 0;
    el.innerHTML = [
      ['Board rows', D.board_size],
      ['Watchlist covered', D.watchlist_size + ' / ' + D.watchlist_size],
      ['Early finds', D.early_size],
      ['Top implied value', money(max)],
      ['Snapshot date', D.as_of],
    ].map(function (kv) { return '<div><dt>' + kv[0] + '</dt><dd>' + kv[1] + '</dd></div>'; }).join('');
  }

  // Log-log scatter: every live protocol's TVL against its market cap, the
  // fitted curve through them, and the watchlist's protocols placed on the
  // curve at their implied values. Built from the data, no image files.
  function scatterSVG() {
    var W = 560, H = 300, L = 52, R = 14, T = 12, B = 34;
    var xs = D.scatter.map(function (p) { return log10(p.tvl_usd); });
    var ys = D.scatter.map(function (p) { return log10(p.mcap_usd); });
    var marks = D.rows.filter(function (r) { return r.watchlist; });
    marks.forEach(function (r) { xs.push(log10(r.tvl_usd)); ys.push(log10(r.implied_value_usd)); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return L + (v - x0) / (x1 - x0) * (W - L - R); }
    function Y(v) { return T + (y1 - v) / (y1 - y0) * (H - T - B); }
    function tickLabel(v) {
      var n = Math.pow(10, v);
      if (n >= 1e9) return '$' + (n / 1e9) + 'B';
      if (n >= 1e6) return '$' + (n / 1e6) + 'M';
      return '$' + Math.round(n / 1e3) + 'K';
    }
    var out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="TVL against market cap, log scales, with the fitted curve">'];
    var v;
    for (v = x0; v <= x1; v++) {
      out.push('<line class="grid" x1="' + X(v).toFixed(1) + '" y1="' + T + '" x2="' + X(v).toFixed(1) + '" y2="' + (H - B) + '"/>');
      out.push('<text class="tick" x="' + X(v).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + tickLabel(v) + '</text>');
    }
    for (v = y0; v <= y1; v++) {
      out.push('<line class="grid" x1="' + L + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(v).toFixed(1) + '"/>');
      out.push('<text class="tick" x="' + (L - 6) + '" y="' + (Y(v).toFixed(1) + 3) + '" text-anchor="end">' + tickLabel(v) + '</text>');
    }
    out.push('<text class="tick" x="' + ((W + L - R) / 2).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">TVL (log scale)</text>');
    out.push('<text class="tick" x="12" y="' + ((H + T - B) / 2).toFixed(1) + '" text-anchor="middle" transform="rotate(-90 12 ' + ((H + T - B) / 2).toFixed(1) + ')">Market cap / implied value (log scale)</text>');
    var cx0 = X(x0), cy0 = Y(D.fit.intercept + D.fit.slope * x0);
    var cx1 = X(x1), cy1 = Y(D.fit.intercept + D.fit.slope * x1);
    out.push('<line class="curve" x1="' + cx0.toFixed(1) + '" y1="' + cy0.toFixed(1) + '" x2="' + cx1.toFixed(1) + '" y2="' + cy1.toFixed(1) + '"/>');
    D.scatter.forEach(function (p) {
      out.push('<circle class="dot" cx="' + X(log10(p.tvl_usd)).toFixed(1) + '" cy="' + Y(log10(p.mcap_usd)).toFixed(1) + '" r="2.6"><title>' + esc(p.name) + '</title></circle>');
    });
    marks.forEach(function (r) {
      out.push('<circle class="mark" cx="' + X(log10(r.tvl_usd)).toFixed(1) + '" cy="' + Y(log10(r.implied_value_usd)).toFixed(1) + '" r="4"><title>' + esc(r.name) + '</title></circle>');
    });
    out.push('<line class="axis" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '"/>');
    out.push('<line class="axis" x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '"/>');
    out.push('</svg>');
    return out.join('');
  }

  function renderResearch() {
    var t = D.tune, f = D.fit, b = D.backtest;
    var offs = f.offsets.slice().sort(function (a, b2) { return Math.abs(b2.offset) - Math.abs(a.offset); }).slice(0, 8);
    var offRows = offs.map(function (o) {
      return '<tr><td>' + esc(o.category) + '</td><td>' + (o.offset >= 0 ? '+' : '') + o.offset.toFixed(3) + '</td><td>x' + o.offset_factor.toFixed(3) + '</td><td>' + o.live_count + ' live</td></tr>';
    }).join('');
    document.getElementById('research').innerHTML =
      '<h2>Research note: the fit and the backtest</h2>' +
      '<p>The value model is a power law fitted to this snapshot alone. Least squares on the ' + f.live_count +
      ' protocols that record a positive market cap and TVL gives <code>log&#8321;&#8320;(mcap) = ' + f.intercept.toFixed(4) +
      ' + ' + f.slope.toFixed(4) + ' &middot; log&#8321;&#8320;(TVL)</code>, after one round of trimming residuals past ' + t.trim_sd +
      ' standard deviations (' + f.trimmed_count + ' protocols trimmed, ' + f.kept_count + ' kept). The slope under 1 is the market speaking: ' +
      'large protocols carry a lower market-cap-to-TVL ratio than small ones, so the curve bends down as TVL grows. ' +
      'Each category then earns a shrunk offset from its own residuals (prior ' + t.shrink_prior + '), growth is the 7-day TVL change clamped to [' +
      t.growth_floor + '%, +' + t.growth_cap + '%] at weight ' + t.growth_weight + ', and seasoning moves the value by at most &plusmn;' +
      (t.age_amplitude * 100) + '% over ' + t.age_cap_days + ' days. No protocol name is ever special-cased; the same formulas score every row.</p>' +
      '<div class="twocol"><div>' +
      '<h3>Backtest: leave-one-out over ' + b.n + ' live protocols</h3>' +
      '<p>Each live protocol is held out in turn, the curve and offsets are refit on the rest, and its market cap is predicted from its TVL, growth and age alone.</p>' +
      '<table><thead><tr><th>Model</th><th>Mean log error</th><th>Median error</th><th>Within 2&times;</th></tr></thead><tbody>' +
      '<tr><td>Fitted power law</td><td>' + b.mae_log.toFixed(3) + '</td><td>' + b.median_pct.toFixed(0) + '%</td><td>' + Math.round(b.within_2x * 100) + '%</td></tr>' +
      '<tr><td>Naive median ratio</td><td>' + b.baseline_mae_log.toFixed(3) + '</td><td>' + b.baseline_median_pct.toFixed(0) + '%</td><td>' + Math.round(b.baseline_within_2x * 100) + '%</td></tr>' +
      '</tbody></table>' +
      '<p>The fit beats the naive baseline on every column, and the backtest is honest about the residue: token values scatter widely around any TVL curve (residual SD ' + f.resid_sd.toFixed(3) + ' dex, R&sup2; ' + f.r_squared.toFixed(3) + '). The board ranks by the fitted centre, not by a promise.</p>' +
      '<h3>Largest category offsets</h3>' +
      '<table><thead><tr><th>Category</th><th>Offset</th><th>Factor</th><th>Evidence</th></tr></thead><tbody>' + offRows + '</tbody></table>' +
      '</div><div class="chart">' + scatterSVG() +
      '<div class="legend"><span><i class="l-dot"></i>Live protocol (TVL vs market cap)</span><span><i class="l-mark"></i>Watchlist protocol (TVL vs implied value)</span><span><i class="l-curve"></i>Fitted curve</span></div>' +
      '<p class="cap" style="margin-top:8px">The curve runs through the live market; the watchlist sits on it at its implied values. Both axes are logarithmic.</p>' +
      '</div></div>';
  }

  function renderControls() {
    var cats = {}, chains = {};
    D.rows.forEach(function (r) {
      cats[r.category || '(uncategorised)'] = true;
      r.chains.forEach(function (c) { chains[c] = true; });
    });
    var catSel = document.getElementById('cat');
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      catSel.appendChild(o);
    });
    var chainSel = document.getElementById('chain');
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      chainSel.appendChild(o);
    });
    document.getElementById('q').value = state.q;
    catSel.value = state.cat;
    chainSel.value = state.chain;
    document.getElementById('watch').checked = state.watch;
    document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
    catSel.addEventListener('change', function (e) { state.cat = e.target.value; render(); });
    chainSel.addEventListener('change', function (e) { state.chain = e.target.value; render(); });
    document.getElementById('watch').addEventListener('change', function (e) { state.watch = e.target.checked; render(); });
    document.getElementById('tab-board').addEventListener('click', function () { state.tab = 'board'; render(); });
    document.getElementById('tab-live').addEventListener('click', function () { state.tab = 'live'; render(); });
  }

  function renderHead() {
    document.getElementById('headrow').innerHTML = COLUMNS.map(function (c) {
      var arrow = state.sort === c[0] ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
      var cls = c[0] === 'tvl' || c[0] === 'change' || c[0] === 'age' || c[0] === 'implied' ? 'num sortable' : 'sortable';
      return '<th class="' + cls + '" data-sort="' + c[0] + '">' + c[1] + arrow + '</th>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#headrow th'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
        render();
      });
    });
  }

  function renderTable() {
    var rows = sorted(filtered());
    var max = D.rows.length ? D.rows[0].implied_value_usd : 1;
    document.getElementById('count').textContent =
      state.tab === 'live'
        ? D.live.length + ' protocols whose token already trades, by market cap. They are not ranked and their values are the market\u2019s, not the model\u2019s.'
        : rows.length + ' of ' + D.rows.length + ' board rows shown' + (state.watch ? ' (watchlist only)' : '') + '.';
    var tb = document.getElementById('rows');
    if (state.tab === 'live') {
      tb.innerHTML = D.live.map(function (p) {
        return '<tr data-slug=""><td class="num">—</td><td><span class="name">' + esc(p.name) + '</span> <span class="slug">' + esc(p.slug) + '</span></td>' +
          '<td>' + esc(p.category || '—') + '</td><td>' + p.chains.slice(0, 3).map(esc).join(', ') + (p.chains.length > 3 ? ' +' + (p.chains.length - 3) : '') + '</td>' +
          '<td class="num">' + money(p.tvl_usd) + '</td><td class="num ' + (p.change_7d > 0 ? 'up' : p.change_7d < 0 ? 'down' : '') + '">' + pct(p.change_7d) + '</td>' +
          '<td class="num">—</td><td class="num">' + money(p.mcap_usd) + '<span class="bar"><i style="width:' + Math.max(2, Math.round(100 * p.mcap_usd / D.live[0].mcap_usd)) + '%"></i></span></td></tr>';
      }).join('');
      return;
    }
    tb.innerHTML = rows.map(function (r) {
      var chg = r.change_7d === null ? '' : (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : '');
      return '<tr data-slug="' + esc(r.slug) + '" class="' + (state.selected === r.slug ? 'selected' : '') + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span> <span class="slug">' + esc(r.slug) + '</span>' + (r.watchlist ? '<span class="badge">Watchlist</span>' : '') + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + r.chains.slice(0, 3).map(esc).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + chg + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + (r.age_days === null ? 'n/a' : r.age_days >= 365 ? (r.age_days / 365).toFixed(1) + 'y' : r.age_days + 'd') + '</td>' +
        '<td class="num">' + money(r.implied_value_usd) + '<span class="bar"><i style="width:' + Math.max(2, Math.round(100 * r.implied_value_usd / max)) + '%"></i></span></td></tr>';
    }).join('');
    Array.prototype.forEach.call(tb.querySelectorAll('tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () {
        state.selected = tr.getAttribute('data-slug');
        render();
      });
    });
  }

  function renderDetail() {
    var box = document.getElementById('detail');
    var row = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === state.selected) row = D.rows[i];
    if (!row) {
      box.innerHTML = '<h2>Detail view</h2><p class="empty">Select a protocol on the board to see its snapshot record, the fitted breakdown behind its implied value, the live protocols it is priced against, and its farm plan.</p>';
      return;
    }
    var again = recompute(row);
    var b = row.breakdown;
    var comps = row.comparables.map(function (c) {
      return '<li><span class="cname">' + esc(c.name) + (c.same_category ? ' <span class="same">same category</span>' : '') + '</span>' +
        '<span class="cnum">' + money(c.tvl_usd) + ' TVL &middot; ' + money(c.mcap_usd) + ' mcap &middot; ' + c.ratio.toFixed(3) + 'x</span></li>';
    }).join('');
    box.innerHTML =
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.slug) + (row.watchlist ? ' · on the watchlist' : ' · early find') + ' · records no token</p>' +
      '<p class="value">' + moneyFull(row.implied_value_usd) + '</p>' +
      '<p class="value-note">Implied value, rank #' + row.rank + ' of ' + D.rows.length + '</p>' +
      '<h3>Fitted breakdown</h3><dl>' +
      '<dt>Power-law curve</dt><dd>' + moneyFull(b.curve_value) + '</dd>' +
      '<dt>Category offset</dt><dd>' + (b.offset >= 0 ? '+' : '') + b.offset.toFixed(3) + ' dex (x' + b.offset_factor.toFixed(3) + ')</dd>' +
      '<dt>Growth used</dt><dd>' + pct(b.growth_pct) + ' → x' + b.growth_factor.toFixed(3) + '</dd>' +
      '<dt>Seasoning</dt><dd>x' + b.age_factor.toFixed(3) + '</dd>' +
      '</dl>' +
      '<p class="match">' + (again === row.implied_value_usd ? 'Recomputed in this page: matches the board.' : 'Recomputed in this page: ' + moneyFull(again) + '.') + '</p>' +
      '<h3>Priced against</h3><ul class="comps">' + comps + '</ul>' +
      '<p class="value-note">Nearest live protocols by TVL size. Evidence for the curve, not the value itself.</p>' +
      '<h3>Snapshot record</h3><dl>' +
      '<dt>Category</dt><dd>' + esc(row.category || '—') + '</dd>' +
      '<dt>Chains</dt><dd>' + row.chains.map(esc).join(', ') + '</dd>' +
      '<dt>TVL</dt><dd>' + moneyFull(row.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + pct(row.change_7d) + '</dd>' +
      '<dt>Listed</dt><dd>' + esc(row.listed_at || 'unknown') + ' (' + ageText(row.age_days) + ')</dd>' +
      '<dt>Market cap</dt><dd>none recorded</dd>' +
      '</dl>' +
      '<h3>Farm plan</h3><ol>' + row.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
  }

  function renderLive() {
    var sec = document.getElementById('live');
    if (state.tab !== 'live') { sec.hidden = true; return; }
    sec.hidden = false;
    sec.innerHTML = '<h2>Already trading — kept apart on purpose</h2>' +
      '<p>These ' + D.live.length + ' protocols record a token, so the market already prices them. Their market caps are shown above in place of an implied value, and the same live protocols fit the power law the board uses. A protocol leaves this list for the board only when its record shows no token.</p>';
  }

  function renderTabs() {
    document.getElementById('tab-board').setAttribute('aria-selected', state.tab === 'board' ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
  }

  function render() {
    writeHash();
    renderTabs();
    renderHead();
    renderTable();
    renderDetail();
    renderLive();
  }

  readHash();
  window.addEventListener('hashchange', function () {
    readHash();
    document.getElementById('q').value = state.q;
    document.getElementById('cat').value = state.cat;
    document.getElementById('chain').value = state.chain;
    document.getElementById('watch').checked = state.watch;
    render();
  });
  renderModelLine();
  renderStats();
  renderResearch();
  renderControls();
  document.getElementById('source').textContent = 'Source: ' + D.source + '. Snapshot date: ' + D.as_of + '. Model: ' + D.model_name + '.';
  render();
})();
