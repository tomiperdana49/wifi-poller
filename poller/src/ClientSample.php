<?php
declare(strict_types=1);

/**
 * Satu snapshot kondisi satu client pada satu waktu.
 * Ini format netral — setiap poller vendor memetakan response API-nya
 * ke bentuk ini, sehingga sisa sistem tidak perlu tahu vendor apa.
 */
final class ClientSample
{
    public function __construct(
        public string  $vendor,      // 'omada' | 'ruijie'
        public string  $site,
        public string  $apName,
        public ?string $apMac,
        public ?string $ssid,
        public string  $clientMac,   // format radacct: AA-BB-CC-DD-EE-FF
        public ?int    $rssi,        // dBm, negatif
        public ?string $band,        // '2.4G' | '5G' | '6G'
        public ?int    $channel,
        public ?int    $snr,
        public ?int    $txRate,      // Mbps
        public ?int    $rxRate,
        public ?string $username = null,
        // Label controller asal (mis. 'ruijie-nusanet-jakarta'). Diisi
        // poller.php setelah fetch -- satu vendor bisa punya beberapa
        // controller, jadi vendor saja tidak cukup untuk memisahkan.
        public ?string $controller = null,
    ) {}
}
