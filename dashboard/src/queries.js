'use strict';

const pool = require('./db');

const LEMAH = Number(process.env.RSSI_THRESHOLD_LEMAH || -72);
const SANGAT_LEMAH = Number(process.env.RSSI_THRESHOLD_SANGAT_LEMAH || -80);

async function latestTs() {
  const [rows] = await pool.query('SELECT MAX(ts) AS ts FROM wifi_samples');
  return rows[0].ts;
}

// Snapshot client yang terhubung saat siklus poll terakhir. poller.php
// menulis ulang seluruh client aktif tiap jalan (bukan delta), jadi
// "ts = MAX(ts)" itu representasi kondisi live.
async function liveClients() {
  const [rows] = await pool.query(
    `SELECT vendor, controller, site, ap_name, ap_mac, ssid, band, channel,
            client_mac, username, rssi, snr, tx_rate, rx_rate, ts
     FROM wifi_samples
     WHERE ts = (SELECT MAX(ts) FROM wifi_samples)
     ORDER BY rssi ASC`
  );
  return rows;
}

async function apSummary() {
  const [rows] = await pool.query(
    `SELECT vendor, controller, site, ap_name, band,
            COUNT(*)               AS clients,
            ROUND(AVG(rssi), 1)    AS avg_rssi,
            MIN(rssi)              AS min_rssi,
            SUM(rssi < ?)          AS lemah,
            SUM(rssi < ?)          AS sangat_lemah
     FROM wifi_samples
     WHERE ts = (SELECT MAX(ts) FROM wifi_samples)
     GROUP BY vendor, controller, site, ap_name, band
     ORDER BY site, ap_name`,
    [LEMAH, SANGAT_LEMAH]
  );
  return rows;
}

async function overview() {
  const [[row]] = await pool.query(
    `SELECT
        (SELECT MAX(ts) FROM wifi_samples) AS ts,
        COUNT(DISTINCT client_mac)         AS clients,
        COUNT(DISTINCT ap_name)            AS aps,
        SUM(rssi < ?)                      AS lemah,
        SUM(rssi < ?)                      AS sangat_lemah
     FROM wifi_samples
     WHERE ts = (SELECT MAX(ts) FROM wifi_samples)`,
    [LEMAH, SANGAT_LEMAH]
  );
  return row;
}

// <input type="datetime-local"> mengirim "2026-09-10T08:00" -- MySQL/MariaDB
// mengharapkan literal DATETIME dengan spasi, bukan 'T'.
function normalizeDatetime(s) {
  return String(s).replace('T', ' ');
}

