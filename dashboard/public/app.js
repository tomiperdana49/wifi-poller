'use strict';

let cfg = { rssiLemah: -72, rssiSangatLemah: -80 };
let chart = null;

// Data mentah dari snapshot terakhir (WS atau fetch awal). Tabel selalu
// dirender ulang dari sini + filter aktif, supaya update real-time via WS
// tidak menghapus filter yang sedang dipakai user.
const state = {
  clients: [],
  aps: [],
  problemAps: [],
  overview: null,
  // sort: null berarti pakai urutan asli dari query (site,ap_name / rssi
  // ASC, atau utk problem-aps: paling parah dulu) -- baru dipakai kalau
  // user klik salah satu header kolom.
  apSort: null,
  clientSort: null,
  problemSort: null,
  // Daftar AP dari wifi_hourly untuk dropdown Tren Historis; opsinya
  // disaring ulang tiap filter global berubah.
  apList: [],
  // Filter global (Vendor + Controller) -- sumber kebenaran, bukan nilai
  // <select>-nya, karena opsi controller baru ada setelah data pertama
  // masuk sedangkan nilai awalnya bisa datang dari URL
  // (?controller=ruijie-nusanet-jakarta) yang di-bookmark.
  filter: readUrlFilter(),
};

function readUrlFilter() {
  const p = new URLSearchParams(location.search);
  return { vendor: p.get('vendor') || '', controller: p.get('controller') || '' };
}

function writeUrlFilter() {
  const p = new URLSearchParams(location.search);
  for (const k of ['vendor', 'controller']) {
    if (state.filter[k]) p.set(k, state.filter[k]);
    else p.delete(k);
  }
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

// Baris data (client/AP/problem-AP/ap-list) lolos filter global?
function matchGlobal(r) {
  const { vendor, controller } = state.filter;
  return (!vendor || r.vendor === vendor) && (!controller || r.controller === controller);
}

const NUMERIC_KEYS = new Set([
  'clients', 'avg_rssi', 'min_rssi', 'lemah', 'sangat_lemah', 'rssi', 'snr',
  'jam_terpantau', 'jam_bermasalah', 'pct_jam_bermasalah', 'avg_pct_sangat_lemah',
]);

function sortRows(rows, sort) {
  if (!sort) return rows;
  const { key, dir } = sort;
  const numeric = NUMERIC_KEYS.has(key);
  return [...rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    // Nilai kosong selalu di bawah, terlepas arah sort -- supaya "-"
    // tidak nyelip di antara data yang bermakna.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (numeric) return (Number(va) - Number(vb)) * dir;
    return String(va).localeCompare(String(vb), 'id', { sensitivity: 'base' }) * dir;
  });
}

// Tiga tabel bisa disortir header-nya (AP, Client Live, AP Bermasalah).
// Tabel terakhir datanya bukan dari snapshot WS (state.aps/clients) tapi
// hasil fetch periodik sendiri, jadi rerender-nya beda: bukan
// applyFilters() melainkan render ulang dari cache filteredProblemAps().
const SORT_TARGETS = {
  ap: { stateKey: 'apSort', sectionId: 'section-aps', rerender: () => applyFilters() },
  client: { stateKey: 'clientSort', sectionId: 'section-clients', rerender: () => applyFilters() },
  problem: {
    stateKey: 'problemSort',
    sectionId: 'section-problem-aps',
    rerender: () => renderProblemTable(filteredProblemAps()),
  },
};

function toggleSort(which, key) {
  const t = SORT_TARGETS[which];
  const current = state[t.stateKey];
  state[t.stateKey] = current && current.key === key
    ? { key, dir: -current.dir }
    : { key, dir: 1 };
  updateSortIndicators(which);
  t.rerender();
}

