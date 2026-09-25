<?php
declare(strict_types=1);

/**
 * Entry point poller. Dipanggil cron tiap menit.
 *
 * Penggunaan:
 *   php poller.php                    normal
 *   php poller.php --dry-run          ambil data, cetak, jangan simpan
 *   php poller.php --dry-run --debug  plus response JSON mentah
 *
 * SELALU jalankan --dry-run dulu setelah mengisi config, untuk
 * memverifikasi format MAC dan mapping field sebelum menulis ke database.
 */

require __DIR__ . '/src/ClientSample.php';
require __DIR__ . '/src/ControllerPoller.php';
require __DIR__ . '/src/MacUtil.php';
require __DIR__ . '/src/OmadaPoller.php';
require __DIR__ . '/src/RuijiePoller.php';
require __DIR__ . '/src/UnifiPoller.php';
require __DIR__ . '/src/UsernameResolver.php';
require __DIR__ . '/src/SampleStore.php';
require __DIR__ . '/src/HealthStore.php';

$cfg     = require __DIR__ . '/config.php';
date_default_timezone_set($cfg['timezone']);
$dryRun  = in_array('--dry-run', $argv, true);
$debug   = in_array('--debug', $argv, true);

function logLine(string $msg): void
{
    fwrite(STDOUT, date('Y-m-d H:i:s') . "  $msg\n");
}

/*
 * File lock: mencegah instance menumpuk kalau satu siklus butuh lebih
 * dari 60 detik. Tanpa ini, cron akan terus menambah proses sampai
 * server kewalahan.
 */
$lock = null;
if (!$dryRun) {
    $lock = fopen($cfg['lock_file'], 'c');
    if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
        logLine('SKIP: instance lain masih berjalan');
        exit(0);
    }
}

$ts   = date('Y-m-d H:i:s');
$mulai = microtime(true);

/*
 * Hasil siklus ini untuk panel "Status Poller" di dashboard. Diisi
 * sepanjang jalan, ditulis ke DB di shutdown function -- bukan di
 * finally -- karena exit() di tengah try (mis. "Tidak ada data") tidak
 * menjalankan finally, sedangkan shutdown function tetap jalan, termasuk
 * setelah FATAL. Gagal menulis health tidak boleh menggagalkan poller.
 */
$health = ['runs' => [], 'clients' => 0, 'resolved' => null, 'error' => null];

