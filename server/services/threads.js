'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const FALLBACK_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0'
];

const META_CDN_DOMAINS = [
  'cdninstagram.com',
  'fbcdn.net',
  'facebook.com'
];

const THREADS_HOSTS = new Set([
  'www.threads.net',
  'threads.net',
  'www.threads.com',
  'threads.com'
]);

class ThreadsError extends Error {
  constructor(message, code = 'THREADS_ERROR', status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function pickUserAgent() {
  const configured = process.env.THREADS_USER_AGENT || DEFAULT_USER_AGENT;
  const pool = [configured, ...FALLBACK_USER_AGENTS];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildAxiosConfig() {
  const config = {
    headers: {
      'User-Agent': pickUserAgent(),
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0'
    },
    timeout: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500
  };

  if (process.env.PROXY_URL) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL);
      config.proxy = false;
    } catch (e) {
      // optional dep not installed; silently fall back to direct connection
    }
  }

  return config;
}

// ── URL parsing ────────────────────────────────────────────────────────────
function parseThreadsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 500) {
    throw new ThreadsError('Please enter a valid Threads post URL.', 'INVALID_URL', 400);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ThreadsError('Please enter a valid Threads post URL.', 'INVALID_URL', 400);
  }

  if (!THREADS_HOSTS.has(parsed.hostname)) {
    throw new ThreadsError(
      'Please enter a valid Threads post URL (threads.net or threads.com).',
      'INVALID_URL',
      400
    );
  }

  // Strip query and fragment, normalize trailing slash
  const path = parsed.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);

  let username = null;
  let shortcode = null;

  // Format: /@username/post/<shortcode> or /@username/post/<shortcode>/
  const postIdx = segments.indexOf('post');
  if (postIdx !== -1 && segments[postIdx + 1]) {
    shortcode = segments[postIdx + 1];
    if (postIdx > 0 && segments[postIdx - 1].startsWith('@')) {
      username = segments[postIdx - 1].slice(1);
    }
  } else if (segments[0] === 't' && segments[1]) {
    // Format: /t/<shortcode>
    shortcode = segments[1];
  }

  if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) {
    throw new ThreadsError(
      'Could not find a post ID in this URL. Make sure you copied the full link.',
      'INVALID_URL',
      400
    );
  }

  const canonical = username
    ? `https://www.threads.net/@${username}/post/${shortcode}`
    : `https://www.threads.net/t/${shortcode}`;

  return { canonical, username, shortcode };
}

// ── Recursive JSON search (resilient to schema changes) ────────────────────
function findByKey(obj, targetKey, results = [], depth = 0) {
  if (depth > 80 || obj == null || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    for (const item of obj) findByKey(item, targetKey, results, depth + 1);
  } else {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (key === targetKey) results.push(val);
      else findByKey(val, targetKey, results, depth + 1);
    }
  }
  return results;
}

// ── CDN URL whitelist ──────────────────────────────────────────────────────
function isValidMetaCdnUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  try {
    const { hostname } = new URL(url);
    return META_CDN_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith('.' + d)
    );
  } catch {
    return false;
  }
}

// ── Fetch the post page ────────────────────────────────────────────────────
async function fetchPostHtml(canonicalUrl) {
  // Random small delay to soften rate-limit risk on bursts
  const delay = 200 + Math.random() * 600;
  await new Promise((r) => setTimeout(r, delay));

  let response;
  try {
    response = await axios.get(canonicalUrl, buildAxiosConfig());
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new ThreadsError('Request timed out. Please try again.', 'TIMEOUT', 504);
    }
    throw new ThreadsError(
      'Could not reach Threads. Please try again in a moment.',
      'NETWORK',
      502
    );
  }

  if (response.status === 404) {
    throw new ThreadsError(
      'This post is private or no longer exists.',
      'NOT_FOUND',
      404
    );
  }
  if (response.status === 429) {
    throw new ThreadsError(
      'Threads is temporarily blocking this request. Please try again in 30 seconds.',
      'RATE_LIMITED',
      503
    );
  }
  if (response.status >= 400) {
    throw new ThreadsError(
      'Could not fetch this Threads post. Please try again.',
      'FETCH_FAILED',
      502
    );
  }

  const html = typeof response.data === 'string' ? response.data : '';
  if (!html) {
    throw new ThreadsError(
      'Empty response from Threads. Please try again.',
      'EMPTY_RESPONSE',
      502
    );
  }

  // Login wall detection (Threads serves the login page with status 200)
  if (
    html.includes('Log in to Threads') ||
    html.includes('"loginButton"') ||
    /Log in &middot; Threads/i.test(html)
  ) {
    throw new ThreadsError(
      'This post requires login. Only public posts are supported.',
      'LOGIN_REQUIRED',
      403
    );
  }

  return html;
}

