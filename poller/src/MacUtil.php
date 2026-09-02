<?php
declare(strict_types=1);

final class MacUtil
{
    /**
     * Normalisasi ke format yang dipakai radacct: AA-BB-CC-DD-EE-FF
     *
     * Kenapa format ini dan bukan yang lain: radacct Anda menyimpan
     * "8E-E3-CA-FD-6C-8B". Kalau poller menyimpan format lain, JOIN
     * harus pakai REPLACE() yang membuat index tidak terpakai dan
     * lookup jadi lambat di tabel jutaan baris.
     *
     * Ikuti format radacct, bukan sebaliknya.
     */
    public static function toRadacct(string $mac): string
    {
        $hex = strtoupper(preg_replace('/[^0-9A-Fa-f]/', '', $mac) ?? '');

        if (strlen($hex) !== 12) {
            throw new InvalidArgumentException("MAC tidak valid: $mac");
        }

        return implode('-', str_split($hex, 2));
    }

    /** Versi yang mengembalikan null alih-alih throw. */
    public static function toRadacctOrNull(?string $mac): ?string
    {
        if ($mac === null || $mac === '') {
            return null;
        }
        try {
            return self::toRadacct($mac);
        } catch (InvalidArgumentException) {
            return null;
        }
    }

    /**
     * True kalau MAC ini hasil randomisasi perangkat (locally administered bit).
     *
     * iOS 14+, Android 10+, Windows 10+ mengaktifkan private MAC secara
     * default. MAC seperti ini tidak stabil lintas hari — jangan dipakai
     * sebagai identitas perangkat jangka panjang. Pakai username.
     */
    public static function isRandom(string $mac): bool
    {
        $hex = preg_replace('/[^0-9A-Fa-f]/', '', $mac) ?? '';
        if (strlen($hex) !== 12) {
            return false;
        }
        return (hexdec(substr($hex, 0, 2)) & 0x02) !== 0;
    }

    /**
     * Tebak band dari nomor channel. Dipakai kalau API tidak menyediakan
     * field band secara eksplisit.
     */
    public static function bandFromChannel(?int $ch): ?string
    {
        if ($ch === null || $ch <= 0) return null;
        if ($ch <= 14)  return '2.4G';
        if ($ch <= 177) return '5G';
        return '6G';
    }
}
