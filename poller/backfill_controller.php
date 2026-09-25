<?php
declare(strict_types=1);

/**
 * Isi kolom controller untuk data yang ditulis sebelum migration
 * sql/002_controller_column.sql. Dijalankan manual, aman diulang.
 *
 * Pemetaan diambil dari sample 24 jam terakhir yang sudah berlabel:
 * (vendor, site) -> controller, hanya kalau site itu cuma muncul di SATU
 * controller. Site yang ambigu atau belum muncul lagi sejak deploy
 * dibiarkan kosong -- jalankan ulang besok untuk menangkap site yang
 * baru aktif lagi.
 *
 *   php backfill_controller.php            backfill
 *   php backfill_controller.php --dry-run  cuma cetak pemetaan
 */

$cfg = require __DIR__ . '/config.php';
date_default_timezone_set($cfg['timezone']);
$dryRun = in_array('--dry-run', $argv, true);

$pdo = new PDO(
    $cfg['db']['analytics_dsn'],
    $cfg['db']['analytics_user'],
    $cfg['db']['analytics_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
     PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
);

function logLine(string $msg): void
{
    fwrite(STDOUT, date('Y-m-d H:i:s') . "  $msg\n");
}

$rows = $pdo->query(
    "SELECT vendor, site, MIN(controller) AS controller
     FROM wifi_samples
     WHERE ts >= NOW() - INTERVAL 1 DAY AND controller IS NOT NULL
     GROUP BY vendor, site
     HAVING COUNT(DISTINCT controller) = 1"
)->fetchAll();

// controller => vendor => [site, ...]
$map = [];
foreach ($rows as $r) {
    $map[$r['controller']][$r['vendor']][] = $r['site'];
}
foreach ($map as $ctrl => $byVendor) {
    foreach ($byVendor as $vendor => $sites) {
        logLine(sprintf('%-24s %-7s %4d site', $ctrl, $vendor, count($sites)));
    }
}
if (!$map) {
    logLine('Belum ada sample berlabel controller. Tunggu poller jalan dulu.');
    exit(1);
}
if ($dryRun) {
    exit(0);
}

/*
 * wifi_samples: cukup beberapa jam terakhir -- rollup.php mengagregasi
 * ulang 3 jam ke belakang, jadi sample di rentang itu yang masih NULL
 * akan jadi baris wifi_hourly controller='' lagi. Data lebih tua dari itu
 * tidak dibaca dashboard (hanya snapshot terakhir). Per 15 menit supaya
 * transaksi pendek dan insert poller tidak tertahan lock.
 */
$ctrlCase = [];
foreach ($map as $ctrl => $byVendor) {
    foreach ($byVendor as $vendor => $sites) {
        foreach ($sites as $site) {
            $ctrlCase[] = [$vendor, $site, $ctrl];
        }
    }
}

// Tabel pemetaan di-inline sebagai derived table (user wifipoller tidak
// punya hak CREATE TEMPORARY TABLE).
function mapJoin(array $chunk, array &$params): string
{
    $parts = [];
    foreach ($chunk as [$vendor, $site, $ctrl]) {
        $parts[]  = 'SELECT ? AS vendor, ? AS site, ? AS controller';
        array_push($params, $vendor, $site, $ctrl);
    }
    return '(' . implode(' UNION ALL ', $parts) . ')';
}

$start = strtotime(date('Y-m-d H:00:00', strtotime('-4 hour')));
$end   = time();
$nSamples = 0;
for ($t = $start; $t < $end; $t += 900) {
    foreach (array_chunk($ctrlCase, 500) as $chunk) {
        $p   = [];
        $sub = mapJoin($chunk, $p);
        $sql = "UPDATE wifi_samples s JOIN $sub m
                  ON m.vendor = s.vendor AND m.site = s.site
                SET s.controller = m.controller
                WHERE s.ts >= ? AND s.ts < ? AND s.controller IS NULL";
        $p[] = date('Y-m-d H:i:s', $t);
        $p[] = date('Y-m-d H:i:s', $t + 900);
        $st  = $pdo->prepare($sql);
        $st->execute($p);
        $nSamples += $st->rowCount();
    }
}
logLine("wifi_samples (4 jam terakhir): $nSamples baris");

/*
 * wifi_hourly: semua baris ''. UPDATE IGNORE -- kalau jam itu sudah punya
 * baris berlabel (rollup jalan di tengah transisi), baris '' dilewati dan
 * dihapus di bawah supaya tidak terhitung dua kali.
 */
$nHourly = 0;
foreach (array_chunk($ctrlCase, 500) as $chunk) {
    $p   = [];
    $sub = mapJoin($chunk, $p);
    $st  = $pdo->prepare(
        "UPDATE IGNORE wifi_hourly h JOIN $sub m
           ON m.vendor = h.vendor AND m.site = h.site
         SET h.controller = m.controller
         WHERE h.controller = ''"
    );
    $st->execute($p);
    $nHourly += $st->rowCount();
}
logLine("wifi_hourly: $nHourly baris");

$st = $pdo->prepare(
    "DELETE h FROM wifi_hourly h
     JOIN wifi_hourly l
       ON l.hour_ts = h.hour_ts AND l.vendor = h.vendor AND l.site = h.site
      AND l.ap_name = h.ap_name AND l.band = h.band AND l.controller <> ''
     WHERE h.controller = ''"
);
$st->execute();
logLine('wifi_hourly duplikat transisi dihapus: ' . $st->rowCount());

$sisa = $pdo->query("SELECT COUNT(*) FROM wifi_hourly WHERE controller = ''")->fetchColumn();
logLine("wifi_hourly masih tanpa controller: $sisa baris");
