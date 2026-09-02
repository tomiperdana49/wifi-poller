'use strict';

const express = require('express');
const q = require('../queries');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({ rssiLemah: q.LEMAH, rssiSangatLemah: q.SANGAT_LEMAH });
});

router.get('/overview', async (req, res, next) => {
  try {
    res.json(await q.overview());
  } catch (e) {
    next(e);
  }
});

router.get('/clients', async (req, res, next) => {
  try {
    res.json(await q.liveClients());
  } catch (e) {
    next(e);
  }
});

router.get('/aps', async (req, res, next) => {
  try {
    res.json(await q.apSummary());
  } catch (e) {
    next(e);
  }
});

router.get('/ap-list', async (req, res, next) => {
  try {
    res.json(await q.apList());
  } catch (e) {
    next(e);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    res.json(
      await q.history({
        site: req.query.site,
        apName: req.query.ap,
        hours: req.query.hours,
      })
    );
  } catch (e) {
    next(e);
  }
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

module.exports = router;
