<?php
declare(strict_types=1);

/**
 * Agregasi wifi_samples → wifi_hourly.
 * Dipanggil cron tiap jam.
 *
 * Kenapa perlu: raw sample hanya disimpan 14 hari. Keputusan penambahan
 * AP butuh tren beberapa bulan. Rollup ini yang bertahan 2 tahun.
 *
 *   php rollup.php                              3 jam terakhir (cron)
 *   php rollup.php --from="2026-09-24 06:00"    isi ulang sejak jam itu
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

$opts = getopt('', ['from:']);
$from = isset($opts['from']) ? strtotime($opts['from']) : strtotime('-3 hour');
if ($from === false) {
    fwrite(STDERR, "Format --from tidak valid, contoh: --from=\"2026-09-24 06:00\"\n");
    exit(1);
}

/*
 * Dua tahap: per client dulu, baru per AP. COUNT(DISTINCT client_mac)
 * dalam satu GROUP BY memaksa MySQL filesort ke tmpdir (/tmp = tmpfs
 * 3,7 GB) dan gagal "No space left on device" begitu client ~12 ribu.
 * GROUP BY biasa tanpa DISTINCT memakai temp table TempTable di RAM.
 *
 * Satu query per jam supaya ukuran temp table tetap kecil walau --from
 * mundur jauh. Jam berjalan dilewati karena datanya belum lengkap.
 * REPLACE INTO membuat script ini idempoten — aman dijalankan ulang.
 */
$sql = "
REPLACE INTO wifi_hourly
  (hour_ts, vendor, controller, site, ap_name, band, samples, clients_unik,
   avg_rssi, min_rssi, pct_lemah, pct_sangat_lemah)
SELECT
  :hour, vendor, controller, site, ap_name, band,
  SUM(n)                                        AS samples,
  COUNT(*)                                      AS clients_unik,
  ROUND(SUM(rssi_sum) / SUM(n), 1)              AS avg_rssi,
  MIN(rssi_min)                                 AS min_rssi,
  ROUND(100.0 * SUM(n_lemah) / SUM(n), 1)       AS pct_lemah,
  ROUND(100.0 * SUM(n_sangat) / SUM(n), 1)      AS pct_sangat_lemah
FROM (
  SELECT vendor,
         COALESCE(controller, '') AS controller,
         site, ap_name,
         COALESCE(band, '')       AS band,
         client_mac,
         COUNT(*)                 AS n,
         SUM(rssi)                AS rssi_sum,
         MIN(rssi)                AS rssi_min,
         SUM(rssi < :lemah)       AS n_lemah,
         SUM(rssi < :sangat)      AS n_sangat
  FROM wifi_samples
  WHERE ts >= :start AND ts < :end AND rssi IS NOT NULL
  GROUP BY vendor, COALESCE(controller, ''), site, ap_name, COALESCE(band, ''), client_mac
) per_client
GROUP BY vendor, controller, site, ap_name, band
";
$stmt = $pdo->prepare($sql);

$jam     = strtotime(date('Y-m-d H:00:00', $from));
$jamIni  = strtotime(date('Y-m-d H:00:00'));
$total   = 0;
for (; $jam < $jamIni; $jam += 3600) {
    $start = date('Y-m-d H:00:00', $jam);
    $stmt->execute([
        ':hour'   => $start,
        ':start'  => $start,
        ':end'    => date('Y-m-d H:00:00', $jam + 3600),
        ':lemah'  => $lemah,
        ':sangat' => $sangatLemah,
    ]);
    $total += $stmt->rowCount();
}

echo date('Y-m-d H:i:s') . "  rollup: $total baris\n";