async function history({ site, apName, vendor, controller, hours, from, to }) {
  const params = [];
  const conditions = [];
  // Rentang kustom (from+to) menang kalau keduanya diisi; kalau cuma
  // salah satu atau tidak ada, fallback ke preset "N jam terakhir".
  if (from && to) {
    conditions.push('hour_ts >= ?', 'hour_ts <= ?');
    params.push(normalizeDatetime(from), normalizeDatetime(to));
  } else {
    conditions.push('hour_ts >= NOW() - INTERVAL ? HOUR');
    params.push(Number(hours) > 0 ? Number(hours) : 24);
  }
  if (site) {
    conditions.push('site = ?');
    params.push(site);
  }
  if (apName) {
    conditions.push('ap_name = ?');
    params.push(apName);
  }
  if (vendor) {
    conditions.push('vendor = ?');
    params.push(vendor);
  }
  if (controller) {
    conditions.push('controller = ?');
    params.push(controller);
  }
  const sql = `SELECT hour_ts, vendor, controller, site, ap_name, band, samples, clients_unik,
                      avg_rssi, min_rssi, pct_lemah, pct_sangat_lemah
               FROM wifi_hourly
               WHERE ${conditions.join(' AND ')}
               ORDER BY hour_ts`;
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Ranking AP yang "sering" sinyal sangat lemah dalam suatu periode --
// beda dari apSummary() yang cuma snapshot siklus poll terakhir. Dipakai
// buat cari AP yang perlu ditambah / dipindah, bukan cuma yang lagi jelek
// saat ini. jam_bermasalah = berapa jam (dari jam yang punya data) yang
// punya >0% client dengan sinyal sangat lemah; avg_pct_sangat_lemah
// dibobot per jumlah sample tiap jam supaya jam sepi tidak menyamai
// bobotnya dengan jam ramai.
async function problemAps({ hours, from, to, site, band, vendor, controller }) {
  const params = [];
  const conditions = [];
  if (from && to) {
    conditions.push('hour_ts >= ?', 'hour_ts <= ?');
    params.push(normalizeDatetime(from), normalizeDatetime(to));
  } else {
    conditions.push('hour_ts >= NOW() - INTERVAL ? HOUR');
    params.push(Number(hours) > 0 ? Number(hours) : 72);
  }
  if (site) {
    conditions.push('site = ?');
    params.push(site);
  }
  if (band) {
    conditions.push('band = ?');
    params.push(band);
  }
  if (vendor) {
    conditions.push('vendor = ?');
    params.push(vendor);
  }
  if (controller) {
    conditions.push('controller = ?');
    params.push(controller);
  }
  const sql = `SELECT vendor, controller, site, ap_name, band,
                      COUNT(*)                                            AS jam_terpantau,
                      SUM(pct_sangat_lemah > 0)                           AS jam_bermasalah,
                      ROUND(SUM(pct_sangat_lemah * samples) / NULLIF(SUM(samples), 0), 1)
                                                                           AS avg_pct_sangat_lemah,
                      MAX(pct_sangat_lemah)                               AS max_pct_sangat_lemah,
                      SUM(samples)                                        AS total_samples
               FROM wifi_hourly
               WHERE ${conditions.join(' AND ')}
               GROUP BY vendor, controller, site, ap_name, band
               HAVING jam_bermasalah > 0
               ORDER BY avg_pct_sangat_lemah DESC, jam_bermasalah DESC`;
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({
    ...r,
    pct_jam_bermasalah: r.jam_terpantau
      ? Math.round((r.jam_bermasalah / r.jam_terpantau) * 1000) / 10
      : 0,
  }));
}

async function apList() {
  const [rows] = await pool.query(
    `SELECT DISTINCT vendor, controller, site, ap_name FROM wifi_hourly ORDER BY site, ap_name`
  );
  return rows;
}

// Data dianggap "terlambat" kalau batch terakhir lebih tua dari ini. Cron
// jalan tiap 60 detik dan satu siklus ~30 detik, jadi 3 menit = sudah
// ~2 siklus terlewat.
const STALE_SECONDS = Number(process.env.DATA_STALE_SECONDS || 180);

// Umur data dihitung di MySQL (NOW() vs MAX(ts)), bukan di Node/browser --
// ts ditulis poller dalam waktu lokal server, jadi membandingkannya dengan
// jam DB yang sama menghindari salah hitung akibat beda timezone.
async function dataAge() {
  const [[row]] = await pool.query(
    `SELECT MAX(ts) AS ts, TIMESTAMPDIFF(SECOND, MAX(ts), NOW()) AS age_s
     FROM wifi_samples`
  );
  return { ts: row.ts, age_s: row.age_s == null ? null : Number(row.age_s) };
}

// Tabel health (poller/sql/001_poller_health.sql) opsional: sebelum
// migration dijalankan, dashboard tetap jalan dan panel Status Poller
// menampilkan petunjuk setup alih-alih error.
function isMissingTable(e) {
  return e && e.code === 'ER_NO_SUCH_TABLE';
}