// ── Extract candidate JSON blobs from the HTML ─────────────────────────────
function extractJsonCandidates(html) {
  const $ = cheerio.load(html);
  const candidates = [];

  // Location A: explicit __SSR_DATA__ script
  const ssrEl = $('script#__SSR_DATA__').first();
  if (ssrEl.length) {
    const txt = ssrEl.contents().text();
    if (txt) candidates.push(txt);
  }

  // Location B: any application/json script that mentions media keys
  $('script[type="application/json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (
      txt &&
      (txt.includes('video_versions') ||
        txt.includes('image_versions2') ||
        txt.includes('carousel_media') ||
        txt.includes('"video_url"'))
    ) {
      candidates.push(txt);
    }
  });

  // Location B2: inline script tags carrying ScheduledServerJS / RelayPrefetched data
  $('script').each((_, el) => {
    const type = $(el).attr('type');
    if (type && type !== 'application/json' && type !== 'text/javascript') return;
    const txt = $(el).contents().text();
    if (!txt) return;
    if (
      txt.includes('"video_versions"') ||
      txt.includes('"image_versions2"') ||
      txt.includes('"carousel_media"')
    ) {
      // These scripts often wrap JSON inside JS; extract the largest balanced object/array
      const extracted = extractJsonBlobs(txt);
      candidates.push(...extracted);
    }
  });

  return { $, candidates };
}

// Pull plausible JSON sub-strings out of an arbitrary script body.
// Scans for `{` / `[` and extracts balanced sections, skipping strings.
function extractJsonBlobs(text) {
  const blobs = [];
  const open = '{[';
  const close = '}]';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (open.indexOf(c) === -1) continue;
    const start = i;
    const stack = [c];
    let inString = false;
    let strQuote = '';
    let j = i + 1;
    while (j < text.length && stack.length) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === strQuote) inString = false;
      } else {
        if (ch === '"' || ch === "'") {
          inString = true;
          strQuote = ch;
        } else if (open.indexOf(ch) !== -1) {
          stack.push(ch);
        } else if (close.indexOf(ch) !== -1) {
          const top = stack[stack.length - 1];
          if ((top === '{' && ch === '}') || (top === '[' && ch === ']')) {
            stack.pop();
          } else {
            // Mismatched; abandon this candidate
            break;
          }
        }
      }
      j++;
    }
    if (!stack.length && j - start > 200) {
      blobs.push(text.slice(start, j));
      i = j; // skip ahead to avoid quadratic re-scan
      if (blobs.length > 6) break;
    }
  }
  return blobs;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Pull the highest-quality URL from an image_versions2 candidates list ───
function pickBestImageFromCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const valid = candidates.filter(
    (c) => c && typeof c.url === 'string' && isValidMetaCdnUrl(c.url)
  );
  if (!valid.length) return null;
  return valid.reduce((best, curr) =>
    (curr.width || 0) > (best.width || 0) ? curr : best
  );
}

function pickBestVideoFromVersions(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const valid = versions.filter(
    (v) => v && typeof v.url === 'string' && isValidMetaCdnUrl(v.url)
  );
  if (!valid.length) return null;
  // Prefer highest bandwidth/width if present; otherwise first.
  return valid.reduce((best, curr) => {
    const bScore = (best.width || 0) + (best.bandwidth || 0) / 1000;
    const cScore = (curr.width || 0) + (curr.bandwidth || 0) / 1000;
    return cScore > bScore ? curr : best;
  });
}

