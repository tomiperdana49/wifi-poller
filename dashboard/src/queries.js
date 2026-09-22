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
    `SELECT vendor, site, ap_name, ap_mac, ssid, band, channel,
            client_mac, username, rssi, snr, tx_rate, rx_rate, ts
     FROM wifi_samples
     WHERE ts = (SELECT MAX(ts) FROM wifi_samples)
     ORDER BY rssi ASC`
  );
  return rows;
}

async function apSummary() {
  const [rows] = await pool.query(
    `SELECT vendor, site, ap_name, band,
            COUNT(*)               AS clients,
            ROUND(AVG(rssi), 1)    AS avg_rssi,
            MIN(rssi)              AS min_rssi,
            SUM(rssi < ?)          AS lemah,
            SUM(rssi < ?)          AS sangat_lemah
     FROM wifi_samples
     WHERE ts = (SELECT MAX(ts) FROM wifi_samples)
     GROUP BY vendor, site, ap_name, band
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

async function history({ site, apName, hours, from, to }) {
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
  const sql = `SELECT hour_ts, vendor, site, ap_name, band, samples, clients_unik,
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
async function problemAps({ hours, from, to, site, band, vendor }) {
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
  const sql = `SELECT vendor, site, ap_name, band,
                      COUNT(*)                                            AS jam_terpantau,
                      SUM(pct_sangat_lemah > 0)                           AS jam_bermasalah,
                      ROUND(SUM(pct_sangat_lemah * samples) / NULLIF(SUM(samples), 0), 1)
                                                                           AS avg_pct_sangat_lemah,
                      MAX(pct_sangat_lemah)                               AS max_pct_sangat_lemah,
                      SUM(samples)                                        AS total_samples
               FROM wifi_hourly
               WHERE ${conditions.join(' AND ')}
               GROUP BY vendor, site, ap_name, band
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
    `SELECT DISTINCT site, ap_name FROM wifi_hourly ORDER BY site, ap_name`
  );
  return rows;
}

module.exports = {
  latestTs,
  liveClients,
  apSummary,
  overview,
  history,
  problemAps,
  apList,
  LEMAH,
  SANGAT_LEMAH,
};