function updateSortIndicators(which) {
  const t = SORT_TARGETS[which];
  const sort = state[t.stateKey];
  document.querySelectorAll(`#${t.sectionId} th[data-key]`).forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (sort && th.dataset.key === sort.key) {
      th.classList.add(sort.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

function initSortableHeaders() {
  for (const which of Object.keys(SORT_TARGETS)) {
    const sectionId = SORT_TARGETS[which].sectionId;
    document.querySelectorAll(`#${sectionId} th[data-key]`).forEach((th) => {
      th.addEventListener('click', () => toggleSort(which, th.dataset.key));
    });
  }
}

const $ = (id) => document.getElementById(id);

// Data bisa sampai ribuan baris (mis. 4800 client) -- render ulang tabel
// di tiap keystroke terasa berat/lag di mesin biasa. Debounce kecil ini
// cukup untuk bikin ketikan tetap responsif secara visual tanpa
// menunda hasil pencarian secara terasa.
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bungkus bagian teks yang cocok dengan query pencarian aktif pakai
// <mark>, supaya user langsung lihat KENAPA baris itu muncul di hasil
// (mis. cocok di SSID, bukan di MAC). Jalan di atas string yang sudah
// di-escape HTML (esc()), jadi aman dari XSS lewat data server.
function highlight(escapedText, rawQuery) {
  if (!rawQuery) return escapedText;
  const q = escapeRegExp(esc(rawQuery));
  return escapedText.replace(new RegExp(`(${q})`, 'ig'), '<mark>$1</mark>');
}

// Tom Select membungkus <select> asli dengan kotak pencarian, sambil tetap
// menjaga elemen <select> aslinya sinkron (value + event 'change') — jadi
// semua addEventListener('change', ...) di bawah tetap bekerja tanpa ubah.
const selects = {};

function initSelects() {
  const ids = [
    'global-filter-vendor', 'global-filter-controller',
    'ap-filter-site', 'ap-filter-band',
    'client-filter-site', 'client-filter-band', 'client-filter-signal',
    'hist-ap', 'hist-hours',
    'problem-filter-site', 'problem-filter-band', 'problem-hours',
  ];
  for (const id of ids) {
    selects[id] = new TomSelect(`#${id}`, {
      allowEmptyOption: true,
      create: false,
      maxOptions: null,
      // Render dropdown ke <body>, bukan menempel di elemen induknya —
      // beberapa induk (mis. .subnav) punya overflow-x:auto yang otomatis
      // ikut meng-clip arah vertikal juga (aturan CSS overflow-x/y saling
      // terkait), jadi dropdown yang menempel di situ bisa kepotong.
      dropdownParent: 'body',
      // Efek samping dropdownParent selain default: lebar dropdown lepas
      // dari lebar kotak control-nya (jadi selebar body). Samakan manual
      // tiap kali dibuka.
      onDropdownOpen(dropdown) {
        dropdown.style.width = this.control.getBoundingClientRect().width + 'px';
      },
    });
  }
}

function rssiClass(rssi) {
  if (rssi == null) return '';
  if (rssi < cfg.rssiSangatLemah) return 'rssi-bad';
  if (rssi < cfg.rssiLemah) return 'rssi-warn';
  return 'rssi-good';
}

function signalBucket(rssi) {
  if (rssi == null) return null;
  if (rssi < cfg.rssiSangatLemah) return 'sangat_lemah';
  if (rssi < cfg.rssiLemah) return 'lemah';
  return 'ok';
}

// Isi ulang opsi Tom Select dari data terbaru, tanpa mengganggu pilihan
// user yang sedang aktif (kalau opsinya masih ada di data baru). Lewat API
// instance, bukan manipulasi DOM <select> langsung — Tom Select tidak
// memantau perubahan DOM di elemen <select> yang sudah dibungkusnya.
function syncOptions(id, values, allLabel, current = selects[id].getValue()) {
  const inst = selects[id];
  const unique = [...new Set(values)].filter(Boolean).sort();

  // clear(true) dulu (silent, tanpa event change): clearOptions() sengaja
  // mempertahankan opsi yang sedang terpilih beserta urutan lamanya, jadi
  // tanpa ini opsi terpilih melompat ke paling atas daftar -- di atas
  // "Semua X" -- setiap kali snapshot baru masuk.
  inst.clear(true);
  inst.clearOptions();
  inst.addOption({ value: '', text: allLabel });
  for (const v of unique) inst.addOption({ value: v, text: v });
  inst.refreshOptions(false);
  inst.setValue(unique.includes(current) ? current : '', true);
}

// label controller -> vendor. Dari snapshot client + panel Status Poller
// (yang tetap mendaftar controller walau sedang 0 client / gagal poll).
function knownControllers() {
  const m = new Map();
  for (const r of state.clients) if (r.controller) m.set(r.controller, r.vendor);
  for (const c of healthState.data ? healthState.data.controllers : []) m.set(c.label, c.type);
  return m;
}

// Nilai filter yang sedang aktif selalu ikut jadi opsi, supaya pilihan
// dari URL tetap tampil walau datanya belum masuk.
function syncGlobalOptions() {
  const { vendor, controller } = state.filter;
  const known = knownControllers();
  syncOptions(
    'global-filter-vendor',
    [...state.aps.map((r) => r.vendor), ...state.clients.map((r) => r.vendor), ...known.values(), vendor],
    'Semua Vendor',
    vendor
  );
  const labels = [...known].filter(([, v]) => !vendor || v === vendor).map(([l]) => l);
  syncOptions('global-filter-controller', [...labels, controller], 'Semua Controller', controller);
}

function setGlobalFilter(next) {
  Object.assign(state.filter, next);
  // Ganti vendor ke yang bukan milik controller terpilih -> lepas controllernya.
  const ctrlVendor = knownControllers().get(state.filter.controller);
  if (state.filter.vendor && ctrlVendor && ctrlVendor !== state.filter.vendor) {
    state.filter.controller = '';
  }
  writeUrlFilter();
  syncGlobalOptions();
  applyFilters();
  renderProblemTable(filteredProblemAps());
  renderHealth();
  syncHistApOptions();
  loadHistory();
}

function filteredAps() {
  const search = $('ap-filter-search').value.trim().toLowerCase();
  const site = $('ap-filter-site').value;
  const band = $('ap-filter-band').value;
  const rows = state.aps.filter((r) => {
    if (!matchGlobal(r)) return false;
    if (site && r.site !== site) return false;
    if (band && r.band !== band) return false;
    if (search) {
      const hay = `${r.site} ${r.ap_name} ${r.vendor} ${r.band ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  return sortRows(rows, state.apSort);
}

function filteredClients() {
  const search = $('client-filter-search').value.trim().toLowerCase();
  const site = $('client-filter-site').value;
  const band = $('client-filter-band').value;
  const signal = $('client-filter-signal').value;
  const rows = state.clients.filter((r) => {
    if (!matchGlobal(r)) return false;
    if (site && r.site !== site) return false;
    if (band && r.band !== band) return false;
    if (signal && signalBucket(r.rssi) !== signal) return false;
    if (search) {
      const hay = `${r.client_mac} ${r.username ?? ''} ${r.site} ${r.ap_name} ${r.ssid ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  return sortRows(rows, state.clientSort);
}

// state.problemAps datang dari /api/problem-aps utk rentang waktu yang
// sedang dipilih (di-refetch tiap rentang berubah, lihat loadProblemAps).
// Filter site/band/vendor/controller di sini murni client-side supaya
// ganti filter tidak perlu round-trip lagi ke server.
function filteredProblemAps() {
  const site = $('problem-filter-site').value;
  const band = $('problem-filter-band').value;
  const rows = state.problemAps.filter(
    (r) =>
      matchGlobal(r) &&
      (!site || r.site === site) &&
      (!band || r.band === band)
  );
  return sortRows(rows, state.problemSort);
}

const fmtNum = (n) => (n == null ? '-' : Number(n).toLocaleString('id-ID'));
const pctOf = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);

function renderOverview(o) {
  if (!o) return;
  $('card-clients').textContent = fmtNum(o.clients);
  $('card-aps').textContent = fmtNum(o.aps);
  $('card-lemah').textContent = fmtNum(o.lemah ?? 0);
  $('card-sangat-lemah').textContent = fmtNum(o.sangat_lemah ?? 0);
  $('card-lemah-pct').textContent = `${pctOf(o.lemah, o.clients)}% dari client`;
  $('card-sangat-lemah-pct').textContent = `${pctOf(o.sangat_lemah, o.clients)}% dari client`;
  $('card-clients-sub').textContent = o.clients ? `rata² ${Math.round((o.clients / (o.aps || 1)) * 10) / 10} per AP` : '\u00a0';
  $('card-aps-sub').textContent = o.sites ? `di ${fmtNum(o.sites)} site` : '\u00a0';
  $('card-ts').textContent = o.ts ?? '-';
}

function renderApsTable(rows) {
  const tbody = $('ap-table');
  const query = $('ap-filter-search').value.trim();
  const empty = $('ap-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = query && state.aps.length > 0
    ? `Tidak ada AP cocok untuk "${query}".`
    : 'Belum ada data.';
  const h = (v) => highlight(esc(v), query);
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${h(r.site)}</td><td>${h(r.ap_name)}</td><td>${esc(r.band ?? '-')}</td>
        <td>${h(r.vendor)}</td><td>${r.clients}</td>
        <td class="${rssiClass(r.avg_rssi)}">${r.avg_rssi ?? '-'}</td>
        <td class="${rssiClass(r.min_rssi)}">${r.min_rssi ?? '-'}</td>
        <td>${r.lemah ?? 0}</td><td>${r.sangat_lemah ?? 0}</td>
      </tr>`
    )
    .join('');
}

function renderClientsTable(rows) {
  $('client-count').textContent = `${rows.length}/${state.clients.length}`;
  const tbody = $('client-table');
  const query = $('client-filter-search').value.trim();
  const empty = $('client-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = query && state.clients.length > 0
    ? `Tidak ada client cocok untuk "${query}".`
    : 'Belum ada client.';
  const h = (v) => highlight(esc(v), query);
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${h(r.client_mac)}</td><td>${h(r.username ?? '-')}</td>
        <td>${h(r.site)}</td><td>${h(r.ap_name)}</td><td>${h(r.ssid ?? '-')}</td>
        <td>${esc(r.band ?? '-')}</td><td>${esc(r.vendor)}</td>
        <td class="${rssiClass(r.rssi)}">${r.rssi ?? '-'}</td>
        <td>${r.snr ?? '-'}</td>
      </tr>`
    )
    .join('');
}

function renderProblemTable(rows) {
  const tbody = $('problem-table');
  const empty = $('problem-empty');
  empty.hidden = rows.length > 0;
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.site)}</td><td>${esc(r.ap_name)}</td><td>${esc(r.band ?? '-')}</td>
        <td>${esc(r.vendor)}</td>
        <td>${r.jam_terpantau}</td><td>${r.jam_bermasalah}</td>
        <td class="${pctSeverityClass(r.pct_jam_bermasalah)}">${r.pct_jam_bermasalah}%</td>
        <td class="${pctSeverityClass(r.avg_pct_sangat_lemah)}">${r.avg_pct_sangat_lemah}%</td>
      </tr>`
    )
    .join('');
}

// Reuse warna rssi-good/warn/bad (cuma nama class, bukan literal RSSI)
// buat mewarnai persentase di tabel AP Bermasalah -- skemanya sama:
// makin tinggi persentase makin parah.
function pctSeverityClass(pct) {
  if (pct == null) return '';
  if (pct >= 50) return 'rssi-bad';
  if (pct >= 15) return 'rssi-warn';
  return 'rssi-good';
}

// Overview cards dihitung ulang di sisi client dari snapshot client-live
// yang sama dipakai tabel Client Live, supaya kartu "Client Aktif"/"AP
// Aktif"/"Sinyal Lemah" ikut ke-scope ke vendor/controller yang dipilih.
// "Update Terakhir" tetap dari respons server karena tidak bergantung filter.
function computeOverview() {
  const rows = state.clients.filter(matchGlobal);
  const apNames = new Set(rows.map((r) => r.ap_name));
  const sites = new Set(rows.map((r) => r.site));
  let lemah = 0;
  let sangatLemah = 0;
  for (const r of rows) {
    const bucket = signalBucket(r.rssi);
    if (bucket === 'lemah') lemah++;
    else if (bucket === 'sangat_lemah') sangatLemah++;
  }
  return {
    ts: state.overview ? state.overview.ts : null,
    clients: rows.length,
    aps: apNames.size,
    sites: sites.size,
    lemah,
    sangat_lemah: sangatLemah,
  };
}

// Render ulang kartu + kedua tabel dari state + filter yang sedang aktif.
// Dipanggil tiap kali filter berubah ATAU data baru masuk lewat WS, supaya
// filter user tidak hilang ketika snapshot baru datang.
function applyFilters() {
  renderOverview(computeOverview());
  renderInsights();
  renderApsTable(filteredAps());
  renderClientsTable(filteredClients());
}

function updateData(overview, aps, clients) {
  state.aps = aps;
  state.clients = clients;
  state.overview = overview;
  syncGlobalOptions();
  syncOptions('ap-filter-site', aps.map((r) => r.site), 'Semua Site');
  syncOptions('ap-filter-band', aps.map((r) => r.band), 'Semua Band');
  syncOptions('client-filter-site', clients.map((r) => r.site), 'Semua Site');
  syncOptions('client-filter-band', clients.map((r) => r.band), 'Semua Band');
  applyFilters();
}

function showSignalFilter(bucket) {
  selects['client-filter-signal'].setValue(bucket, true);
  applyFilters();
  $('client-table').closest('section').scrollIntoView({ behavior: 'auto', block: 'start' });
}

function resetClientFilters() {
  $('client-filter-search').value = '';
  $('client-filter-search-clear').hidden = true;
  selects['client-filter-site'].setValue('', true);
  selects['client-filter-band'].setValue('', true);
  selects['client-filter-signal'].setValue('', true);
  applyFilters();
  $('client-table').closest('section').scrollIntoView({ behavior: 'auto', block: 'start' });
}

// Hubungkan satu kotak pencarian teks: toggle tombol "x" saat ada isi,
// filter di-debounce supaya ketikan cepat tidak memicu render tabel
// besar berkali-kali, dan tombol "x" fokus balik ke input setelah clear.
function wireSearchBox(inputId, clearId, onChange) {
  const input = $(inputId);
  const clear = $(clearId);
  const debounced = debounce(onChange, 150);
  input.addEventListener('input', () => {
    clear.hidden = input.value.length === 0;
    debounced();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    input.focus();
    onChange();
  });
}

function scrollToApTable() {
  $('ap-table').closest('section').scrollIntoView({ behavior: 'auto', block: 'start' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatus(connected, text) {
  const el = $('status');
  el.classList.toggle('connected', connected);
  $('status-text').textContent = text;
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => setStatus(true, 'terhubung');
  ws.onclose = () => {
    setStatus(false, 'terputus, mencoba lagi...');
    setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'snapshot') {
      updateData(msg.overview, msg.aps, msg.clients);
      loadHealth();
    }
  };
}

async function loadInitial() {
  const [c, overview, aps, clients] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/overview').then((r) => r.json()),
    fetch('/api/aps').then((r) => r.json()),
    fetch('/api/clients').then((r) => r.json()),
  ]);
  cfg = c;
  updateData(overview, aps, clients);
}

async function loadApList() {
  state.apList = await fetch('/api/ap-list').then((r) => r.json());
  syncHistApOptions();
}

function syncHistApOptions() {
  const inst = selects['hist-ap'];
  const current = inst.getValue();
  const rows = state.apList.filter(matchGlobal);
  inst.clear(true);
  inst.clearOptions();
  inst.addOption({ value: '', text: 'Semua AP' });
  for (const r of rows) {
    inst.addOption({ value: r.ap_name, text: `${r.ap_name} (${r.site})` });
  }
  inst.refreshOptions(false);
  inst.setValue(rows.some((r) => r.ap_name === current) ? current : '', true);
}

// Format Date lokal (bukan UTC) ke bentuk yang diterima <input
// type="datetime-local">: "YYYY-MM-DDTHH:MM".
function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Menghubungkan satu trio dropdown-preset + dua input datetime-local
// (dipakai di "Tren Historis" dan "AP Bermasalah"). onChange dipanggil
// tiap preset/tanggal berubah; params() mengembalikan URLSearchParams
// berisi hours ATAU from+to, atau null kalau rentang custom belum lengkap
// (caller lalu skip fetch, tidak nembak query dengan tanggal kosong).
function initRangePicker(presetId, fromId, toId, rangeId, onChange) {
  const presetEl = $(presetId);
  const rangeEl = $(rangeId);
  const fromEl = $(fromId);
  const toEl = $(toId);

  function sync() {
    const isCustom = presetEl.value === 'custom';
    rangeEl.hidden = !isCustom;
    // Baru pertama kali masuk custom (input masih kosong) -- isi default
    // 24 jam terakhir supaya tampilan tidak kosong sambil user menyesuaikan.
    if (isCustom && (!fromEl.value || !toEl.value)) {
      const now = new Date();
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      fromEl.value = toLocalInputValue(from);
      toEl.value = toLocalInputValue(now);
    }
    onChange();
  }

  presetEl.addEventListener('change', sync);
  fromEl.addEventListener('change', onChange);
  toEl.addEventListener('change', onChange);

  return {
    params() {
      const params = new URLSearchParams();
      if (presetEl.value === 'custom') {
        if (!fromEl.value || !toEl.value) return null;
        params.set('from', fromEl.value);
        params.set('to', toEl.value);
      } else {
        params.set('hours', presetEl.value);
      }
      return params;
    },
  };
}

async function loadHistory() {
  const params = histRange.params();
  if (!params) return;
  const ap = $('hist-ap').value;
  if (ap) params.set('ap', ap);
  if (state.filter.vendor) params.set('vendor', state.filter.vendor);
  if (state.filter.controller) params.set('controller', state.filter.controller);
  const rows = await fetch(`/api/history?${params}`).then((r) => r.json());
  renderChart(rows);
}

// AP Bermasalah: fetch ulang cuma saat rentang waktu berubah (query
// wifi_hourly beda periode). Filter site/band/vendor tidak perlu fetch
// ulang -- cukup filteredProblemAps() di sisi client, lihat komentarnya.
async function loadProblemAps() {
  const params = problemRange.params();
  if (!params) return;
  const rows = await fetch(`/api/problem-aps?${params}`).then((r) => r.json());
  state.problemAps = rows;
  syncOptions('problem-filter-site', rows.map((r) => r.site), 'Semua Site');
  syncOptions('problem-filter-band', rows.map((r) => r.band), 'Semua Band');
  renderProblemTable(filteredProblemAps());
}

function renderChart(rows) {
  // Kalau "semua AP" dipilih, gabungkan per hour_ts (rata-rata avg_rssi,
  // jumlah clients_unik) supaya chart tidak jadi garis tumpang tindih
  // per-AP yang tidak terbaca.
  const byHour = new Map();
  for (const r of rows) {
    const key = r.hour_ts;
    if (!byHour.has(key)) byHour.set(key, { rssiSum: 0, rssiN: 0, clients: 0 });
    const b = byHour.get(key);
    if (r.avg_rssi != null) {
      b.rssiSum += Number(r.avg_rssi);
      b.rssiN += 1;
    }
    b.clients += Number(r.clients_unik) || 0;
  }
  const labels = [...byHour.keys()].sort();
  const avgRssi = labels.map((k) => {
    const b = byHour.get(k);
    return b.rssiN ? Math.round((b.rssiSum / b.rssiN) * 10) / 10 : null;
  });
  const clients = labels.map((k) => byHour.get(k).clients);

  const ctx = $('chart').getContext('2d');
  if (chart) chart.destroy();
  const accent = cssVar('--accent');
  const good = cssVar('--good');
  const fill = ctx.createLinearGradient(0, 0, 0, 320);
  fill.addColorStop(0, withAlpha(accent, 0.28));
  fill.addColorStop(1, withAlpha(accent, 0));
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Avg RSSI (dBm)',
          data: avgRssi,
          borderColor: accent,
          backgroundColor: fill,
          fill: true,
          yAxisID: 'y',
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
        {
          label: 'Client unik',
          data: clients,
          borderColor: good,
          backgroundColor: good,
          yAxisID: 'y1',
          tension: 0.3,
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 24 } },
        tooltip: {
          backgroundColor: cssVar('--bg-elevated'),
          borderColor: cssVar('--panel-border'),
          borderWidth: 1,
          titleColor: cssVar('--text'),
          bodyColor: cssVar('--text-dim'),
          padding: 10,
          cornerRadius: 8,
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 24, callback(v) { return shortTs(this.getLabelForValue(v)); } } },
        y: { type: 'linear', position: 'left', title: { display: true, text: 'dBm' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'client' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// ---------- tema & util tampilan ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

// "2026-09-24 15:00:00" -> "24/09 15:00" (label sumbu X chart historis).
function shortTs(s) {
  const m = /^\d{4}-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(String(s));
  return m ? `${m[2]}/${m[1]} ${m[3]}` : s;
}

function initChartTheme() {
  Chart.defaults.color = cssVar('--text-dim');
  Chart.defaults.borderColor = cssVar('--panel-border');
  Chart.defaults.font.family = cssVar('--font-sans');
  Chart.defaults.font.size = 11.5;
}

// "32 dtk lalu", "4 mnt lalu", "2 jam lalu".
function fmtAge(sec) {
  if (sec == null || Number.isNaN(sec)) return '-';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

function fmtMs(ms) {
  if (ms == null) return '-';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} dtk`;
}

// Sorot link subnav untuk section yang sedang dibaca: section terakhir
// yang bagian atasnya sudah melewati bawah header sticky.
function initNavHighlight() {
  const links = [...document.querySelectorAll('.subnav a[href^="#"]')];
  const targets = links.map((a) => [a, $(a.getAttribute('href').slice(1))]).filter(([, el]) => el);
  let queued = false;
  const update = () => {
    queued = false;
    let current = targets[0];
    for (const t of targets) {
      if (t[1].getBoundingClientRect().top <= 140) current = t;
    }
    // Sudah mentok bawah: section terakhir mungkin tidak pernah sampai ke
    // atas layar, jadi anggap itu yang sedang dibaca.
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      current = targets[targets.length - 1];
    }
    links.forEach((a) => a.classList.toggle('active', a === current[0]));
  };
  window.addEventListener('scroll', () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  update();
}

// ---------- ringkasan: distribusi sinyal & AP terburuk ----------

function renderInsights() {
  const rows = state.clients.filter(matchGlobal);

  const groups = new Map();
  for (const r of rows) {
    const name = r.controller || r.vendor;
    if (!groups.has(name)) groups.set(name, { ok: 0, lemah: 0, sangat_lemah: 0, total: 0 });
    const g = groups.get(name);
    const b = signalBucket(r.rssi);
    if (b) g[b]++;
    g.total++;
  }
  const list = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  if (list.length > 1) {
    const all = { ok: 0, lemah: 0, sangat_lemah: 0, total: 0 };
    for (const [, g] of list) for (const k of Object.keys(all)) all[k] += g[k];
    list.push(['Total', all]);
  }

  $('signal-dist').innerHTML = list.length
    ? list
        .map(([name, g]) => {
          const p = (n) => pctOf(n, g.total);
          return `<div class="dist-row${name === 'Total' ? ' total' : ''}">
            <div class="dist-head">
              <span class="dist-name">${esc(name)}</span>
              <span class="dist-count">${fmtNum(g.total)} client &middot; <b class="rssi-bad">${p(g.sangat_lemah)}%</b> sangat lemah</span>
            </div>
            <div class="stack-bar" role="img" aria-label="${esc(name)}: ${p(g.ok)}% baik, ${p(g.lemah)}% lemah, ${p(g.sangat_lemah)}% sangat lemah">
              <span class="seg good" style="width:${p(g.ok)}%" title="Baik: ${fmtNum(g.ok)}"></span>
              <span class="seg warn" style="width:${p(g.lemah)}%" title="Lemah: ${fmtNum(g.lemah)}"></span>
              <span class="seg bad" style="width:${p(g.sangat_lemah)}%" title="Sangat lemah: ${fmtNum(g.sangat_lemah)}"></span>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty">Belum ada data.</div>';

  // AP (digabung semua band) dengan porsi client sangat lemah tertinggi.
  // Minimal 3 client supaya AP dengan 1 client jelek tidak mendominasi.
  const aps = new Map();
  for (const r of state.aps) {
    if (!matchGlobal(r)) continue;
    const key = `${r.site}\u0000${r.ap_name}`;
    if (!aps.has(key)) aps.set(key, { site: r.site, ap_name: r.ap_name, source: r.controller || r.vendor, clients: 0, bad: 0 });
    const a = aps.get(key);
    a.clients += Number(r.clients) || 0;
    a.bad += Number(r.sangat_lemah) || 0;
  }
  const worst = [...aps.values()]
    .filter((a) => a.clients >= 3 && a.bad > 0)
    .map((a) => ({ ...a, pct: pctOf(a.bad, a.clients) }))
    .sort((a, b) => b.pct - a.pct || b.bad - a.bad)
    .slice(0, 6);

  $('worst-empty').hidden = worst.length > 0;
  $('worst-aps').innerHTML = worst
    .map(
      (a) => `<li data-ap="${esc(a.ap_name)}" title="Klik untuk cari AP ini di tabel">
        <div class="worst-main">
          <span class="worst-name">${esc(a.ap_name)}</span>
          <span class="worst-site">${esc(a.site)} &middot; ${esc(a.source)}</span>
        </div>
        <div class="worst-meter"><span style="width:${Math.min(100, a.pct)}%"></span></div>
        <div class="worst-val"><b>${a.pct}%</b><small>${a.bad}/${a.clients}</small></div>
      </li>`
    )
    .join('');
}

$('worst-aps').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-ap]');
  if (!li) return;
  const input = $('ap-filter-search');
  input.value = li.dataset.ap;
  $('ap-filter-search-clear').hidden = false;
  applyFilters();
  scrollToApTable();
});

// ---------- status poller (health) ----------

// age_s dari server dihitung saat fetch; ditambah waktu yang sudah lewat
// sejak itu supaya label "x dtk lalu" terus berjalan walau poller macet
// (justru saat itulah tidak ada snapshot WS baru yang memicu render).
const healthState = { data: null, fetchedAt: 0 };

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(res.status);
    healthState.data = await res.json();
    healthState.fetchedAt = Date.now();
    renderHealth();
  } catch (e) {
    console.error('health', e);
  }
}

function elapsed() {
  return (Date.now() - healthState.fetchedAt) / 1000;
}

const STATUS_LABEL = { ok: 'OK', error: 'Error', stale: 'Terlambat' };

function sparkline(series, status) {
  if (series.length < 2) return '<div class="spark empty-spark">belum cukup data</div>';
  const w = 240;
  const h = 44;
  const max = Math.max(1, ...series.map((p) => p.clients));
  const step = w / (series.length - 1);
  const pts = series.map((p, i) => [i * step, h - 3 - (p.clients / max) * (h - 8)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${w},${h}L0,${h}Z`;
  const fails = series
    .map((p, i) => (p.fails > 0 ? `<rect x="${(i * step - 1.5).toFixed(1)}" y="0" width="3" height="${h}" class="fail-mark"><title>${esc(p.t)}: ${p.fails} gagal</title></rect>` : ''))
    .join('');
  return `<svg class="spark ${status}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${fails}<path d="${area}" class="area" /><path d="${line}" class="line" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function renderHealth() {
  const h = healthState.data;
  if (!h) return;
  // Controller baru (atau yang cuma ada di health, 0 client) ikut jadi opsi.
  syncGlobalOptions();

  const grid = $('controller-grid');
  const empty = $('health-empty');
  // Panel ikut filter global: pilih "omada" -> cuma kartu omada. Banner
  // peringatan di atas (tickAges) tetap menghitung semua controller supaya
  // gangguan di controller lain tidak tersembunyi.
  const shown = h.controllers.filter((c) => matchGlobal({ vendor: c.type, controller: c.label }));
  const failing = shown.filter((c) => c.status !== 'ok');

  const overall = h.stale ? 'stale' : failing.length ? 'error' : h.available ? 'ok' : 'unknown';
  const pill = $('health-overall');
  pill.className = `status-pill ${overall}`;
  pill.textContent = {
    ok: 'Semua normal',
    error: `${failing.length} controller bermasalah`,
    stale: 'Data terlambat',
    unknown: 'Belum aktif',
  }[overall];

  if (!h.available) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = 'Pencatatan status poller belum aktif. Jalankan migration <code>poller/sql/001_poller_health.sql</code> di server.';
  } else if (!shown.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'Belum ada catatan run dari poller. Tunggu satu siklus (±1 menit).';
  } else {
    empty.hidden = true;
    grid.innerHTML = shown
      .map(
        (c) => `<article class="ctrl ${c.status}${c.label === state.filter.controller ? ' selected' : ''}" data-label="${esc(c.label)}"
          title="${c.label === state.filter.controller ? 'Klik untuk tampilkan semua controller' : 'Klik untuk monitor controller ini saja'}">
          <div class="ctrl-head">
            <span class="status-pill ${c.status}">${STATUS_LABEL[c.status]}</span>
            <span class="vendor-tag">${esc(c.type)}</span>
          </div>
          <div class="ctrl-name" title="${esc(c.label)}">${esc(c.label)}</div>
          <div class="ctrl-value${c.status === 'stale' ? ' dim' : ''}" title="${c.status === 'stale' ? 'Jumlah dari run terakhir' : ''}">${c.status === 'error' ? '&ndash;' : fmtNum(c.clients)}<small>client</small></div>
          ${sparkline(c.series, c.status)}
          <dl class="ctrl-meta">
            <div><dt>Run terakhir</dt><dd data-age-label="${esc(c.label)}">${fmtAge(c.age_s + elapsed())}</dd></div>
            <div><dt>Durasi</dt><dd>${fmtMs(c.duration_ms)}</dd></div>
            <div><dt>Gagal 24j</dt><dd class="${c.fails_24h ? 'rssi-bad' : ''}">${fmtNum(c.fails_24h)}/${fmtNum(c.runs_24h)}</dd></div>
          </dl>
          ${c.status !== 'ok'
            ? `<div class="ctrl-error">${c.error ? esc(c.error) : 'Tidak ada run baru.'}${c.last_ok_ts ? `<span>Terakhir sukses: ${esc(c.last_ok_ts)}</span>` : ''}</div>`
            : ''}
        </article>`
      )
      .join('');
  }

  const cy = h.cycle;
  const c24 = h.cycle_24h;
  const chips = [];
  if (cy) {
    // Siklus > 45 dtk mendekati batas cron 60 dtk -- siklus berikutnya
    // bakal di-SKIP oleh lock file dan data jadi bolong.
    const slow = cy.duration_ms > 45000;
    chips.push(`<span class="chip ${slow ? 'warn' : ''}" title="Durasi siklus terakhir; batas aman < 60 dtk (interval cron)">Siklus <b>${fmtMs(cy.duration_ms)}</b></span>`);
  }
  if (c24 && c24.cycles) {
    chips.push(`<span class="chip ${c24.bad_cycles ? 'bad' : ''}" title="Siklus dengan minimal satu controller gagal, 24 jam terakhir">Siklus bermasalah 24j <b>${fmtNum(c24.bad_cycles)}/${fmtNum(c24.cycles)}</b></span>`);
    if (c24.pct_resolved != null) {
      chips.push(`<span class="chip ${c24.pct_resolved < 20 ? 'warn' : ''}" title="Persentase client yang username-nya ketemu di radacct">Username ter-resolve <b>${String(c24.pct_resolved).replace('.', ',')}%</b></span>`);
    }
  }
  if (state.filter.vendor || state.filter.controller) {
    chips.push('<button type="button" class="chip chip-btn" id="health-show-all" title="Hapus filter Vendor &amp; Controller">Tampilkan semua controller</button>');
  }
  $('health-stats').innerHTML = chips.join('');

  tickAges();
}

// Dipanggil tiap detik: perbarui semua label umur + banner + judul tab.
function tickAges() {
  const h = healthState.data;
  let age = null;
  if (h && h.data_age_s != null) age = h.data_age_s + elapsed();

  const ageEl = $('card-age');
  const box = $('card-ts-box');
  ageEl.textContent = age == null ? '-' : fmtAge(age);
  const stale = h && (age == null || age > h.stale_after_s);
  box.classList.toggle('bad', !!stale);

  if (h) {
    const byLabel = new Map(h.controllers.map((c) => [c.label, c]));
    document.querySelectorAll('[data-age-label]').forEach((el) => {
      const c = byLabel.get(el.dataset.ageLabel);
      if (c) el.textContent = fmtAge(c.age_s + elapsed());
    });
  }

  const failing = h ? h.controllers.filter((c) => c.status !== 'ok').length : 0;
  const banner = $('stale-banner');
  if (stale) {
    banner.hidden = false;
    banner.className = 'alert-banner bad';
    $('stale-banner-text').textContent = `Data terakhir masuk ${fmtAge(age)} — poller kemungkinan berhenti atau semua controller gagal.`;
  } else if (failing) {
    banner.hidden = false;
    banner.className = 'alert-banner warn';
    $('stale-banner-text').textContent = `${failing} controller gagal di-poll — data dari controller tersebut tidak ikut tampil.`;
  } else {
    banner.hidden = true;
  }

  const prefix = stale ? '⛔ ' : failing ? '⚠ ' : '';
  const title = `${prefix}WiFi Poller Dashboard`;
  if (document.title !== title) document.title = title;
}

const histRange = initRangePicker('hist-hours', 'hist-from', 'hist-to', 'hist-range', loadHistory);
const problemRange = initRangePicker('problem-hours', 'problem-from', 'problem-to', 'problem-range', loadProblemAps);

$('hist-ap').addEventListener('change', loadHistory);

$('problem-filter-site').addEventListener('change', () => renderProblemTable(filteredProblemAps()));
$('problem-filter-band').addEventListener('change', () => renderProblemTable(filteredProblemAps()));

$('global-filter-vendor').addEventListener('change', (e) => setGlobalFilter({ vendor: e.target.value }));
$('global-filter-controller').addEventListener('change', (e) => setGlobalFilter({ controller: e.target.value }));
$('health-stats').addEventListener('click', (e) => {
  if (e.target.closest('#health-show-all')) setGlobalFilter({ vendor: '', controller: '' });
});
$('controller-grid').addEventListener('click', (e) => {
  const card = e.target.closest('article.ctrl[data-label]');
  if (!card) return;
  const label = card.dataset.label;
  setGlobalFilter({ controller: state.filter.controller === label ? '' : label });
});
$('ap-filter-site').addEventListener('change', applyFilters);
$('ap-filter-band').addEventListener('change', applyFilters);
wireSearchBox('ap-filter-search', 'ap-filter-search-clear', applyFilters);
wireSearchBox('client-filter-search', 'client-filter-search-clear', applyFilters);
$('client-filter-site').addEventListener('change', applyFilters);
$('client-filter-band').addEventListener('change', applyFilters);
$('client-filter-signal').addEventListener('change', applyFilters);

$('card-lemah-box').addEventListener('click', () => showSignalFilter('lemah'));
$('card-sangat-lemah-box').addEventListener('click', () => showSignalFilter('sangat_lemah'));
$('card-clients-box').addEventListener('click', resetClientFilters);
$('card-aps-box').addEventListener('click', scrollToApTable);
$('card-ts-box').addEventListener('click', () => $('section-health').scrollIntoView({ behavior: 'auto', block: 'start' }));

initChartTheme();
initSelects();
syncGlobalOptions();
initSortableHeaders();
initNavHighlight();
loadInitial();
loadHealth();
setInterval(loadHealth, 30000);
setInterval(tickAges, 1000);
loadApList().then(loadHistory);
loadProblemAps();
connectWs();
