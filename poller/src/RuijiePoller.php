<?php
declare(strict_types=1);

/**
 * Ruijie Cloud API (region Asia: cloud-as.ruijienetworks.com).
 *
 * Berdasarkan "Ruijie Cloud API Reference Manual V2.0.3" resmi (dibaca
 * langsung dari Help Center Ruijie Cloud, bukan tebakan) — beda arsitektur
 * cukup jauh dari Omada/UniFi, catat baik-baik:
 *
 * =====================================================================
 * PENTING
 * =====================================================================
 * 1. Autentikasi lewat QUERY PARAM `access_token=...` di URL, BUKAN
 *    header Authorization/Bearer seperti Omada/UniFi.
 * 2. Endpoint token WAJIB menyertakan query param literal
 *    `token=d63dss0a81e4415a889ac5b78fsc904a` — nilai ini didokumentasikan
 *    resmi sebagai konstanta tetap ("no need change this value"), bukan
 *    kredensial rahasia milik akun Anda.
 * 3. Daftar network group berbentuk TREE bersarang (field `subGroups`),
 *    bukan list datar seperti site Omada/UniFi — poller ini jalan
 *    rekursif mengumpulkan semua groupId di tree tsb kalau
 *    RUIJIE_GROUP_IDS dikosongkan.
 * 4. Endpoint client (`sta/sta_users`) tidak mengirim MAC address AP,
 *    cuma `deviceAliasName` (nama alias) dan `sn` (serial number) — jadi
 *    `apMac` di ClientSample akan selalu null untuk vendor ini.
 * 5. Response HTTP selalu 200 walau gagal secara logis — sukses/gagal
 *    ditandai field `code` di body (`0` = sukses), BUKAN oleh status
 *    HTTP. Setiap respons WAJIB dicek `code` secara eksplisit.
 * 6. `uplinkRate`/`downlinkRate` TERKONFIRMASI Kbps (bukan bps) dari data
 *    asli --debug: nilai "1024" berulang di banyak client berbeda — pola
 *    klasik tabel rate 802.11 dalam Kbps (1024 Kbps ≈ rate dasar 1 Mbps),
 *    dan nilai seperti 133120 cuma masuk akal sebagai ~130 Mbps kalau
 *    dibagi 1000, bukan 1.000.000. Konsisten dengan konvensi Kbps yang
 *    sama dipakai Omada/UniFi.
 * =====================================================================
 */
final class RuijiePoller extends BasePoller
{
    private const TOKEN_PATH  = '/service/api/oauth20/client/access_token';
    private const GROUPS_PATH = '/service/api/group/single/tree';
    private const CLIENT_PATH = '/logbizagent/logbiz/api/sta/sta_users';

    // Konstanta tetap yang didokumentasikan resmi Ruijie, bukan rahasia.
    private const TOKEN_FIXED_PARAM = 'd63dss0a81e4415a889ac5b78fsc904a';

    // Akun Ruijie di sini ternyata MSP raksasa — bisa RIBUAN leaf site.
    // Fetch sekuensial (1 request/site) sama sekali tidak muat dalam
    // siklus cron 1 menit (diverifikasi: >500 request dalam 5 menit
    // belum selesai). Jadi client di-fetch paralel pakai curl_multi,
    // N request sekaligus, bukan satu-satu.
    private const CONCURRENCY = 25;

    public bool $debug = false;

    /** @var array<string,string> groupId => nama group, diisi oleh groupIds() */
    private array $groupNames = [];

    private function token(): string
    {
        $cached = $this->cachedToken();
        if ($cached !== null) {
            return $cached;
        }

        $url = rtrim($this->cfg['base_url'], '/') . self::TOKEN_PATH
             . '?token=' . self::TOKEN_FIXED_PARAM;

        $res = $this->http('POST', $url, [], [
            'appid'  => $this->cfg['app_id'],
            'secret' => $this->cfg['app_secret'],
        ]);

        if (($res['code'] ?? null) !== 0) {
            throw new RuntimeException(
                'Ruijie: gagal ambil token (code=' . ($res['code'] ?? '?') . '). '
                . 'Cek app_id/app_secret. Response: ' . json_encode($res)
            );
        }

        $token = $res['accessToken'] ?? null;
        if (!is_string($token) || $token === '') {
            throw new RuntimeException('Ruijie: accessToken tidak ada di response: ' . json_encode($res));
        }

        // Token resmi berlaku 30 hari, TAPI idle timeout 30 menit (dari
        // dokumentasi resmi). Cache konservatif 25 menit supaya tidak
        // kadaluarsa di tengah siklus cron per menit.
        $this->storeToken($token, 1500);

        return $token;
    }

    /** Tempel access_token sebagai query param — Ruijie tidak pakai header auth. */
    private function withToken(string $url): string
    {
        $sep = str_contains($url, '?') ? '&' : '?';
        return $url . $sep . 'access_token=' . rawurlencode($this->token());
    }

