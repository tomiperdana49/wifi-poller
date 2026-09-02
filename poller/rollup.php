<?php
declare(strict_types=1);

/**
 * Agregasi wifi_samples → wifi_hourly.
 * Dipanggil cron tiap jam.
 *
 * Kenapa perlu: raw sample hanya disimpan 14 hari. Keputusan penambahan
 * AP butuh tren beberapa bulan. Rollup ini yang bertahan 2 tahun.
 */

$cfg = require __DIR__ . '/config.php';
date_default_timezone_set($cfg['timezone']);

$pdo = new PDO(
    $cfg['db']['analytics_dsn'],
    $cfg['db']['analytics_user'],
    $cfg['db']['analytics_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

$lemah       = (int)$cfg['rssi_threshold_lemah'];
$sangatLemah = (int)$cfg['rssi_threshold_sangat_lemah'];

/*
 * Proses jam yang sudah lewat (bukan jam berjalan, karena datanya
 * belum lengkap). REPLACE INTO membuat script ini idempoten — aman
 * dijalankan ulang untuk jam yang sama.
 */
$sql = "
REPLACE INTO wifi_hourly
  (hour_ts, vendor, site, ap_name, band, samples, clients_unik,
   avg_rssi, min_rssi, pct_lemah, pct_sangat_lemah)
SELECT
  DATE_FORMAT(ts, '%Y-%m-%d %H:00:00')            AS hour_ts,
  vendor,
  site,
  ap_name,
  COALESCE(band, '')                              AS band,
  COUNT(*)                                        AS samples,
  COUNT(DISTINCT client_mac)                      AS clients_unik,
  ROUND(AVG(rssi), 1)                             AS avg_rssi,
  MIN(rssi)                                       AS min_rssi,
  ROUND(100.0 * SUM(rssi < :lemah) / COUNT(*), 1) AS pct_lemah,
  ROUND(100.0 * SUM(rssi < :sangat) / COUNT(*), 1) AS pct_sangat_lemah
FROM wifi_samples
WHERE ts >= DATE_FORMAT(NOW() - INTERVAL 3 HOUR, '%Y-%m-%d %H:00:00')
  AND ts <  DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00')
  AND rssi IS NOT NULL
GROUP BY hour_ts, vendor, site, ap_name, COALESCE(band, '')
";

$stmt = $pdo->prepare($sql);
$stmt->execute([':lemah' => $lemah, ':sangat' => $sangatLemah]);

echo date('Y-m-d H:i:s') . '  rollup: ' . $stmt->rowCount() . " baris\n";
