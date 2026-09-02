<?php
declare(strict_types=1);

/**
 * Kredensial diisi lewat .env (salin dari .env.example), bukan di file ini.
 * File ini murni merakit array config dari environment — aman untuk
 * dilihat/disalin karena tidak berisi rahasia literal.
 */

require __DIR__ . '/src/EnvLoader.php';

$env = EnvLoader::load(__DIR__ . '/.env');

$e = fn(string $key, ?string $default = null): ?string => $env[$key] ?? $default;

return [

    'timezone' => $e('TIMEZONE', 'Asia/Jakarta'),

    'db' => [
        'analytics_dsn'  => $e('DB_ANALYTICS_DSN', 'mysql:host=localhost;dbname=wifi_analytics;charset=utf8mb4'),
        'radius_dsn'     => $e('DB_RADIUS_DSN', 'mysql:host=localhost;dbname=radiusdb;charset=utf8mb4'),
        // Kredensial terpisah karena wifi_analytics dan radiusdb bisa saja
        // di server MySQL berbeda (mis. wifi_analytics masih lokal untuk
        // testing, radiusdb sudah ke server produksi). DB_USER/DB_PASS
        // dipakai sebagai fallback kalau keduanya memang satu server.
        'analytics_user' => $e('DB_ANALYTICS_USER', $e('DB_USER', 'wifipoller')),
        'analytics_pass' => $e('DB_ANALYTICS_PASS', $e('DB_PASS', '')),
        'radius_user'    => $e('DB_RADIUS_USER', $e('DB_USER', 'wifipoller')),
        'radius_pass'    => $e('DB_RADIUS_PASS', $e('DB_PASS', '')),
    ],

    'rssi_threshold_lemah'        => (int)$e('RSSI_THRESHOLD_LEMAH', '-72'),
    'rssi_threshold_sangat_lemah' => (int)$e('RSSI_THRESHOLD_SANGAT_LEMAH', '-80'),

    'retensi_raw_hari'    => (int)$e('RETENSI_RAW_HARI', '14'),
    'retensi_hourly_hari' => (int)$e('RETENSI_HOURLY_HARI', '730'),

    'lock_file'  => $e('LOCK_FILE', '/var/lib/wifi-poller/poller.lock'),
    'token_dir'  => $e('TOKEN_DIR', '/var/lib/wifi-poller'),

    'controllers' => [
        [
            'enabled'       => EnvLoader::bool($env, 'OMADA_ENABLED'),
            'type'          => 'omada',
            'label'         => $e('OMADA_LABEL', 'omada-kantor-pusat'),
            'base_url'      => $e('OMADA_BASE_URL'),
            'omadac_id'     => $e('OMADA_OMADAC_ID'),
            'client_id'     => $e('OMADA_CLIENT_ID'),
            'client_secret' => $e('OMADA_CLIENT_SECRET'),
            'site_ids'      => EnvLoader::list($env, 'OMADA_SITE_IDS'),
            'verify_ssl'    => EnvLoader::bool($env, 'OMADA_VERIFY_SSL'),
        ],
        [
            'enabled'    => EnvLoader::bool($env, 'RUIJIE_ENABLED'),
            'type'       => 'ruijie',
            'label'      => $e('RUIJIE_LABEL', 'ruijie-cloud'),
            'base_url'   => $e('RUIJIE_BASE_URL', 'https://cloud-as.ruijienetworks.com'),
            'app_id'     => $e('RUIJIE_APP_ID'),
            'app_secret' => $e('RUIJIE_APP_SECRET'),
            'group_ids'  => EnvLoader::list($env, 'RUIJIE_GROUP_IDS'),
            'verify_ssl' => EnvLoader::bool($env, 'RUIJIE_VERIFY_SSL', true),
        ],
        [
            'enabled'    => EnvLoader::bool($env, 'UNIFI_ENABLED'),
            'type'       => 'unifi',
            'label'      => $e('UNIFI_LABEL', 'unifi-kantor-pusat'),
            'base_url'   => $e('UNIFI_BASE_URL'),
            'username'   => $e('UNIFI_USERNAME'),
            'password'   => $e('UNIFI_PASSWORD'),
            // Kosongkan untuk site "default". Isi comma-separated (site
            // short-name, bukan display name) untuk multi-site.
            'site_ids'   => EnvLoader::list($env, 'UNIFI_SITE_IDS'),
            'verify_ssl' => EnvLoader::bool($env, 'UNIFI_VERIFY_SSL'),
        ],
    ],
];