    /**
     * @return string[] Daftar groupId (string, numeric).
     *
     * Kosongkan RUIJIE_GROUP_IDS untuk ambil SEMUA group di tree —
     * sama seperti Omada/UniFi, satu akun sering mengelola banyak site
     * pelanggan (MSP) sekaligus.
     */
    private function groupIds(): array
    {
        if (!empty($this->cfg['group_ids'])) {
            return $this->cfg['group_ids'];
        }

        $url = $this->withToken(
            rtrim($this->cfg['base_url'], '/') . self::GROUPS_PATH . '?depth=DEVICE'
        );
        $res = $this->http('GET', $url, []);

        if ($this->debug) {
            fwrite(STDERR, "[ruijie group tree] " . json_encode($res) . "\n");
        }

        if (($res['code'] ?? null) !== 0) {
            throw new RuntimeException(
                'Ruijie: gagal ambil group tree (code=' . ($res['code'] ?? '?') . '): ' . json_encode($res)
            );
        }

        $ids = [];
        $this->walkGroupTree($res['groups'] ?? [], $ids);

        if (!$ids) {
            throw new RuntimeException('Ruijie: tidak ada group ditemukan di tree.');
        }
        return $ids;
    }

    /**
     * @param string[] $ids
     *
     * Cuma kumpulkan LEAF node (tidak punya subGroups) sebagai target
     * query client — bukan setiap folder di tree. Dari data --debug,
     * query ke satu groupId bisa mengembalikan client dengan buildingId
     * BEDA (kemungkinan besar rekursif ke sub-group-nya) — kalau folder
     * induk DAN anaknya sama-sama ikut di-query terpisah, itu jadi request
     * HTTP dobel yang sia-sia (dan lambat, karena Ruijie Cloud API
     * dipanggil sekuensial satu per satu). Dedup by MAC di fetchClients()
     * tetap dipertahankan sebagai jaring pengaman kedua.
     */
    private function walkGroupTree(array $node, array &$ids): void
    {
        $children = $node['subGroups'] ?? [];

        if (empty($children)) {
            $id = $node['groupId'] ?? null;
            // groupId 0 adalah node dummy pembungkus root, bukan site sungguhan.
            if ($id !== null && (int)$id !== 0) {
                $id = (string)$id;
                $ids[] = $id;
                $this->groupNames[$id] = (string)($node['name'] ?? $id);
            }
            return;
        }

        foreach ($children as $child) {
            $this->walkGroupTree($child, $ids);
        }
    }

    public function fetchClients(): array
    {
        try {
            $groups = $this->groupIds();
        } catch (RuntimeException $e) {
            $this->clearToken();
            $groups = $this->groupIds();
        }

        $out = $this->fetchClientsConcurrent($groups);

        // Dari data --debug, groupId yang di-query (mis. 265882) dan
        // buildingId yang dilaporkan kliennya sendiri (mis. 333894) bisa
        // berbeda — kemungkinan tree-nya mengembalikan client secara
        // rekursif dari sub-group. Kalau begitu, sub-group tsb ikut
        // ke-query terpisah juga (sama-sama ada di tree hasil
        // walkGroupTree()) dan client yang sama bisa ke-fetch dua kali.
        // Satu client fisik cuma bisa konek ke satu AP dalam satu waktu,
        // jadi MAC yang sama di satu siklus poll ini SELALU duplikat —
        // aman langsung di-dedup di sini.
        $seen = [];
        $deduped = [];
        foreach ($out as $s) {
            if (isset($seen[$s->clientMac])) {
                continue;
            }
            $seen[$s->clientMac] = true;
            $deduped[] = $s;
        }

        return $deduped;
    }

