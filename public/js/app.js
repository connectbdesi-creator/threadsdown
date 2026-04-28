'use strict';

(function () {
  const form = document.getElementById('downloadForm');
  const urlInput = document.getElementById('urlInput');
  const getMediaBtn = document.getElementById('getMediaBtn');

  const errorEl = document.getElementById('error');
  const loaderEl = document.getElementById('loader');
  const resultEl = document.getElementById('result');
  const progressEl = document.getElementById('downloadProgress');

  const thumbnailEl = document.getElementById('thumbnail');
  const badgeEl = document.getElementById('mediaTypeBadge');
  const authorEl = document.getElementById('authorName');
  const postTextEl = document.getElementById('postText');
  const actionsEl = document.getElementById('downloadActions');

  let errorTimer = null;
  let progressTimer = null;

  // ── Helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function isValidThreadsUrl(value) {
    try {
      const u = new URL(value);
      return (
        u.hostname === 'www.threads.net' ||
        u.hostname === 'threads.net' ||
        u.hostname === 'www.threads.com' ||
        u.hostname === 'threads.com'
      );
    } catch {
      return false;
    }
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => errorEl.classList.add('hidden'), 12000);
  }
  function clearError() {
    errorEl.classList.add('hidden');
    if (errorTimer) clearTimeout(errorTimer);
  }

  function showLoader(v) {
    loaderEl.classList.toggle('hidden', !v);
    getMediaBtn.disabled = !!v;
  }
  function hideResult() {
    resultEl.classList.add('hidden');
  }

  function showProgress(msg) {
    progressEl.textContent = msg;
    progressEl.classList.remove('hidden');
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => progressEl.classList.add('hidden'), 14000);
  }
  function hideProgress() {
    progressEl.classList.add('hidden');
    if (progressTimer) clearTimeout(progressTimer);
  }

  // ── Submit handler ───────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    const url = urlInput.value.trim();

    if (!url) {
      showError('Please paste a Threads post URL.');
      return;
    }
    if (!isValidThreadsUrl(url)) {
      showError('Please enter a valid Threads post URL (e.g. threads.net/@user/post/...).');
      return;
    }

    clearError();
    hideResult();
    showLoader(true);

    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      let data = null;
      try { data = await res.json(); } catch {}

      if (!res.ok || !data || data.success === false) {
        const msg = (data && data.error) || `Request failed (${res.status}).`;
        showError(msg);
        return;
      }

      renderResult(data);
    } catch (err) {
      showError(
        err && err.message
          ? `Couldn't reach the server: ${err.message}`
          : "Couldn't reach the server. Please try again."
      );
    } finally {
      showLoader(false);
    }
  }

  form.addEventListener('submit', handleSubmit);
  // Pressing Enter inside the input also triggers submit, since it's a real form.

  // ── Render based on media type ───────────────────────────────────────
  function renderResult(data) {
    const author = data.author ? '@' + data.author : '';
    authorEl.textContent = author;

    const txt = (data.postText || '').trim();
    postTextEl.textContent = txt.length > 160 ? txt.slice(0, 160) + '…' : txt;

    const thumbSrc = data.thumbnail || (data.media && data.media[0] && data.media[0].thumbnail) || (data.media && data.media[0] && data.media[0].url) || '';
    if (thumbSrc) {
      thumbnailEl.src = thumbSrc;
      thumbnailEl.style.visibility = 'visible';
    } else {
      thumbnailEl.removeAttribute('src');
      thumbnailEl.style.visibility = 'hidden';
    }

    if (data.type === 'video') {
      badgeEl.textContent = 'Video';
      badgeEl.className = 'media-badge badge-video';
      actionsEl.innerHTML = renderVideoActions(data.media[0], data.author);
    } else if (data.type === 'image') {
      badgeEl.textContent = 'Image';
      badgeEl.className = 'media-badge badge-image';
      actionsEl.innerHTML = renderSingleImageActions(data.media[0], data.author);
    } else if (data.type === 'carousel') {
      badgeEl.textContent = data.media.length + ' Items';
      badgeEl.className = 'media-badge badge-carousel';
      actionsEl.innerHTML = renderCarouselActions(data);
    } else {
      showError('Unknown media type returned.');
      return;
    }

    resultEl.classList.remove('hidden');
    attachDownloadListeners(data);
  }

  function fileBaseName(author, suffix) {
    const safe = (author || 'post').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'post';
    return suffix ? `${safe}-${suffix}` : safe;
  }

  function renderVideoActions(media, author) {
    const fname = fileBaseName(author, 'video');
    return `
      <button class="btn-download btn-primary" type="button"
        data-action="download-single"
        data-url="${encodeURIComponent(media.url)}"
        data-type="video"
        data-filename="${escapeHtml(fname)}">
        Download MP4
      </button>`;
  }

  function renderSingleImageActions(media, author) {
    const fname = fileBaseName(author, 'image');
    return `
      <button class="btn-download btn-primary" type="button"
        data-action="download-single"
        data-url="${encodeURIComponent(media.url)}"
        data-type="image"
        data-filename="${escapeHtml(fname)}">
        Download Image
      </button>`;
  }

  function renderCarouselActions(data) {
    const urlList = data.media.map((m) => encodeURIComponent(m.url)).join(',');
    const author = data.author || '';

    const tiles = data.media
      .map((m, i) => {
        const idx = i + 1;
        const isVideo = m.type === 'video';
        const fname = fileBaseName(author, (isVideo ? 'video-' : 'image-') + idx);
        const thumb = m.thumbnail || m.url;
        return `
          <div class="carousel-item">
            <img src="${escapeHtml(thumb)}" alt="${isVideo ? 'Video' : 'Image'} ${idx}" referrerpolicy="no-referrer" />
            <button class="btn-download btn-sm" type="button"
              data-action="download-single"
              data-url="${encodeURIComponent(m.url)}"
              data-type="${isVideo ? 'video' : 'image'}"
              data-filename="${escapeHtml(fname)}">
              Download
            </button>
          </div>`;
      })
      .join('');

    return `
      <div class="carousel-grid">${tiles}</div>
      <button class="btn-download btn-primary btn-zip" type="button"
        data-action="download-zip"
        data-urls="${urlList}"
        data-author="${escapeHtml(author)}">
        Download All as ZIP (${data.media.length} items)
      </button>`;
  }

  // ── Download trigger ─────────────────────────────────────────────────
  function attachDownloadListeners() {
    actionsEl.querySelectorAll('[data-action="download-single"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const params = new URLSearchParams({
          mediaUrl: decodeURIComponent(btn.dataset.url),
          type: btn.dataset.type,
          filename: btn.dataset.filename
        });
        triggerDownload(
          `/api/download?${params.toString()}`,
          btn.dataset.filename || 'threadsave',
          'Preparing your download…'
        );
      });
    });

    const zipBtn = actionsEl.querySelector('[data-action="download-zip"]');
    if (zipBtn) {
      zipBtn.addEventListener('click', () => {
        const params = new URLSearchParams({
          urls: zipBtn.dataset.urls,
          author: zipBtn.dataset.author
        });
        triggerDownload(
          `/api/download-zip?${params.toString()}`,
          `${zipBtn.dataset.author || 'threadsave'}-carousel.zip`,
          'Creating ZIP file…'
        );
      });
    }
  }

  // Use a programmatic anchor click — same-origin Content-Disposition: attachment
  // makes the browser stream the download without navigating away. Works on
  // desktop, Android Chrome, and iOS Safari.
  //
  // Before triggering, we issue a HEAD-like fetch to detect JSON error responses
  // (rate limit, expired CDN URL, etc.) so we can surface the actual error to
  // the user instead of silently triggering a useless download.
  async function triggerDownload(url, suggestedName, msg) {
    showProgress(msg || 'Preparing your download…');
    try {
      const probe = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });

      if (!probe.ok) {
        let errMsg = `Download failed (${probe.status}).`;
        try {
          const data = await probe.json();
          if (data && data.error) errMsg = data.error;
        } catch {}
        hideProgress();
        showError(errMsg);
        return;
      }

      const ct = (probe.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        let errMsg = 'Download failed.';
        try {
          const data = await probe.json();
          if (data && data.error) errMsg = data.error;
        } catch {}
        hideProgress();
        showError(errMsg);
        return;
      }

      // Cancel the probe stream so we don't waste bandwidth — browser will refetch via the anchor.
      try { probe.body && probe.body.cancel && probe.body.cancel(); } catch {}
    } catch (err) {
      // Network error before the server even responded; still try the anchor.
    }

    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.download = suggestedName || '';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      hideProgress();
    }, 4000);
  }
})();
