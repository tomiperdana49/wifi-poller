<?php
declare(strict_types=1);

/**
 * UniFi Network Application (controller self-hosted: UDM/UDM-Pro/UCG,
 * CloudKey Gen1/Gen2, atau software controller di Linux/Windows/Docker).
 *
 * BUKAN untuk UniFi Site Manager (api.ui.com) — API cloud resmi itu tidak
 * mengekspos RSSI per client, jadi tidak berguna untuk poller ini.
 *
 * =====================================================================
 * PENTING — VERIFIKASI DULU
 * =====================================================================
 * Dua varian controller punya bentuk URL beda:
 *   - UniFi OS (UDM/UDM-Pro/UCG, firmware modern): base URL langsung IP
 *     console, semua endpoint network app di-proxy di bawah
 *     /proxy/network/... Login di /api/auth/login.
 *   - Controller software klasik (CloudKey Gen1, self-hosted di
 *     Linux/Windows/Docker): base URL biasanya https://host:8443,
 *     endpoint LANGSUNG /api/... tanpa prefix proxy. Login di /api/login.
 *
 * Poller ini mencoba /api/login (klasik) dulu, baru fallback ke
 * /api/auth/login (UniFi OS) kalau tidak dapat cookie sesi — otomatis,
 * tidak perlu di-set manual di .env. Urutan ini sengaja dibalik dari
 * dugaan awal: sejumlah controller klasik TETAP punya route
 * /api/auth/login yang selalu menjawab 401 walau kredensial benar,
 * jadi tidak bisa dipakai sebagai sinyal "ini pasti UniFi OS".
 *
 * Field RSSI ada JEBAKAN NAMA seperti di Omada/Ruijie: response stat/sta
 * punya DUA field mirip —
 *   - "signal": dBm negatif (mis. -65) — INI yang benar dipakai sebagai rssi.
 *   - "rssi": angka positif kecil (mis. 38), itu SNR-like value untuk
 *     bar sinyal di UI, BUKAN dBm. Jangan dipakai langsung.
 * Jalankan --dry-run --debug dan bandingkan dengan mapping di normalise()
 * sebelum mempercayai datanya.
 * =====================================================================
 */
final class UnifiPoller extends BasePoller
{
    public bool $debug = false;

    /** @var array<string,string> apMac => nama AP, diisi per site oleh loadApNames() */
    private array $apNames = [];

    /** @var array<string,string> site short-name => desc/display name, diisi oleh siteIds() */
    private array $siteDescs = [];

    /** @return array{cookie:string,csrf:?string,is_unifi_os:bool} */
    private function session(): array
    {
        $cached = $this->cachedToken();
        if ($cached !== null) {
            $data = json_decode($cached, true);
            if (is_array($data) && !empty($data['cookie'])) {
                return $data;
            }
        }
        return $this->login();
    }

    /** @return array{cookie:string,csrf:?string,is_unifi_os:bool} */
    private function login(): array
    {
        $base = rtrim($this->cfg['base_url'], '/');
        $body = [
            'username' => $this->cfg['username'],
            'password' => $this->cfg['password'],
        ];

        // Coba endpoint controller klasik dulu (self-hosted/CloudKey) —
        // paling umum untuk instalasi self-hosted. Baru fallback ke
        // endpoint UniFi OS (UDM/UDM-Pro/UCG) kalau gagal.
        //
        // Tidak bisa mengandalkan HTTP 404 buat deteksi jenis controller:
        // sejumlah controller klasik TETAP punya route /api/auth/login
        // yang selalu menjawab 401 "api.err.LoginRequired" walau
        // kredensial benar, padahal /api/login klasiknya berhasil normal.
        // Jadi syarat sukses di sini adalah cookie sesi benar-benar
        // didapat, bukan sekadar "bukan 404".
        [$cookie, $csrf, $code] = $this->rawLogin($base . '/api/login', $body);
        $isUnifiOs = false;

        if ($cookie === null || $code >= 400) {
            [$cookie, $csrf, $code] = $this->rawLogin($base . '/api/auth/login', $body);
            $isUnifiOs = true;
        }

        if ($cookie === null || $code >= 400) {
            throw new RuntimeException(
                "UniFi: login gagal (HTTP $code). Cek username/password, "
                . 'dan pastikan akun tidak kena 2FA (2FA tidak didukung poller ini).'
            );
        }

        $data = ['cookie' => $cookie, 'csrf' => $csrf, 'is_unifi_os' => $isUnifiOs];

        // Idle timeout session UniFi biasanya jauh lebih lama dari ini,
        // tapi login berulang tiap siklus cron (~1 menit) berisiko kena
        // rate-limit/lockout brute-force protection. Cache 20 menit.
        $this->storeToken(json_encode($data), 1200);

        return $data;
    }