    /**
     * Fetch client dari banyak site SEKALIGUS pakai curl_multi, bukan
     * satu-satu. Wajib untuk akun sebesar ini (ribuan leaf site) —
     * request sekuensial 1x/site terbukti tidak selesai dalam 5 menit.
     *
     * Setiap "job" = satu request untuk satu (groupId, pageIndex). Job
     * baru ditambahkan ke antrian secara dinamis kalau ternyata sebuah
     * site punya >100 client (butuh halaman berikutnya) — jarang untuk
     * site sekecil ini, tapi tetap ditangani.
     *
     * @param string[] $groupIds
     * @return ClientSample[]
     */
    private function fetchClientsConcurrent(array $groupIds): array
    {
        $token = $this->token();
        $base  = rtrim($this->cfg['base_url'], '/') . self::CLIENT_PATH;
        $verifySsl = (bool)($this->cfg['verify_ssl'] ?? true);

        $queue = array_map(fn($gid) => ['gid' => $gid, 'page' => 0], $groupIds);
        $out = [];
        $debugPrinted = 0;

        $makeHandle = function (array $job) use ($token, $base, $verifySsl) {
            $ch = curl_init($base . '?access_token=' . rawurlencode($token));
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => json_encode([
                    'groupId'   => (int)$job['gid'],
                    'pageSize'  => 100,
                    'pageIndex' => $job['page'],
                    'staType'   => 'currentUser',
                ]),
                CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 20,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_SSL_VERIFYPEER => $verifySsl,
                CURLOPT_SSL_VERIFYHOST => $verifySsl ? 2 : 0,
            ]);
            return $ch;
        };

        $mh = curl_multi_init();
        /** @var array<int,array{ch:\CurlHandle,job:array}> $active */
        $active = [];

        while ($queue && count($active) < self::CONCURRENCY) {
            $job = array_shift($queue);
            $ch  = $makeHandle($job);
            curl_multi_add_handle($mh, $ch);
            $active[(int)$ch] = ['ch' => $ch, 'job' => $job];
        }

        do {
            do {
                $status = curl_multi_exec($mh, $running);
            } while ($status === CURLM_CALL_MULTI_PERFORM);
            curl_multi_select($mh, 1.0);

            while ($info = curl_multi_info_read($mh)) {
                $ch  = $info['handle'];
                $id  = (int)$ch;
                $job = $active[$id]['job'];
                $body = curl_multi_getcontent($ch);
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                unset($active[$id]);

                $res = json_decode((string)$body, true);
                $rows = [];

                if (is_array($res) && ($res['code'] ?? null) === 0) {
                    $rows = $res['list'] ?? [];
                    $siteName = $this->groupNames[$job['gid']] ?? $job['gid'];

                    if ($this->debug && $debugPrinted < 5 && $rows) {
                        fwrite(STDERR, "[ruijie sta_users {$job['gid']}] " . json_encode(array_slice($rows, 0, 2)) . "\n");
                        $debugPrinted++;
                    }

                    foreach ($rows as $r) {
                        $s = $this->normalise($r, $siteName);
                        if ($s !== null) {
                            $out[] = $s;
                        }
                    }

                    // Halaman penuh (100 baris) berarti mungkin masih ada
                    // lanjutannya. Sengaja tidak dites di sini — cukup
                    // langka untuk site sekecil ini, dan menambah
                    // kerumitan antrian tanpa manfaat besar. Batas 50
                    // halaman kalau suatu saat memang perlu:
                    if (count($rows) >= 100 && $job['page'] < 50) {
                        $queue[] = ['gid' => $job['gid'], 'page' => $job['page'] + 1];
                    }
                }
                // code!=0 / gagal parse -- lewati diam-diam, satu site
                // bermasalah tidak boleh menjatuhkan yang lain.

                if ($queue) {
                    $next = array_shift($queue);
                    $nch  = $makeHandle($next);
                    curl_multi_add_handle($mh, $nch);
                    $active[(int)$nch] = ['ch' => $nch, 'job' => $next];
                }
            }
        } while ($active || $queue);

        curl_multi_close($mh);

        return $out;
    }

    /**
     * Mapping response Ruijie (sta/sta_users) → ClientSample.
     * Semua field di sini, termasuk satuan uplinkRate/downlinkRate (Kbps),
     * sudah terkonfirmasi dari data asli — lihat catatan di komentar kelas.
     */
    private function normalise(array $r, string $siteName): ?ClientSample
    {
        // Format MAC Ruijie: "ff61.f313.0101" (dotted-hex Cisco-style).
        // MacUtil::toRadacct() aman dipakai apa adanya karena cuma
        // mengambil karakter hex dan membuang sisanya.
        $mac = MacUtil::toRadacctOrNull($r['mac'] ?? null);
        if ($mac === null) {
            return null;
        }

        $channel = isset($r['channel']) ? (int)$r['channel'] : null;
        $band    = is_string($r['band'] ?? null) ? $r['band'] : MacUtil::bandFromChannel($channel);

        // rssiInt sudah dBm asli bertipe int. Field "rssi" (string) di
        // dokumentasi bernilai sama, dipakai cuma sebagai fallback.
        $rssi = $r['rssiInt'] ?? $r['rssi'] ?? null;
        $rssi = ($rssi === null || $rssi === '') ? null : (int)$rssi;
        if ($rssi !== null && $rssi > 0) {
            $rssi = -$rssi;
        }

        return new ClientSample(
            vendor:    'ruijie',
            site:      (string)($r['buildingName'] ?? $siteName),
            apName:    (string)($r['deviceAliasName'] ?: ($r['sn'] ?? 'unknown')),
            // API resmi tidak mengirim MAC address AP di endpoint ini,
            // cuma alias name + serial number. Jangan tebak-tebak.
            apMac:     null,
            ssid:      isset($r['ssid']) ? (string)$r['ssid'] : null,
            clientMac: $mac,
            rssi:      $rssi,
            band:      $band,
            channel:   $channel,
            // Tidak ada field SNR asli di response ini. "score"/
            // "scoreReason"/"utilization" adalah metrik kualitas lain,
            // bukan SNR — jangan disamakan biar tidak menyesatkan.
            snr:       null,
            txRate:    isset($r['uplinkRate'])   ? (int)round($r['uplinkRate'] / 1000)   : null,
            rxRate:    isset($r['downlinkRate']) ? (int)round($r['downlinkRate'] / 1000) : null,
        );
    }
}
