'use strict';

const q = require('./queries');

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

// wifi_samples cuma bertambah tiap poller.php jalan (~tiap menit). Polling
// DB tiap beberapa detik untuk MAX(ts) itu murah (pakai index idx_ts di
// wifi_samples), jadi snapshot lengkap cuma di-query dan di-broadcast saat
// benar-benar ada batch baru -- bukan tiap POLL_MS.
function startBroadcaster(broadcast) {
  let lastTs = null;

  async function tick() {
    try {
      const ts = await q.latestTs();
      if (!ts || ts === lastTs) return;
      lastTs = ts;

      const [overview, clients, aps] = await Promise.all([
        q.overview(),
        q.liveClients(),
        q.apSummary(),
      ]);

      broadcast({ type: 'snapshot', ts, overview, clients, aps });
    } catch (e) {
      console.error('broadcaster error:', e.message);
    }
  }

  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

module.exports = { startBroadcaster };
