'use strict';

const rateLimit = require('express-rate-limit');

const tooMany = (req, res) => {
  res.status(429).json({
    success: false,
    error: 'Too many requests. Please wait a moment and try again.'
  });
};

const baseOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany
};

const infoLimiter = rateLimit({
  ...baseOpts,
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_INFO_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_INFO, 10) || 15
});

const downloadLimiter = rateLimit({
  ...baseOpts,
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_DOWNLOAD_MS, 10) || 600_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_DOWNLOAD, 10) || 10
});

const zipLimiter = rateLimit({
  ...baseOpts,
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_DOWNLOAD_MS, 10) || 600_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_ZIP, 10) || 3
});

module.exports = { infoLimiter, downloadLimiter, zipLimiter };
