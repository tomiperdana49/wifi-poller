<?php
declare(strict_types=1);

/**
 * Simulasi END-TO-END lokal, TANPA API Omada/Ruijie asli (belum ada
 * kredensial — lihat Bagian 1 tutorial). Ini menggantikan fetchClients()
 * dengan data buatan lalu mendorongnya lewat pipeline nyata: resolusi
 * username via UsernameResolver, insert via SampleStore.
 *
 * Jalankan: php test_local.php
 */

require __DIR__ . '/src/ClientSample.php';
require __DIR__ . '/src/MacUtil.php';
require __DIR__ . '/src/UsernameResolver.php';
require __DIR__ . '/src/SampleStore.php';

$cfg = require __DIR__ . '/config.php';
date_default_timezone_set($cfg['timezone']);
$ts  = date('Y-m-d H:i:s');

function logLine(string $msg): void { fwrite(STDOUT, date('Y-m-d H:i:s') . "  $msg\n"); }

// Data buatan meniru apa yang OmadaPoller/RuijiePoller akan hasilkan
// setelah parsing response API + normalisasi MAC via MacUtil::toRadacct().
$semua = [
    new ClientSample(
        vendor: 'omada', site: 'kantor-pusat', apName: 'AP-Lt2-Timur',
        apMac: '22-EB-B6-A6-DD-85', ssid: 'NusanetEnterprise',
        clientMac: '8E-E3-CA-FD-6C-8B', rssi: -68, band: '5G',
        channel: 44, snr: 30, txRate: 866, rxRate: 866,
    ),
    new ClientSample(
        vendor: 'omada', site: 'kantor-pusat', apName: 'AP-Lt2-Barat',
        apMac: '22-EB-B6-A6-DD-86', ssid: 'NusanetEnterprise',
        clientMac: 'AA-11-22-33-44-55', rssi: -81, band: '2.4G',
        channel: 6, snr: 15, txRate: 72, rxRate: 72,
    ),
    // MAC ini sengaja tidak ada di radacct -> harus resolve ke username NULL
    new ClientSample(
        vendor: 'ruijie', site: 'kantor-pusat', apName: 'AP-Lt3-Gudang',
        apMac: '22-EB-B6-A6-DD-87', ssid: 'NusanetEnterprise',
        clientMac: 'CC-DD-EE-11-22-33', rssi: -85, band: '2.4G',
        channel: 11, snr: 10, txRate: 54, rxRate: 54,
    ),
];

logLine('Data simulasi: ' . count($semua) . ' client (menggantikan fetchClients() API asli)');

$radiusPdo = new PDO(
    $cfg['db']['radius_dsn'], $cfg['db']['radius_user'], $cfg['db']['radius_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
);

$resolver = new UsernameResolver($radiusPdo);
$macs     = array_map(fn($s) => $s->clientMac, $semua);
$map      = $resolver->resolveBatch($macs, $ts);

foreach ($semua as $s) {
    $s->username = $map[$s->clientMac] ?? null;
}

printf("%-20s %-18s %-14s %6s\n", 'AP', 'CLIENT MAC', 'USERNAME', 'RSSI');
foreach ($semua as $s) {
    printf("%-20s %-18s %-14s %6d%s\n",
        $s->apName, $s->clientMac, $s->username ?? '(NULL)', $s->rssi,
        MacUtil::isRandom($s->clientMac) ? '  [MAC acak]' : ''
    );
}

$ketemu = count(array_filter($semua, fn($s) => $s->username !== null));
logLine(sprintf('username ter-resolve: %d/%d', $ketemu, count($semua)));

$pdo = new PDO(
    $cfg['db']['analytics_dsn'], $cfg['db']['analytics_user'], $cfg['db']['analytics_pass'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$n = (new SampleStore($pdo))->insertBatch($semua, $ts);
logLine("Tersimpan $n baris ke wifi_samples");