// ── Walk a single carousel item to one media descriptor ────────────────────
function carouselItemToMedia(item) {
  if (!item || typeof item !== 'object') return null;

  // Direct video_versions on the item
  const directVideos = Array.isArray(item.video_versions) ? item.video_versions : null;
  if (directVideos) {
    const best = pickBestVideoFromVersions(directVideos);
    if (best) {
      const thumb = pickBestImageFromCandidates(item?.image_versions2?.candidates);
      return {
        type: 'video',
        url: best.url,
        thumbnail: thumb?.url || null,
        width: best.width || null,
        height: best.height || null
      };
    }
  }

  // Direct image_versions2 on the item
  const directImage = pickBestImageFromCandidates(item?.image_versions2?.candidates);
  if (directImage) {
    return {
      type: 'image',
      url: directImage.url,
      thumbnail: directImage.url,
      width: directImage.width || null,
      height: directImage.height || null
    };
  }

  // Fallback: nested video_url anywhere in the item
  const nestedVideoUrls = findByKey(item, 'video_url').filter(isValidMetaCdnUrl);
  if (nestedVideoUrls.length) {
    return {
      type: 'video',
      url: nestedVideoUrls[0],
      thumbnail: null,
      width: null,
      height: null
    };
  }

  return null;
}

// ── Find the top-level "post" object that matches the requested shortcode ──
// Threads pages often include the requested post AND surrounding feed items.
// We score every candidate post-shaped object and pick the one whose code/pk
// best matches the shortcode, falling back to the first post with media.
function findTargetPost(roots, shortcode) {
  const seen = new Set();
  const posts = [];

  function visit(node, depth) {
    if (depth > 80 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const looksLikePost =
      ('video_versions' in node && Array.isArray(node.video_versions)) ||
      ('image_versions2' in node && node.image_versions2 && Array.isArray(node.image_versions2.candidates)) ||
      ('carousel_media' in node && Array.isArray(node.carousel_media));

    if (looksLikePost) posts.push(node);

    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  }

  for (const root of roots) visit(root, 0);

  if (!posts.length) return null;

  // Score by shortcode match first
  const scored = posts.map((p) => {
    let score = 0;
    if (shortcode) {
      if (typeof p.code === 'string' && p.code === shortcode) score += 100;
      if (typeof p.pk === 'string' && p.pk.includes(shortcode)) score += 50;
    }
    // Prefer posts with carousel or video over plain image to break ties
    if (Array.isArray(p.carousel_media)) score += 5;
    if (Array.isArray(p.video_versions) && p.video_versions.length) score += 3;
    return { post: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].post;
}

// ── Open Graph / meta tag fallback ─────────────────────────────────────────
function metaFallback($, shortcode) {
  const ogVideo = $('meta[property="og:video"]').attr('content') ||
                  $('meta[property="og:video:secure_url"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogDescription = $('meta[property="og:description"]').attr('content') || '';

  const author =
    (ogTitle.match(/^@?([A-Za-z0-9_.]+)\s+on\s+Threads/i) || [])[1] || null;

  if (ogVideo && isValidMetaCdnUrl(ogVideo)) {
    return {
      success: true,
      type: 'video',
      postText: ogDescription,
      author,
      shortcode,
      thumbnail: isValidMetaCdnUrl(ogImage) ? ogImage : null,
      media: [
        {
          type: 'video',
          url: ogVideo,
          thumbnail: isValidMetaCdnUrl(ogImage) ? ogImage : null,
          width: null,
          height: null
        }
      ]
    };
  }

  if (ogImage && isValidMetaCdnUrl(ogImage)) {
    return {
      success: true,
      type: 'image',
      postText: ogDescription,
      author,
      shortcode,
      thumbnail: ogImage,
      media: [
        { type: 'image', url: ogImage, thumbnail: ogImage, width: null, height: null }
      ]
    };
  }

  return null;
}

// ── Main entry point ───────────────────────────────────────────────────────
async function getPostInfo(rawUrl) {
  const { canonical, username, shortcode } = parseThreadsUrl(rawUrl);
  const html = await fetchPostHtml(canonical);
  const { $, candidates } = extractJsonCandidates(html);

  // Parse every candidate; keep what parses
  const parsedRoots = [];
  for (const text of candidates) {
    const parsed = tryParse(text);
    if (parsed) parsedRoots.push(parsed);
  }

  let post = parsedRoots.length ? findTargetPost(parsedRoots, shortcode) : null;

  // Build the response from the located post
  if (post) {
    const result = postToResult(post, username, shortcode);
    if (result && result.media.length > 0) return result;
  }

  // Fallback to OG meta tags
  const og = metaFallback($, shortcode);
  if (og) {
    if (!og.author && username) og.author = username;
    return og;
  }

  // Determine if it's a text-only post vs an extraction failure.
  // If the page rendered fine but we found no media keys at all, treat as text-only.
  const hasAnyMediaKey =
    /"video_versions"|"image_versions2"|"carousel_media"/.test(html);
  if (!hasAnyMediaKey) {
    throw new ThreadsError(
      "This post is text-only. Only posts with videos or images can be downloaded.",
      'NO_MEDIA',
      400
    );
  }

  throw new ThreadsError(
    'Could not extract media from this post. Threads may have updated their format.',
    'EXTRACTION_FAILED',
    422
  );
}

function postToResult(post, fallbackAuthor, shortcode) {
  // Extract caption text
  let postText = '';
  const caption = post.caption;
  if (caption && typeof caption === 'object' && typeof caption.text === 'string') {
    postText = caption.text;
  } else if (typeof post.caption_text === 'string') {
    postText = post.caption_text;
  } else if (post.text_post_app_info && typeof post.text_post_app_info.text_fragments === 'object') {
    const frags = findByKey(post.text_post_app_info, 'plaintext');
    if (frags.length) postText = frags.join(' ');
  }

  // Extract author
  let author = fallbackAuthor || null;
  const userObj = post.user || (caption && caption.user) || null;
  if (userObj && typeof userObj.username === 'string') {
    author = userObj.username;
  }

  // Carousel?
  if (Array.isArray(post.carousel_media) && post.carousel_media.length > 0) {
    const media = [];
    post.carousel_media.forEach((item, i) => {
      const m = carouselItemToMedia(item);
      if (m) media.push({ ...m, index: i + 1 });
    });
    if (media.length === 0) return null;

    // If carousel has only one media item, treat as single
    if (media.length === 1) {
      const only = media[0];
      return {
        success: true,
        type: only.type,
        postText,
        author,
        shortcode,
        thumbnail: only.thumbnail || only.url,
        media: [only]
      };
    }

    return {
      success: true,
      type: 'carousel',
      postText,
      author,
      shortcode,
      thumbnail: media[0].thumbnail || media[0].url,
      media
    };
  }

  // Single video
  if (Array.isArray(post.video_versions) && post.video_versions.length > 0) {
    const best = pickBestVideoFromVersions(post.video_versions);
    if (best) {
      const thumb = pickBestImageFromCandidates(post?.image_versions2?.candidates);
      return {
        success: true,
        type: 'video',
        postText,
        author,
        shortcode,
        thumbnail: thumb?.url || null,
        media: [
          {
            type: 'video',
            url: best.url,
            thumbnail: thumb?.url || null,
            width: best.width || null,
            height: best.height || null
          }
        ]
      };
    }
  }

  // Single image
  const bestImage = pickBestImageFromCandidates(post?.image_versions2?.candidates);
  if (bestImage) {
    return {
      success: true,
      type: 'image',
      postText,
      author,
      shortcode,
      thumbnail: bestImage.url,
      media: [
        {
          type: 'image',
          url: bestImage.url,
          thumbnail: bestImage.url,
          width: bestImage.width || null,
          height: bestImage.height || null
        }
      ]
    };
  }

  return null;
}

module.exports = {
  ThreadsError,
  parseThreadsUrl,
  isValidMetaCdnUrl,
  getPostInfo,
  // exported for testing
  _internal: { findByKey, extractJsonBlobs, pickBestImageFromCandidates, pickBestVideoFromVersions }
};
