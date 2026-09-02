<?php
declare(strict_types=1);

/**
 * Resolusi MAC → username lewat radacct.
 *
 * Kenapa dilakukan SAAT POLLING, bukan saat query laporan:
 *
 * MAC address client kebanyakan acak (private MAC di iOS 14+, Android 10+,
 * Windows 10+). MAC yang sama bisa dipakai perangkat lain di kemudian hari.
 * Kalau di-resolve saat bikin laporan sebulan kemudian, hasilnya bisa
 * menunjuk orang yang salah.
 *
 * Karena itu username disimpan langsung ke wifi_samples saat insert,
 * ketika mapping-nya masih pasti benar.
 */
final class UsernameResolver
{
    public function __construct(private PDO $radiusPdo) {}

    /**
     * Resolusi batch. JANGAN panggil per client — 300 client berarti
     * 300 query per menit ke tabel jutaan baris.
     *
     * @param  string[] $macs  Format radacct: AA-BB-CC-DD-EE-FF
     * @return array<string,string>  mac => username
     */
    public function resolveBatch(array $macs, string $ts): array
    {
        $macs = array_values(array_unique(array_filter($macs)));
        if (!$macs) {
            return [];
        }

        $map = [];

        // Pecah jadi chunk supaya placeholder tidak terlalu banyak
        foreach (array_chunk($macs, 500) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '?'));

            /*
             * Klausa "acctstarttime >= DATE_SUB(?, INTERVAL 1 DAY)" adalah
             * PENGAMAN terhadap sesi zombie: baris dengan acctstoptime NULL
             * padahal client sudah lama pergi (terjadi kalau controller
             * tidak mengirim Accounting-Stop). Tanpa batas ini, sesi tiga
             * minggu lalu bisa ikut ter-match dan memberi username salah.
             *
             * Ini pengaman, BUKAN solusi. Perbaiki di sumbernya dengan
             * mengaktifkan interim update di controller.
             */
            $sql = "SELECT callingstationid, username, acctstarttime
                    FROM radacct
                    WHERE callingstationid IN ($ph)
                      AND acctstarttime <= ?
                      AND (acctstoptime IS NULL OR acctstoptime >= ?)
                      AND acctstarttime >= DATE_SUB(?, INTERVAL 1 DAY)
                    ORDER BY acctstarttime ASC";

            $stmt = $this->radiusPdo->prepare($sql);
            $stmt->execute([...$chunk, $ts, $ts, $ts]);

            // ORDER BY ASC + overwrite = sesi terbaru yang menang
            foreach ($stmt as $row) {
                $map[$row['callingstationid']] = $row['username'];
            }
        }

        return $map;
    }
}