    /**
     * Login mentah pakai curl langsung (bukan lewat http() helper di
     * BasePoller) karena butuh baca header Set-Cookie & X-CSRF-Token dari
     * response, bukan cuma body JSON.
     *
     * @return array{0:?string,1:?string,2:int} [cookie gabungan, csrf token, HTTP code]
     */
    private function rawLogin(string $url, array $body): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($body),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER         => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => (bool)($this->cfg['verify_ssl'] ?? true),
            CURLOPT_SSL_VERIFYHOST => ($this->cfg['verify_ssl'] ?? true) ? 2 : 0,
        ]);

        $res  = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);

        if ($res === false) {
            curl_close($ch);
            throw new RuntimeException("UniFi: HTTP gagal ke $url: $err");
        }

        $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);

        $headerText = substr((string)$res, 0, $headerSize);
        $lines      = explode("\r\n", $headerText);

        $cookies = [];
        $csrf    = null;
        foreach ($lines as $line) {
            if (stripos($line, 'set-cookie:') === 0) {
                $pair = trim(substr($line, strlen('set-cookie:')));
                $cookies[] = explode(';', $pair, 2)[0];
            } elseif (stripos($line, 'x-csrf-token:') === 0) {
                $csrf = trim(substr($line, strlen('x-csrf-token:')));
            }
        }

        $cookie = $cookies ? implode('; ', $cookies) : null;
        return [$cookie, $csrf, $code];
    }

    private function authHeaders(array $session): array
    {
        $h = ['Cookie' => $session['cookie']];
        if (!empty($session['csrf'])) {
            $h['X-CSRF-Token'] = $session['csrf'];
        }
        return $h;
    }

    /** Prefix API berbeda antara UniFi OS (di-proxy) dan controller klasik. */
    private function apiBase(array $session): string
    {
        $base = rtrim($this->cfg['base_url'], '/');
        return $base . ($session['is_unifi_os'] ? '/proxy/network' : '');
    }

    /**
     * @return string[] Site short-name (bukan display name).
     *
     * Kalau UNIFI_SITE_IDS dikosongkan, ambil SEMUA site yang bisa
     * dilihat akun ini via /api/self/sites. Sama seperti Omada: satu
     * akun controller sering mengelola banyak site pelanggan sekaligus
     * (MSP), bukan cuma satu kantor — jangan asumsikan cuma "default".
     */
    private function siteIds(array $session): array
    {
        if (!empty($this->cfg['site_ids'])) {
            return $this->cfg['site_ids'];
        }

        $url = $this->apiBase($session) . '/api/self/sites';
        $res = $this->http('GET', $url, $this->authHeaders($session));

        $ids = [];
        foreach ($res['data'] ?? [] as $r) {
            $id = $r['name'] ?? null;
            if ($id) {
                $id = (string)$id;
                $ids[] = $id;
                $this->siteDescs[$id] = (string)($r['desc'] ?: $id);
            }
        }

        if (!$ids) {
            throw new RuntimeException('UniFi: tidak ada site ditemukan untuk akun ini.');
        }
        return $ids;
    }

    /** Isi $this->apNames dari stat/device supaya kolom apName manusiawi. */
    private function loadApNames(array $session, string $site): void
    {
        $this->apNames = [];
        $url = $this->apiBase($session) . '/api/s/' . rawurlencode($site) . '/stat/device';

        try {
            $res = $this->http('GET', $url, $this->authHeaders($session));
        } catch (RuntimeException $e) {
            // Tidak fatal — tanpa ini apName cuma jatuh balik ke apMac.
            if ($this->debug) {
                fwrite(STDERR, "[unifi stat/device] gagal: {$e->getMessage()}\n");
            }
            return;
        }

        foreach ($res['data'] ?? [] as $dev) {
            $mac = MacUtil::toRadacctOrNull($dev['mac'] ?? null);
            if ($mac !== null) {
                $this->apNames[$mac] = (string)($dev['name'] ?? $dev['model'] ?? $mac);
            }
        }
    }

    public function fetchClients(): array
    {
        try {
            $session = $this->session();
        } catch (RuntimeException $e) {
            $this->clearToken();
            $session = $this->login();
        }

        try {
            $sites = $this->siteIds($session);
        } catch (RuntimeException $e) {
            // Cookie ter-cache mungkin sudah invalid di sisi controller.
            $this->clearToken();
            $session = $this->login();
            $sites   = $this->siteIds($session);
        }
        $out   = [];

        foreach ($sites as $site) {
            $this->loadApNames($session, $site);

            $url = $this->apiBase($session) . '/api/s/' . rawurlencode($site) . '/stat/sta';

            try {
                $res = $this->http('GET', $url, $this->authHeaders($session));
            } catch (RuntimeException $e) {
                // Cookie mungkin sudah invalid (controller di-restart dll).
                // Buang cache, login ulang sekali, coba lagi.
                $this->clearToken();
                $session = $this->login();
                $res = $this->http('GET', $url, $this->authHeaders($session));
            }

            if ($this->debug) {
                fwrite(STDERR, "[unifi stat/sta $site] " . json_encode(array_slice($res['data'] ?? [], 0, 2)) . "\n");
            }

            $siteName = $this->siteDescs[$site] ?? $site;
            foreach ($res['data'] ?? [] as $r) {
                $s = $this->normalise($r, $site, $siteName);
                if ($s !== null) {
                    $out[] = $s;
                }
            }
        }

        return $out;
    }

    /**
     * Mapping response UniFi (stat/sta) → ClientSample.
     * INI BAGIAN YANG PALING MUNGKIN PERLU DISESUAIKAN — lihat catatan
     * jebakan field "signal" vs "rssi" di komentar kelas ini.
     */
    private function normalise(array $r, string $site, string $siteName): ?ClientSample
    {
        // Lewati client wired — tidak punya RSSI. UniFi menandainya lewat
        // is_wired=true dan/atau tidak ada field essid.
        if (($r['is_wired'] ?? false) === true || empty($r['essid'])) {
            return null;
        }

        $mac = MacUtil::toRadacctOrNull($r['mac'] ?? null);
        if ($mac === null) {
            return null;
        }

        $apMac = MacUtil::toRadacctOrNull($r['ap_mac'] ?? null);

        $channel = isset($r['channel']) ? (int)$r['channel'] : null;

        // radio: 'ng'=2.4G, 'na'=5G, '6e'=6G (nama field controller lama
        // vs baru bisa beda — verifikasi lewat --debug).
        $radio = (string)($r['radio'] ?? $r['radio_proto'] ?? '');
        $band = match (true) {
            str_contains($radio, 'ng') => '2.4G',
            str_contains($radio, 'na') => '5G',
            str_contains($radio, '6')  => '6G',
            default => MacUtil::bandFromChannel($channel),
        };

        // "signal" = dBm asli. "rssi" bawaan UniFi BUKAN dBm — lihat
        // catatan di komentar kelas. Fallback ke rssi cuma kalau signal
        // benar-benar tidak ada.
        $rssi = $r['signal'] ?? $r['rssi'] ?? null;
        $rssi = ($rssi === null || $rssi === '') ? null : (int)$rssi;
        if ($rssi !== null && $rssi > 0) {
            $rssi = -$rssi;
        }

        // snr = signal - noise (dB), keduanya dBm negatif. Null kalau salah
        // satu tidak dikirim controller — jangan tebak dari "satisfaction"
        // (skor kualitas 0-100 UniFi, bukan SNR sungguhan).
        $snr = (isset($r['signal'], $r['noise']))
             ? (int)$r['signal'] - (int)$r['noise']
             : null;

        return new ClientSample(
            vendor:    'unifi',
            site:      $siteName,
            apName:    $this->apNames[$apMac ?? ''] ?? (string)($apMac ?? 'unknown'),
            apMac:     $apMac,
            ssid:      isset($r['essid']) ? (string)$r['essid'] : null,
            clientMac: $mac,
            rssi:      $rssi,
            band:      $band,
            channel:   $channel,
            snr:       $snr,
            txRate:    isset($r['tx_rate']) ? (int)round($r['tx_rate'] / 1000) : null,
            rxRate:    isset($r['rx_rate']) ? (int)round($r['rx_rate'] / 1000) : null,
        );
    }
}
