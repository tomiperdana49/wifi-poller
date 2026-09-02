<?php
declare(strict_types=1);

/**
 * Omada Open API (controller v5.x).
 *
 * =====================================================================
 * PENTING — VERIFIKASI DULU
 * =====================================================================
 * Endpoint path dan nama field di bawah ini mengikuti pola Omada Open API
 * yang umum, tapi TP-Link mengubahnya antar versi controller. Sebelum
 * mengandalkan kode ini, buka dokumentasi API bawaan controller Anda:
 *
 *     Settings > Platform Integration > Open API > "API Docs"
 *
 * Lalu jalankan poller.php dengan --dry-run dan bandingkan output mentah
 * dengan mapping di normalise(). Perbaiki nama field kalau berbeda.
 *
 * Omada Cloud Essentials (tier gratis) TIDAK mendukung Open API sama
 * sekali. Anda butuh Software Controller self-hosted, OC200/OC300, atau
 * Omada Cloud tier Standard berbayar.
 * =====================================================================
 */
final class OmadaPoller extends BasePoller
{
    /** @var array<string,string> siteId => nama site, diisi oleh siteIds() */
    private array $siteNames = [];

    private function token(): string
    {
        $cached = $this->cachedToken();
        if ($cached !== null) {
            return $cached;
        }

        $url = rtrim($this->cfg['base_url'], '/')
             . '/openapi/authorize/token?grant_type=client_credentials';

        $res = $this->http('POST', $url, [], [
            'omadacId'     => $this->cfg['omadac_id'],
            'client_id'    => $this->cfg['client_id'],
            'client_secret'=> $this->cfg['client_secret'],
        ]);

        $token = $res['result']['accessToken'] ?? null;
        if (!is_string($token) || $token === '') {
            throw new RuntimeException(
                'Omada: token tidak ditemukan di response. '
                . 'Cek client_id/client_secret dan pastikan Open API aktif. '
                . 'Response: ' . json_encode($res)
            );
        }

        // expiresIn dalam detik. Default konservatif kalau tidak ada.
        $ttl = (int)($res['result']['expiresIn'] ?? 3600);
        $this->storeToken($token, max(300, $ttl));

        return $token;
    }

    private function authHeaders(): array
    {
        return ['Authorization' => 'AccessToken=' . $this->token()];
    }

    /** @return string[] */
    private function siteIds(): array
    {
        if (!empty($this->cfg['site_ids'])) {
            return $this->cfg['site_ids'];
        }

        $url = rtrim($this->cfg['base_url'], '/')
             . '/openapi/v1/' . rawurlencode($this->cfg['omadac_id'])
             . '/sites?page=1&pageSize=100';

        $res  = $this->http('GET', $url, $this->authHeaders());
        $rows = $res['result']['data'] ?? [];

        $ids = [];
        foreach ($rows as $r) {
            $id = $r['siteId'] ?? $r['id'] ?? null;
            if ($id) {
                $id = (string)$id;
                $ids[] = $id;
                // Dipakai normalise() supaya kolom `site` di DB berisi nama
                // site yang manusiawi ("Nusa HeadQuaterM"), bukan hash ID
                // ("698c4b75c102800e5815fd05") — penting kalau satu akun
                // Omada mengelola banyak site/pelanggan sekaligus.
                $this->siteNames[$id] = (string)($r['name'] ?? $id);
            }
        }

        if (!$ids) {
            throw new RuntimeException('Omada: tidak ada site ditemukan.');
        }
        return $ids;
    }

    public function fetchClients(): array
    {
        $out = [];

        try {
            $sites = $this->siteIds();
        } catch (RuntimeException $e) {
            // Token mungkin expired lebih cepat dari yang dilaporkan API.
            // Buang cache dan coba sekali lagi.
            $this->clearToken();
            $sites = $this->siteIds();
        }

        foreach ($sites as $siteId) {
            $page = 1;

            do {
                $url = rtrim($this->cfg['base_url'], '/')
                     . '/openapi/v1/' . rawurlencode($this->cfg['omadac_id'])
                     . '/sites/' . rawurlencode($siteId)
                     . '/clients?page=' . $page . '&pageSize=100';

                $res  = $this->http('GET', $url, $this->authHeaders());
                $rows = $res['result']['data'] ?? [];
                $total = (int)($res['result']['totalRows'] ?? count($rows));

                $siteName = $this->siteNames[$siteId] ?? $siteId;
                foreach ($rows as $r) {
                    $s = $this->normalise($r, $siteId, $siteName);
                    if ($s !== null) {
                        $out[] = $s;
                    }
                }

                $page++;
                $sudah = ($page - 1) * 100;
            } while (count($rows) > 0 && $sudah < $total && $page < 50);
        }

        return $out;
    }

    /**
     * Mapping response Omada → ClientSample.
     * INI BAGIAN YANG PALING MUNGKIN PERLU DISESUAIKAN.
     */
    private function normalise(array $r, string $siteId, string $siteName): ?ClientSample
    {
        // Lewati client wired — tidak punya RSSI dan tidak relevan.
        $wireless = $r['wireless'] ?? null;
        if ($wireless === false) {
            return null;
        }

        $mac = MacUtil::toRadacctOrNull($r['mac'] ?? null);
        if ($mac === null) {
            return null;
        }

        $channel = isset($r['channel']) ? (int)$r['channel'] : null;

        // Omada mengirim radioId: 0=2.4G, 1=5G, 2=6G. Kalau tidak ada,
        // tebak dari channel.
        $band = match ($r['radioId'] ?? null) {
            0       => '2.4G',
            1       => '5G',
            2       => '6G',
            default => MacUtil::bandFromChannel($channel),
        };

        // rssi biasanya sudah negatif (dBm). Beberapa versi mengirim
        // "signalLevel" 0-100 — itu BUKAN dBm, jangan dipakai.
        $rssi = isset($r['rssi']) ? (int)$r['rssi'] : null;
        if ($rssi !== null && $rssi > 0) {
            $rssi = -$rssi;   // jaga-jaga kalau dikirim tanpa tanda minus
        }

        return new ClientSample(
            vendor:    'omada',
            site:      (string)($r['siteName'] ?? $siteName),
            apName:    (string)($r['apName'] ?? $r['apMac'] ?? 'unknown'),
            apMac:     MacUtil::toRadacctOrNull($r['apMac'] ?? null),
            ssid:      isset($r['ssid']) ? (string)$r['ssid'] : null,
            clientMac: $mac,
            rssi:      $rssi,
            band:      $band,
            channel:   $channel,
            snr:       isset($r['snr']) ? (int)$r['snr'] : null,
            txRate:    isset($r['txRate']) ? (int)round($r['txRate'] / 1000) : null,
            rxRate:    isset($r['rxRate']) ? (int)round($r['rxRate'] / 1000) : null,
        );
    }
}
