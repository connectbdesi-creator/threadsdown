'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const downloadRoutes = require('./routes/download');
const { ThreadsError } = require('./services/threads');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://pagead2.googlesyndication.com',
          'https://www.googletagservices.com',
          'https://adservice.google.com'
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ['*', 'data:', 'blob:'],
        mediaSrc: ['*', 'blob:'],
        connectSrc: ["'self'", 'https://pagead2.googlesyndication.com'],
        frameSrc: [
          "'self'",
          'https://googleads.g.doubleclick.net',
          'https://tpc.googlesyndication.com'
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// API routes
app.use('/api', downloadRoutes);

// Static files (serve robots.txt, sitemap.xml, css, js, images, index.html)
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      // CSS/JS get a 1-day cache (long enough to be CDN-friendly, short enough
      // that hard-refresh recovers from a bad deploy). Versioned ?v=N query
      // strings on the <link>/<script> tags handle aggressive busting.
      if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
      } else if (/\.(png|jpg|jpeg|svg|webp|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000');
      } else if (/\.html$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    }
  })
);

// 404 for anything not matched (after static)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res
      .status(404)
      .json({ success: false, error: 'Endpoint not found.' });
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Centralised error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return; // streaming endpoints handle their own errors

  if (err instanceof ThreadsError) {
    return res
      .status(err.status || 500)
      .json({ success: false, error: err.message, code: err.code });
  }

  if (err && err.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ success: false, error: 'Request body too large.' });
  }

  console.error('[unhandled]', err && err.stack ? err.stack : err);
  res.status(500).json({
    success: false,
    error: 'Something went wrong. Please try again.'
  });
});

app.listen(PORT, () => {
  console.log(
    `[threadsave] listening on :${PORT} (${process.env.NODE_ENV || 'development'})`
  );
});