if (!$dryRun) {
    register_shutdown_function(function () use (&$health, $cfg, $ts, $mulai) {
        $fatal = error_get_last();
        if ($health['error'] === null && $fatal && in_array($fatal['type'], [E_ERROR, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
            $health['error'] = $fatal['message'];
        }

        $total = count($health['runs']);
        $ok    = count(array_filter($health['runs'], fn($r) => $r['ok']));
        $status = match (true) {
            $health['error'] !== null || $ok === 0 => 'error',
            $ok < $total                           => 'partial',
            default                                => 'ok',
        };

        try {
            $pdo = new PDO(
                $cfg['db']['analytics_dsn'],
                $cfg['db']['analytics_user'],
                $cfg['db']['analytics_pass'],
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            );
            (new HealthStore($pdo))->record($ts, $health['runs'], [
                'status'            => $status,
                'duration_ms'       => (int)round((microtime(true) - $mulai) * 1000),
                'controllers_ok'    => $ok,
                'controllers_total' => $total,
                'clients'           => $health['clients'],
                'resolved'          => $health['resolved'],
                'error'             => $health['error'],
            ]);
        } catch (Throwable $e) {
            logLine('WARN gagal simpan health: ' . $e->getMessage());
        }
    });
}

try {
    // ---- Ambil dari semua controller ----
    $semua = [];

    foreach ($cfg['controllers'] as $c) {
        if (empty($c['enabled'])) {
            continue;
        }

        $poller = match ($c['type']) {
            'omada'  => new OmadaPoller($c, $cfg['token_dir']),
            'ruijie' => new RuijiePoller($c, $cfg['token_dir']),
            'unifi'  => new UnifiPoller($c, $cfg['token_dir']),
            default  => throw new RuntimeException("Tipe tidak dikenal: {$c['type']}"),
        };

        if ($debug && ($poller instanceof RuijiePoller || $poller instanceof UnifiPoller)) {
            $poller->debug = true;
        }

        /*
         * Satu controller gagal tidak boleh menjatuhkan yang lain.
         * Log errornya, lanjut ke controller berikutnya.
         */
        $run = ['label' => $poller->label(), 'type' => $c['type'], 'ok' => false,
                'clients' => 0, 'duration_ms' => 0, 'error' => null];
        $t0  = microtime(true);
        try {
            $s = $poller->fetchClients();
            foreach ($s as $sample) {
                $sample->controller = $poller->label();
            }
            logLine(sprintf('%-24s %4d client', $poller->label(), count($s)));
            $semua = array_merge($semua, $s);
            $run['ok']      = true;
            $run['clients'] = count($s);
        } catch (Throwable $e) {
            logLine('ERROR ' . $poller->label() . ': ' . $e->getMessage());
            $run['error'] = $e->getMessage();
        }
        $run['duration_ms'] = (int)round((microtime(true) - $t0) * 1000);
        $health['runs'][]   = $run;
    }

    $health['clients'] = count($semua);

    if (!$semua) {
        logLine('Tidak ada data. Selesai.');
        exit(0);
    }

    // ---- Resolusi username dari radacct ----
    $radiusPdo = new PDO(
        $cfg['db']['radius_dsn'],
        $cfg['db']['radius_user'],
        $cfg['db']['radius_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
         PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );

    $resolver = new UsernameResolver($radiusPdo);
    $macs     = array_map(fn($s) => $s->clientMac, $semua);
    $map      = $resolver->resolveBatch($macs, $ts);

    foreach ($semua as $s) {
        $s->username = $map[$s->clientMac] ?? null;
    }

    $ketemu = count(array_filter($semua, fn($s) => $s->username !== null));
    $health['resolved'] = $ketemu;
    logLine(sprintf(
        'username ter-resolve: %d/%d (%.0f%%)',
        $ketemu, count($semua), 100 * $ketemu / count($semua)
    ));

    // ---- Dry run: cetak, jangan simpan ----
    if ($dryRun) {
        logLine('--- DRY RUN, tidak menulis ke database ---');
        printf("%-8s %-20s %-18s %-10s %6s %-14s\n",
               'VENDOR', 'AP', 'CLIENT MAC', 'USERNAME', 'RSSI', 'SSID');

        foreach (array_slice($semua, 0, 40) as $s) {
            printf("%-8s %-20s %-18s %-10s %6s %-14s%s\n",
                $s->vendor,
                mb_substr($s->apName, 0, 20),
                $s->clientMac,
                $s->username ?? '-',
                $s->rssi ?? '-',
                mb_substr($s->ssid ?? '-', 0, 14),
                MacUtil::isRandom($s->clientMac) ? '  [MAC acak]' : ''
            );
        }

        if (count($semua) > 40) {
            logLine('... dan ' . (count($semua) - 40) . ' lagi');
        }

        logLine('Periksa: format MAC cocok dengan callingstationid di radacct?');
        logLine('Periksa: RSSI berupa angka negatif (dBm), bukan 0-100?');
        exit(0);
    }

    // ---- Simpan ----
    $pdo = new PDO(
        $cfg['db']['analytics_dsn'],
        $cfg['db']['analytics_user'],
        $cfg['db']['analytics_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    $n = (new SampleStore($pdo))->insertBatch($semua, $ts);

    logLine(sprintf('Tersimpan %d baris dalam %.1f detik',
                    $n, microtime(true) - $mulai));

} catch (Throwable $e) {
    logLine('FATAL: ' . $e->getMessage());
    $health['error'] = $e->getMessage();
    exit(1);
} finally {
    if ($lock) {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
