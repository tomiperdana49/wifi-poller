-- Label controller di data sample, supaya dashboard bisa memfilter per
-- controller (mis. hanya ruijie-nusanet-jakarta) -- sebelumnya ketiga
-- controller Ruijie cuma terbedakan sebagai vendor 'ruijie'.
-- Jalankan sekali sebagai root SEBELUM deploy poller.php versi baru:
--   sudo mysql wifi_analytics < poller/sql/002_controller_column.sql

-- Kolom di akhir tabel + nullable = ALGORITHM=INSTANT, tanpa rebuild
-- (wifi_samples berisi ratusan juta baris). Baris lama tetap NULL.
ALTER TABLE wifi_samples
  ADD COLUMN controller VARCHAR(64) NULL,
  ALGORITHM=INSTANT;

-- controller masuk PRIMARY KEY: dua controller bisa saja punya nama site
-- + AP yang sama, dan REPLACE INTO di rollup.php tidak boleh saling timpa.
-- Baris lama berisi '' sampai di-backfill.
ALTER TABLE wifi_hourly
  ADD COLUMN controller VARCHAR(64) NOT NULL DEFAULT '' AFTER vendor,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (hour_ts, vendor, controller, site, ap_name, band);
