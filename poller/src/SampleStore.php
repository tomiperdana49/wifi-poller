<?php
declare(strict_types=1);

final class SampleStore
{
    public function __construct(private PDO $pdo) {}

    /**
     * @param  ClientSample[] $samples
     * @return int jumlah baris tersimpan
     */
    public function insertBatch(array $samples, string $ts): int
    {
        if (!$samples) {
            return 0;
        }

        $cols = 'ts, vendor, site, ap_name, ap_mac, ssid, band, channel,
                 client_mac, username, rssi, snr, tx_rate, rx_rate';

        $total = 0;

        // Satu siklus = satu transaksi. Tanpa ini tiap chunk langsung
        // terlihat, dan dashboard (yang memantau MAX(ts)) mengambil snapshot
        // setengah jadi di tengah insert -- vendor yang disimpan paling akhir
        // (mis. UniFi) hilang dari tampilan sampai siklus berikutnya.
        $this->pdo->beginTransaction();
        try {
            $total = $this->insertChunks($samples, $cols, $ts);
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }

        return $total;
    }

    /** @param ClientSample[] $samples */
    private function insertChunks(array $samples, string $cols, string $ts): int
    {
        $total = 0;

        // Multi-row insert per 200 baris. Lebih cepat daripada satu
        // INSERT per sample, dan tidak membuat paket terlalu besar.
        foreach (array_chunk($samples, 200) as $chunk) {
            $rowPh = '(' . implode(',', array_fill(0, 14, '?')) . ')';
            $sql   = "INSERT INTO wifi_samples ($cols) VALUES "
                   . implode(',', array_fill(0, count($chunk), $rowPh));

            $vals = [];
            foreach ($chunk as $s) {
                array_push($vals,
                    $ts, $s->vendor, $s->site, $s->apName, $s->apMac,
                    $s->ssid, $s->band, $s->channel, $s->clientMac,
                    $s->username, $s->rssi, $s->snr, $s->txRate, $s->rxRate
                );
            }

            $this->pdo->prepare($sql)->execute($vals);
            $total += count($chunk);
        }

        return $total;
    }
}
