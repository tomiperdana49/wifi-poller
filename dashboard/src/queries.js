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

async function history({ site, apName, hours }) {
  const params = [Number(hours) > 0 ? Number(hours) : 24];
  let sql = `SELECT hour_ts, vendor, site, ap_name, band, samples, clients_unik,
                    avg_rssi, min_rssi, pct_lemah, pct_sangat_lemah
             FROM wifi_hourly
             WHERE hour_ts >= NOW() - INTERVAL ? HOUR`;
  if (site) {
    sql += ' AND site = ?';
    params.push(site);
  }
  if (apName) {
    sql += ' AND ap_name = ?';
    params.push(apName);
  }
  sql += ' ORDER BY hour_ts';
  const [rows] = await pool.query(sql, params);
  return rows;
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
  apList,
  LEMAH,
  SANGAT_LEMAH,
};
