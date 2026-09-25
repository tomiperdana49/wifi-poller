'use strict';

const express = require('express');
const q = require('../queries');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({ rssiLemah: q.LEMAH, rssiSangatLemah: q.SANGAT_LEMAH });
});

router.get('/health', async (req, res, next) => {
  try {
    res.json(await q.health());
  } catch (e) {
    next(e);
  }
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
        vendor: req.query.vendor,
        controller: req.query.controller,
        hours: req.query.hours,
        from: req.query.from,
        to: req.query.to,
      })
    );
  } catch (e) {
    next(e);
  }
});

router.get('/problem-aps', async (req, res, next) => {
  try {
    res.json(
      await q.problemAps({
        site: req.query.site,
        band: req.query.band,
        vendor: req.query.vendor,
        controller: req.query.controller,
        hours: req.query.hours,
        from: req.query.from,
        to: req.query.to,
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
