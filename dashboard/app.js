// Launch Radar: a plain page over window.RADAR, no network, no framework.
// The board ranks pre-token protocols by implied value; the "Already trading"
// tab shows the live set apart, with the market's own values. The detail view
// recomputes each row's implied value from the snapshot figures and the
// published calibration, so the page's arithmetic and the board's data agree.
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

  // The model, recomputed in the page from the row's own figures and the
  // calibration table: multiple x growth x seasoning x reach, exactly as
  // lib/model.ts scores it.
  function multipleFor(row) {
    var key = row.category === null ? '(uncategorised)' : row.category;
    for (var i = 0; i < D.calibration.rows.length; i++) {
      if (D.calibration.rows[i].category === key) return D.calibration.rows[i].multiple;
    }
    return D.calibration.global_median;
  }
  function recompute(row) {
    var t = D.tune;
    var growth = Math.min(t.growth_cap, Math.max(t.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var gf = 1 + (growth / 100) * t.growth_weight;
    var age = row.age_days === null ? t.unknown_age_days : row.age_days;
    var af = t.age_floor + (Math.min(Math.max(age, 0), t.age_cap_days) / t.age_cap_days) * t.age_span;
    var cf = 1 + t.chain_step * Math.min(Math.max(row.chains.length - 1, 0), t.chain_cap);
    return Math.max(1, Math.round(row.tvl_usd * multipleFor(row) * gf * af * cf));
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

  function renderMethod() {
    var t = D.tune;
    var top = D.calibration.rows.filter(function (r) { return r.live_count > 0; })
      .sort(function (a, b) { return b.live_count - a.live_count; }).slice(0, 8);
    var rows = top.map(function (r) {
      return '<tr><td>' + esc(r.category) + '</td><td>' + r.multiple.toFixed(3) + 'x</td><td>' + r.live_count + ' live</td><td>' + (r.median_ratio === null ? 'n/a' : r.median_ratio.toFixed(3) + 'x') + '</td></tr>';
    }).join('');
    document.getElementById('method').innerHTML =
      '<h2>How the value is built</h2>' +
      '<p><code>implied = TVL x category multiple x growth x seasoning x reach</code>. The multiple is calibrated from this snapshot alone: the median market-cap-to-TVL ratio of the protocols in each category whose token already trades — each live ratio capped at 2x first, so one tiny protocol cannot set a whole category — shrunk toward the snapshot-wide median (' + D.calibration.global_median.toFixed(3) + 'x, from ' + D.calibration.live_protocols + ' live protocols) and clamped to [' + t.multiple_floor + ', ' + t.multiple_cap + ']. Growth is the 7-day TVL change clamped to [' + t.growth_floor + '%, +' + t.growth_cap + '%] at weight ' + t.growth_weight + '; seasoning runs from ' + t.age_floor + ' to ' + (t.age_floor + t.age_span).toFixed(1) + ' over ' + t.age_cap_days + ' days; each extra chain past the first adds ' + (t.chain_step * 100) + '% (max ' + t.chain_cap + '). No protocol name is ever special-cased.</p>' +
      '<table><thead><tr><th>Category</th><th>Multiple</th><th>Evidence</th><th>Raw median</th></tr></thead><tbody>' + rows + '</tbody></table>';
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
      box.innerHTML = '<h2>Detail view</h2><p class="empty">Select a protocol on the board to see its snapshot record, the model breakdown behind its implied value, and its farm plan.</p>';
      return;
    }
    var again = recompute(row);
    var b = row.breakdown;
    box.innerHTML =
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.slug) + (row.watchlist ? ' · on the watchlist' : ' · early find') + ' · records no token</p>' +
      '<p class="value">' + moneyFull(row.implied_value_usd) + '</p>' +
      '<p class="value-note">Implied value, rank #' + row.rank + ' of ' + D.rows.length + '</p>' +
      '<h3>Snapshot record</h3><dl>' +
      '<dt>Category</dt><dd>' + esc(row.category || '—') + '</dd>' +
      '<dt>Chains</dt><dd>' + row.chains.map(esc).join(', ') + '</dd>' +
      '<dt>TVL</dt><dd>' + moneyFull(row.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + pct(row.change_7d) + '</dd>' +
      '<dt>Listed</dt><dd>' + esc(row.listed_at || 'unknown') + ' (' + ageText(row.age_days) + ')</dd>' +
      '<dt>Market cap</dt><dd>none recorded</dd>' +
      '</dl>' +
      '<h3>Model breakdown</h3><dl>' +
      '<dt>Category multiple</dt><dd>' + b.multiple.toFixed(3) + 'x</dd>' +
      '<dt>Growth used</dt><dd>' + pct(b.growth_pct) + ' → x' + b.growth_factor.toFixed(3) + '</dd>' +
      '<dt>Seasoning</dt><dd>x' + b.age_factor.toFixed(3) + '</dd>' +
      '<dt>Reach</dt><dd>x' + b.chain_factor.toFixed(3) + '</dd>' +
      '</dl>' +
      '<p class="match">' + (again === row.implied_value_usd ? 'Recomputed in this page: matches the board.' : 'Recomputed in this page: ' + moneyFull(again) + '.') + '</p>' +
      '<h3>Farm plan</h3><ol>' + row.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
  }

  function renderLive() {
    var sec = document.getElementById('live');
    if (state.tab !== 'live') { sec.hidden = true; return; }
    sec.hidden = false;
    sec.innerHTML = '<h2>Already trading — kept apart on purpose</h2>' +
      '<p>These ' + D.live.length + ' protocols record a token, so the market already prices them. Their market caps are shown above in place of an implied value, and the same live protocols calibrate the category multiples the board uses. A protocol leaves this list for the board only when its record shows no token.</p>';
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
  renderStats();
  renderMethod();
  renderControls();
  document.getElementById('source').textContent = 'Source: ' + D.source + '. Snapshot date: ' + D.as_of + '. Model: ' + D.model_name + '.';
  render();
})();