async function health() {
  const data = await dataAge();
  const base = {
    data_ts: data.ts,
    data_age_s: data.age_s,
    stale_after_s: STALE_SECONDS,
    stale: data.age_s == null || data.age_s > STALE_SECONDS,
  };

  try {
    const [[latest], [stats], [series], [lastOk], [cycle], [cycleStats]] = await Promise.all([
      // Run terakhir tiap controller (dalam 7 hari -- controller yang sudah
      // dicabut dari config lama-lama hilang sendiri dari panel).
      pool.query(
        `SELECT r.label, r.type, r.ok, r.clients, r.duration_ms, r.error, r.ts,
                TIMESTAMPDIFF(SECOND, r.ts, NOW()) AS age_s
         FROM poller_controller_runs r
         JOIN (SELECT label, MAX(ts) AS ts FROM poller_controller_runs
               WHERE ts >= NOW() - INTERVAL 7 DAY GROUP BY label) m
           ON m.label = r.label AND m.ts = r.ts
         ORDER BY r.type, r.label`
      ),
      pool.query(
        `SELECT label, COUNT(*) AS runs, SUM(ok = 0) AS fails,
                ROUND(AVG(duration_ms)) AS avg_ms, MAX(duration_ms) AS max_ms
         FROM poller_controller_runs
         WHERE ts >= NOW() - INTERVAL 1 DAY
         GROUP BY label`
      ),
      // Sparkline 24 jam: rata-rata jumlah client per 30 menit. Run gagal
      // ikut dihitung sebagai 0 supaya gangguan kelihatan sebagai lembah.
      pool.query(
        `SELECT label,
                FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts) / 1800) * 1800) AS bucket,
                ROUND(AVG(clients)) AS clients, SUM(ok = 0) AS fails
         FROM poller_controller_runs
         WHERE ts >= NOW() - INTERVAL 1 DAY
         GROUP BY label, bucket
         ORDER BY bucket`
      ),
      pool.query(
        `SELECT label, MAX(ts) AS ts, TIMESTAMPDIFF(SECOND, MAX(ts), NOW()) AS age_s
         FROM poller_controller_runs
         WHERE ok = 1 AND ts >= NOW() - INTERVAL 7 DAY
         GROUP BY label`
      ),
      pool.query(
        `SELECT ts, status, duration_ms, controllers_ok, controllers_total,
                clients, resolved, error, TIMESTAMPDIFF(SECOND, ts, NOW()) AS age_s
         FROM poller_cycles ORDER BY ts DESC LIMIT 1`
      ),
      pool.query(
        `SELECT COUNT(*) AS cycles, SUM(status <> 'ok') AS bad_cycles,
                ROUND(AVG(duration_ms)) AS avg_ms, MAX(duration_ms) AS max_ms,
                ROUND(100 * SUM(resolved) / NULLIF(SUM(clients), 0), 1) AS pct_resolved
         FROM poller_cycles
         WHERE ts >= NOW() - INTERVAL 1 DAY`
      ),
    ]);
    const byLabel = (rows) => new Map(rows.map((r) => [r.label, r]));
    const statsBy = byLabel(stats);
    const okBy = byLabel(lastOk);
    const seriesBy = new Map();
    for (const s of series) {
      if (!seriesBy.has(s.label)) seriesBy.set(s.label, []);
      seriesBy.get(s.label).push({ t: s.bucket, clients: Number(s.clients), fails: Number(s.fails) });
    }

    const controllers = latest.map((r) => {
      const st = statsBy.get(r.label) || {};
      const lastOkRow = okBy.get(r.label);
      const age = Number(r.age_s);
      let status = r.ok ? 'ok' : 'error';
      if (age > STALE_SECONDS) status = 'stale';
      return {
        label: r.label,
        type: r.type,
        status,
        clients: Number(r.clients),
        duration_ms: Number(r.duration_ms),
        error: r.error,
        ts: r.ts,
        age_s: age,
        last_ok_ts: lastOkRow ? lastOkRow.ts : null,
        last_ok_age_s: lastOkRow ? Number(lastOkRow.age_s) : null,
        runs_24h: Number(st.runs || 0),
        fails_24h: Number(st.fails || 0),
        avg_ms_24h: st.avg_ms == null ? null : Number(st.avg_ms),
        max_ms_24h: st.max_ms == null ? null : Number(st.max_ms),
        series: seriesBy.get(r.label) || [],
      };
    });

    const cs = cycleStats[0] || {};
    return {
      ...base,
      available: true,
      controllers,
      cycle: cycle[0] || null,
      cycle_24h: {
        cycles: Number(cs.cycles || 0),
        bad_cycles: Number(cs.bad_cycles || 0),
        avg_ms: cs.avg_ms == null ? null : Number(cs.avg_ms),
        max_ms: cs.max_ms == null ? null : Number(cs.max_ms),
        pct_resolved: cs.pct_resolved == null ? null : Number(cs.pct_resolved),
      },
    };
  } catch (e) {
    if (isMissingTable(e)) return { ...base, available: false, controllers: [] };
    throw e;
  }
}

module.exports = {
  latestTs,
  dataAge,
  health,
  STALE_SECONDS,
  liveClients,
  apSummary,
  overview,
  history,
  problemAps,
  apList,
  LEMAH,
  SANGAT_LEMAH,
};
