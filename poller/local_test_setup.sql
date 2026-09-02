-- Setup DB lokal untuk uji coba poller di Mac (bukan server produksi).
-- Meniru Bagian 3 tutorial + tabel radacct minimal untuk uji resolusi username.

CREATE DATABASE IF NOT EXISTS wifi_analytics
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE wifi_analytics;

DROP TABLE IF EXISTS wifi_samples;
CREATE TABLE wifi_samples (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts          DATETIME        NOT NULL,
  vendor      ENUM('omada','ruijie','unifi') NOT NULL,
  site        VARCHAR(64)     NOT NULL,
  ap_name     VARCHAR(64)     NOT NULL,
  ap_mac      VARCHAR(20)     NULL,
  ssid        VARCHAR(64)     NULL,
  band        VARCHAR(8)      NULL,
  channel     SMALLINT        NULL,
  client_mac  VARCHAR(20)     NOT NULL,
  username    VARCHAR(64)     NULL,
  rssi        SMALLINT        NULL,
  snr         SMALLINT        NULL,
  tx_rate     INT             NULL,
  rx_rate     INT             NULL,
  INDEX idx_ap_ts       (ap_name, ts),
  INDEX idx_ts          (ts),
  INDEX idx_client_ts   (client_mac, ts),
  INDEX idx_username_ts (username, ts)
) ENGINE=InnoDB;

DROP TABLE IF EXISTS wifi_hourly;
CREATE TABLE wifi_hourly (
  hour_ts        DATETIME     NOT NULL,
  vendor         VARCHAR(16)  NOT NULL,
  site           VARCHAR(64)  NOT NULL,
  ap_name        VARCHAR(64)  NOT NULL,
  band           VARCHAR(8)   NOT NULL DEFAULT '',
  samples        INT          NOT NULL,
  clients_unik   INT          NOT NULL,
  avg_rssi       DECIMAL(5,1) NULL,
  min_rssi       SMALLINT     NULL,
  pct_lemah      DECIMAL(5,1) NULL,
  pct_sangat_lemah DECIMAL(5,1) NULL,
  PRIMARY KEY (hour_ts, vendor, site, ap_name, band)
) ENGINE=InnoDB;

-- Tabel radacct tiruan (server produksi asli belum dicek — lihat Bagian 1).
CREATE DATABASE IF NOT EXISTS radiusdb
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE radiusdb;

DROP TABLE IF EXISTS radacct;
CREATE TABLE radacct (
  radacctid       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(64)   NULL,
  callingstationid VARCHAR(50)  NOT NULL,
  calledstationid VARCHAR(50)   NULL,
  acctstarttime   DATETIME      NULL,
  acctupdatetime  DATETIME      NULL,
  acctstoptime    DATETIME      NULL,
  acctsessiontime INT           NULL,
  acctinputoctets BIGINT        NULL,
  acctoutputoctets BIGINT       NULL,
  acctterminatecause VARCHAR(32) NULL,
  INDEX idx_csid_start (callingstationid, acctstarttime)
) ENGINE=InnoDB;

-- Sesi aktif untuk dua client, cocok dengan sample yang akan di-generate
-- oleh test_local.php (lihat file itu untuk MAC yang dipakai).
INSERT INTO radacct
  (username, callingstationid, calledstationid, acctstarttime, acctupdatetime, acctstoptime, acctsessiontime)
VALUES
  ('budi.santoso', '8E-E3-CA-FD-6C-8B', '22-EB-B6-A6-DD-85:NusanetEnterprise', NOW() - INTERVAL 10 MINUTE, NOW() - INTERVAL 1 MINUTE, NULL, NULL),
  ('siti.rahma',   'AA-11-22-33-44-55', '22-EB-B6-A6-DD-86:NusanetEnterprise', NOW() - INTERVAL 20 MINUTE, NOW() - INTERVAL 1 MINUTE, NULL, NULL);
-- MAC ketiga (CC-DD-...) sengaja tidak ada di radacct untuk menguji
-- kasus username NULL (Bagian 6).

-- User MySQL untuk poller (Bagian 3.4), dipakai config.php lokal.
CREATE USER IF NOT EXISTS 'wifipoller'@'localhost' IDENTIFIED BY 'lokal_test_only';
GRANT SELECT, INSERT, UPDATE, DELETE ON wifi_analytics.* TO 'wifipoller'@'localhost';
GRANT SELECT ON radiusdb.radacct TO 'wifipoller'@'localhost';
FLUSH PRIVILEGES;
