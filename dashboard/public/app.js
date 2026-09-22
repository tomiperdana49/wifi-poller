'use strict';

let cfg = { rssiLemah: -72, rssiSangatLemah: -80 };
let chart = null;

// Data mentah dari snapshot terakhir (WS atau fetch awal). Tabel selalu
// dirender ulang dari sini + filter aktif, supaya update real-time via WS
// tidak menghapus filter yang sedang dipakai user.
const state = {
  clients: [],
  aps: [],
  overview: null,
  // sort: null berarti pakai urutan asli dari query (site,ap_name / rssi
  // ASC) -- baru dipakai kalau user klik salah satu header kolom.
  apSort: null,
  clientSort: null,
};

const NUMERIC_KEYS = new Set([
  'clients', 'avg_rssi', 'min_rssi', 'lemah', 'sangat_lemah', 'rssi', 'snr',
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

function toggleSort(which, key) {
  const stateKey = which === 'ap' ? 'apSort' : 'clientSort';
  const current = state[stateKey];
  state[stateKey] = current && current.key === key
    ? { key, dir: -current.dir }
    : { key, dir: 1 };
  updateSortIndicators(which);
  applyFilters();
}

function updateSortIndicators(which) {
  const sectionId = which === 'ap' ? 'section-aps' : 'section-clients';
  const sort = which === 'ap' ? state.apSort : state.clientSort;
  document.querySelectorAll(`#${sectionId} th[data-key]`).forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (sort && th.dataset.key === sort.key) {
      th.classList.add(sort.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

function initSortableHeaders() {
  document.querySelectorAll('#section-aps th[data-key]').forEach((th) => {
    th.addEventListener('click', () => toggleSort('ap', th.dataset.key));
  });
  document.querySelectorAll('#section-clients th[data-key]').forEach((th) => {
    th.addEventListener('click', () => toggleSort('client', th.dataset.key));
  });
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
    'global-filter-vendor',
    'ap-filter-site', 'ap-filter-band',
    'client-filter-site', 'client-filter-band', 'client-filter-signal',
    'hist-ap', 'hist-hours',
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
function syncOptions(id, values, allLabel) {
  const inst = selects[id];
  const current = inst.getValue();
  const unique = [...new Set(values)].filter(Boolean).sort();

  inst.clearOptions();
  inst.addOption({ value: '', text: allLabel });
  for (const v of unique) inst.addOption({ value: v, text: v });
  inst.refreshOptions(false);
  inst.setValue(unique.includes(current) ? current : '', true);
}

function globalVendor() {
  return $('global-filter-vendor').value;
}

function filteredAps() {
  const vendor = globalVendor();
  const search = $('ap-filter-search').value.trim().toLowerCase();
  const site = $('ap-filter-site').value;
  const band = $('ap-filter-band').value;
  const rows = state.aps.filter((r) => {
    if (vendor && r.vendor !== vendor) return false;
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
  const vendor = globalVendor();
  const search = $('client-filter-search').value.trim().toLowerCase();
  const site = $('client-filter-site').value;
  const band = $('client-filter-band').value;
  const signal = $('client-filter-signal').value;
  const rows = state.clients.filter((r) => {
    if (vendor && r.vendor !== vendor) return false;
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

function renderOverview(o) {
  if (!o) return;
  $('card-clients').textContent = o.clients ?? '-';
  $('card-aps').textContent = o.aps ?? '-';
  $('card-lemah').textContent = o.lemah ?? 0;
  $('card-sangat-lemah').textContent = o.sangat_lemah ?? 0;
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

// Overview cards dihitung ulang di sisi client dari snapshot client-live
// yang sama dipakai tabel Client Live, supaya kartu "Client Aktif"/"AP
// Aktif"/"Sinyal Lemah" ikut ke-scope ke vendor yang dipilih. "Update
// Terakhir" tetap dari respons server karena tidak bergantung vendor.
function computeOverview(vendor) {
  const rows = vendor ? state.clients.filter((r) => r.vendor === vendor) : state.clients;
  const apNames = new Set(rows.map((r) => r.ap_name));
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
    lemah,
    sangat_lemah: sangatLemah,
  };
}

// Render ulang kartu + kedua tabel dari state + filter yang sedang aktif.
// Dipanggil tiap kali filter berubah ATAU data baru masuk lewat WS, supaya
// filter user tidak hilang ketika snapshot baru datang.
function applyFilters() {
  renderOverview(computeOverview(globalVendor()));
  renderApsTable(filteredAps());
  renderClientsTable(filteredClients());
}

function updateData(overview, aps, clients) {
  state.aps = aps;
  state.clients = clients;
  state.overview = overview;
  syncOptions('global-filter-vendor', [...aps.map((r) => r.vendor), ...clients.map((r) => r.vendor)], 'Semua Vendor');
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
  const rows = await fetch('/api/ap-list').then((r) => r.json());
  const inst = selects['hist-ap'];
  for (const r of rows) {
    inst.addOption({ value: r.ap_name, text: `${r.ap_name} (${r.site})` });
  }
  inst.refreshOptions(false);
}

// Format Date lokal (bukan UTC) ke bentuk yang diterima <input
// type="datetime-local">: "YYYY-MM-DDTHH:MM".
function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Preset "custom" di dropdown hist-hours menampilkan dua input tanggal.
// Saat pertama kali dipilih (input masih kosong), isi default 24 jam
// terakhir supaya chart tidak kosong sambil user menyesuaikan rentangnya.
function onHistPresetChange() {
  const isCustom = $('hist-hours').value === 'custom';
  $('hist-range').hidden = !isCustom;
  if (isCustom && (!$('hist-from').value || !$('hist-to').value)) {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    $('hist-from').value = toLocalInputValue(from);
    $('hist-to').value = toLocalInputValue(now);
  }
  loadHistory();
}

async function loadHistory() {
  const ap = $('hist-ap').value;
  const preset = $('hist-hours').value;
  const params = new URLSearchParams();
  if (preset === 'custom') {
    const from = $('hist-from').value;
    const to = $('hist-to').value;
    // Rentang belum lengkap (user baru isi salah satu) -- tunggu, jangan
    // fetch dulu supaya tidak nembak query dengan tanggal kosong.
    if (!from || !to) return;
    params.set('from', from);
    params.set('to', to);
  } else {
    params.set('hours', preset);
  }
  if (ap) params.set('ap', ap);
  const rows = await fetch(`/api/history?${params}`).then((r) => r.json());
  renderChart(rows);
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
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Avg RSSI (dBm)',
          data: avgRssi,
          borderColor: '#4f8cff',
          yAxisID: 'y',
          tension: 0.2,
        },
        {
          label: 'Client unik',
          data: clients,
          borderColor: '#33c17a',
          yAxisID: 'y1',
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { type: 'linear', position: 'left', title: { display: true, text: 'dBm' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'client' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

$('hist-ap').addEventListener('change', loadHistory);
$('hist-hours').addEventListener('change', onHistPresetChange);
$('hist-from').addEventListener('change', loadHistory);
$('hist-to').addEventListener('change', loadHistory);

$('global-filter-vendor').addEventListener('change', applyFilters);
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

initSelects();
initSortableHeaders();
loadInitial();
loadApList().then(loadHistory);
connectWs();
