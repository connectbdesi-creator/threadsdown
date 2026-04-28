'use strict';

const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const { PassThrough } = require('stream');

const { getPostInfo, isValidMetaCdnUrl, ThreadsError } = require('../services/threads');
const { infoLimiter, downloadLimiter, zipLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15000;
const MAX_ZIP_SIZE_BYTES = parseInt(process.env.MAX_ZIP_SIZE_BYTES, 10) || 104_857_600;
const MAX_FILE_BYTES = parseInt(process.env.MAX_INDIVIDUAL_FILE_BYTES, 10) || 20_971_520;

const CDN_REQUEST_HEADERS = {
  'User-Agent':
    process.env.THREADS_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.threads.net/'
};

function sanitizeFilename(name, fallback) {
  if (typeof name !== 'string') name = '';
  const cleaned = name.replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 60);
  return cleaned || fallback;
}

function extensionForType(type, contentType) {
  if (type === 'video') {
    if (contentType && contentType.includes('quicktime')) return 'mov';
    return 'mp4';
  }
  if (type === 'image') {
    if (contentType && contentType.includes('png')) return 'png';
    if (contentType && contentType.includes('webp')) return 'webp';
    return 'jpg';
  }
  return 'bin';
}

// ── POST /api/info ─────────────────────────────────────────────────────────
router.post('/info', infoLimiter, async (req, res, next) => {
  try {
    const { url } = req.body || {};
    const result = await getPostInfo(url);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/download ──────────────────────────────────────────────────────
router.get('/download', downloadLimiter, async (req, res, next) => {
  const { mediaUrl, type, filename } = req.query;

  if (!mediaUrl || typeof mediaUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing media URL.' });
  }
  if (mediaUrl.length > 2000) {
    return res.status(400).json({ success: false, error: 'Media URL too long.' });
  }
  if (!isValidMetaCdnUrl(mediaUrl)) {
    return res.status(400).json({ success: false, error: 'Invalid media URL.' });
  }
  if (type !== 'video' && type !== 'image') {
    return res.status(400).json({ success: false, error: 'Invalid media type.' });
  }

  const safeName = sanitizeFilename(filename, type === 'video' ? 'video' : 'image');

  let upstream;
  try {
    upstream = await axios.get(mediaUrl, {
      responseType: 'stream',
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      headers: CDN_REQUEST_HEADERS,
      validateStatus: (s) => s < 500
    });
  } catch (err) {
    return next(
      new ThreadsError(
        'Could not fetch the media file. Please try again.',
        'CDN_FETCH_FAILED',
        502
      )
    );
  }

  if (upstream.status === 403 || upstream.status === 410) {
    upstream.data?.destroy?.();
    return next(
      new ThreadsError(
        'The media link has expired. Please refresh and try again.',
        'CDN_EXPIRED',
        410
      )
    );
  }
  if (upstream.status >= 400) {
    upstream.data?.destroy?.();
    return next(
      new ThreadsError(
        'Could not fetch the media file. Please try again.',
        'CDN_FETCH_FAILED',
        502
      )
    );
  }

  const ext = extensionForType(type, upstream.headers['content-type']);
  const fullName = `threadsave-${safeName}.${ext}`;

  res.setHeader(
    'Content-Type',
    upstream.headers['content-type'] || (type === 'video' ? 'video/mp4' : 'application/octet-stream')
  );
  if (upstream.headers['content-length']) {
    res.setHeader('Content-Length', upstream.headers['content-length']);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${fullName}"`);
  res.setHeader('Cache-Control', 'no-store');

  upstream.data.on('error', () => {
    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.destroy();
    }
  });

  req.on('close', () => {
    upstream.data?.destroy?.();
  });

  upstream.data.pipe(res);
});

// ── GET /api/download-zip ──────────────────────────────────────────────────
router.get('/download-zip', zipLimiter, async (req, res, next) => {
  const { urls, author } = req.query;

  if (!urls || typeof urls !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing URLs.' });
  }

  const list = urls.split(',').map((u) => decodeURIComponent(u)).filter(Boolean);
  if (list.length === 0) {
    return res.status(400).json({ success: false, error: 'No URLs provided.' });
  }
  if (list.length > 20) {
    return res.status(400).json({ success: false, error: 'Too many files (max 20).' });
  }

  for (const u of list) {
    if (u.length > 2000 || !isValidMetaCdnUrl(u)) {
      return res.status(400).json({ success: false, error: 'Invalid media URL in list.' });
    }
  }

  const safeAuthor = sanitizeFilename(author, 'carousel');
  const zipName = `threadsave-${safeAuthor}-carousel.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Cache-Control', 'no-store');

  const archive = archiver('zip', { zlib: { level: 6 } });
  let totalBytes = 0;
  let aborted = false;

  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[zip] warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[zip] error:', err.message);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });

  archive.pipe(res);

  req.on('close', () => {
    aborted = true;
    archive.abort?.();
  });

  try {
    for (let i = 0; i < list.length; i++) {
      if (aborted) break;
      const url = list[i];
      let upstream;
      try {
        upstream = await axios.get(url, {
          responseType: 'stream',
          timeout: REQUEST_TIMEOUT_MS,
          maxRedirects: 5,
          headers: CDN_REQUEST_HEADERS,
          validateStatus: (s) => s < 500
        });
      } catch (err) {
        // Skip individual failures and continue
        archive.append(`Failed to fetch image ${i + 1}: network error.\n`, {
          name: `failed-${i + 1}.txt`
        });
        continue;
      }

      if (upstream.status >= 400) {
        upstream.data?.destroy?.();
        archive.append(`Failed to fetch image ${i + 1}: HTTP ${upstream.status}.\n`, {
          name: `failed-${i + 1}.txt`
        });
        continue;
      }

      const ct = upstream.headers['content-type'] || '';
      const ext = extensionForType('image', ct);
      const declared = parseInt(upstream.headers['content-length'], 10) || 0;

      if (declared && declared > MAX_FILE_BYTES) {
        upstream.data.destroy();
        archive.append(`Image ${i + 1} skipped (file exceeds 20MB limit).\n`, {
          name: `skipped-${i + 1}.txt`
        });
        continue;
      }
      if (declared && totalBytes + declared > MAX_ZIP_SIZE_BYTES) {
        upstream.data.destroy();
        archive.append(`Image ${i + 1} skipped (ZIP would exceed 100MB total).\n`, {
          name: `skipped-${i + 1}.txt`
        });
        continue;
      }

      // Wrap stream to enforce per-file & total caps even when CDN omits Content-Length
      let fileBytes = 0;
      const limited = new PassThrough();
      upstream.data.on('data', (chunk) => {
        fileBytes += chunk.length;
        totalBytes += chunk.length;
        if (fileBytes > MAX_FILE_BYTES || totalBytes > MAX_ZIP_SIZE_BYTES) {
          upstream.data.destroy();
          limited.end();
        }
      });
      upstream.data.on('error', () => limited.destroy());
      upstream.data.pipe(limited);

      archive.append(limited, { name: `threadsave-${i + 1}.${ext}` });

      // Wait for this entry to finish before starting the next (preserves order, avoids
      // archiver accumulating large in-memory buffers when streams stall).
      await new Promise((resolve) => limited.on('end', resolve).on('close', resolve));
    }

    if (!aborted) await archive.finalize();
  } catch (err) {
    if (!res.headersSent) next(err);
    else res.destroy();
  }
});

module.exports = router;
