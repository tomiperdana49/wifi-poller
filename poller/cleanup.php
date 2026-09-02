<?php
declare(strict_types=1);

/**
 * Hapus data lama. Dipanggil cron harian.
 *
 * Tanpa ini, wifi_samples akan tumbuh ~8,6 juta baris per bulan
 * (200 client, polling 60 detik) dan akhirnya memenuhi disk.
 */

$cfg = require __DIR__ . '/config.php';
date_default_timezone_set($cfg['timezone']);

$pdo = new PDO(
    $cfg['db']['analytics_dsn'],
    $cfg['db']['analytics_user'],
    $cfg['db']['analytics_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

/*
 * DELETE bertahap 50.000 baris. DELETE massal sekaligus akan menahan
 * lock lama dan membengkakkan undo log InnoDB, yang bisa mengganggu
 * poller yang sedang menulis.
 */
function deleteBertahap(PDO $pdo, string $sql, array $params): int
{
    $total = 0;
    $stmt  = $pdo->prepare($sql);

    do {
        $stmt->execute($params);
        $n = $stmt->rowCount();
        $total += $n;
        if ($n > 0) {
            usleep(200_000);   // beri nafas ke server
        }
    } while ($n > 0);

    return $total;
}

$n1 = deleteBertahap(
    $pdo,
    "DELETE FROM wifi_samples
     WHERE ts < DATE_SUB(NOW(), INTERVAL :h DAY)
     LIMIT 50000",
    [':h' => (int)$cfg['retensi_raw_hari']]
);

$n2 = deleteBertahap(
    $pdo,
    "DELETE FROM wifi_hourly
     WHERE hour_ts < DATE_SUB(NOW(), INTERVAL :h DAY)
     LIMIT 50000",
    [':h' => (int)$cfg['retensi_hourly_hari']]
);

echo date('Y-m-d H:i:s')
   . "  cleanup: $n1 raw, $n2 hourly dihapus\n";
