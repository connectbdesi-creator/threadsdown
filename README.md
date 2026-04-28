# ThreadSave

A free, fast, ad-supported Threads downloader. Paste a public Threads post URL, get the video, image, or carousel. No signup, no app, no watermark.

- **Stack:** Node.js 20 + Express, vanilla HTML/CSS/JS, Cheerio for HTML parsing, Archiver for ZIPs.
- **No build step.** No React. No database. No FFmpeg.
- **Deploys to:** Hostinger VPS (recommended) or Render.com free tier.

---

## Project structure

```
threadsave/
├── server/
│   ├── index.js                # Express app entry
│   ├── routes/
│   │   └── download.js         # /api/info, /api/download, /api/download-zip
│   ├── services/
│   │   └── threads.js          # URL parsing + page fetch + JSON extraction
│   └── middleware/
│       └── rateLimit.js        # IP-based rate limiters
├── public/
│   ├── index.html              # Main page (SEO + UI)
│   ├── privacy.html            # Required by AdSense
│   ├── terms.html
│   ├── robots.txt
│   ├── sitemap.xml
│   ├── favicon.svg
│   ├── css/style.css
│   └── js/app.js
├── ecosystem.config.js         # PM2 config
├── nginx.conf                  # Reverse proxy template
├── Dockerfile                  # For Render.com / any container host
├── .env.example
└── package.json
```

---

## Local development

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# (defaults are fine for local dev)

# 3. Run
npm start
# → http://localhost:3000
```

Test with a real public Threads post URL:

```
https://www.threads.net/@zuck/post/CuZsgfWpf-3
```

(Replace with any current public post — old shortcodes may have been deleted.)

### Test scenarios (Section 3.9 of the SOW)

Before declaring the backend done, manually verify:

1. Public Threads **video** post → preview + Download MP4 works.
2. Public Threads **single image** post → preview + Download Image works.
3. Public Threads **carousel** post (3+ images) → grid renders, individual + ZIP download works.
4. **Text-only** post → friendly "no media" error.
5. **Invalid URL** (e.g. `https://google.com`) → "valid Threads URL" error.
6. **Non-existent** post URL (random shortcode) → 404 error.

---

## Deploying to Hostinger VPS (recommended)

### Prerequisites

- Ubuntu 22.04 LTS VPS (Hostinger KVM 1 — ~$6/mo — is enough for the first ~3,000 daily users)
- A domain pointed at your VPS IP
- Node.js 20 LTS, Nginx, PM2, Certbot installed

```bash
# Install Node 20 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Global tools
npm install -g pm2
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

> **No FFmpeg needed.** Threads serves pre-merged MP4s, so there's nothing to transcode.

### Deploy steps

```bash
# 1. Clone to /var/www/threadsave (or wherever you prefer)
sudo mkdir -p /var/www/threadsave
sudo chown $USER:$USER /var/www/threadsave
git clone <your-repo-url> /var/www/threadsave
cd /var/www/threadsave

# 2. Install production dependencies
npm install --omit=dev

# 3. Create .env (edit as needed)
cp .env.example .env

# 4. Smoke-test before wiring up Nginx
node server/index.js
# Visit http://your-vps-ip:3000 to confirm it boots, then Ctrl+C.

# 5. Configure Nginx
sudo cp nginx.conf /etc/nginx/sites-available/threadsave
sudo sed -i 's/yourdomain.com/REPLACE_WITH_YOUR_DOMAIN/g' /etc/nginx/sites-available/threadsave
sudo ln -s /etc/nginx/sites-available/threadsave /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 6. SSL via Let's Encrypt
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# 7. Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # follow the printed command to enable auto-start on reboot

# 8. Tail logs to verify
pm2 logs threadsave
```

### Updating

```bash
cd /var/www/threadsave
git pull
npm install --omit=dev
pm2 restart threadsave
```

---

## Deploying to Render.com (free tier fallback)

The Dockerfile is ready to go.

### Option A — direct GitHub deploy

1. Push the repo to GitHub.
2. Render dashboard → **New** → **Web Service** → connect your repo.
3. Environment: **Docker**. Render auto-detects the `Dockerfile`.
4. Add the env vars from `.env.example` under **Environment**.
5. Deploy.

### Option B — local Docker test

```bash
docker build -t threadsave .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  threadsave
# → http://localhost:3000
```

> **Free-tier note:** Render free instances spin down after 15 min idle. First request after a cold start takes ~20–30s. Acceptable for early traffic; upgrade to Hostinger KVM 1 once you're past ~300 downloads/day.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `production` | `production` or `development` |
| `RATE_LIMIT_WINDOW_INFO_MS` | `60000` | Window for `/api/info` |
| `RATE_LIMIT_MAX_INFO` | `15` | Max requests/IP/window |
| `RATE_LIMIT_WINDOW_DOWNLOAD_MS` | `600000` | Window for downloads |
| `RATE_LIMIT_MAX_DOWNLOAD` | `10` | Max single-file downloads/IP |
| `RATE_LIMIT_MAX_ZIP` | `3` | Max ZIPs/IP/window |
| `REQUEST_TIMEOUT_MS` | `15000` | Outbound HTTP timeout |
| `MAX_ZIP_SIZE_BYTES` | `104857600` | 100 MB ZIP cap |
| `MAX_INDIVIDUAL_FILE_BYTES` | `20971520` | 20 MB per-file cap inside ZIP |
| `THREADS_USER_AGENT` | Chrome 122 desktop UA | Sent to threads.net |
| `PROXY_URL` | unset | Optional residential proxy (`http://user:pass@host:port`) |

---

## Google AdSense setup

1. Once your site is live with real content (this README + the home page + privacy + terms qualify), apply at <https://adsense.google.com/>.
2. AdSense will give you a verification snippet — paste it into the `<head>` of `public/index.html` (there's a commented placeholder near the top).
3. After approval, replace `ca-pub-XXXXXXXXXXXXXXXX` with your real publisher ID and uncomment the script tag.
4. The page already has three placeholder containers (`#ad-slot-1`, `#ad-slot-2`, `#ad-slot-3`) sized appropriately for both desktop and mobile. Drop in `<ins class="adsbygoogle">` units with `data-ad-format="auto"` and they'll fill those slots.

The CSP in `server/index.js` is already configured to allow Google AdSense and DoubleClick frames.

---

## How the extraction works

Threads has no public download API. Media URLs are pulled from the post page in this order (see `server/services/threads.js`):

1. **`__SSR_DATA__` script tag** — server-rendered JSON blob.
2. **`application/json` script tags** containing `video_versions` / `image_versions2` / `carousel_media`.
3. **Inline scripts** carrying RelayPrefetched JSON — extracted with a balanced-brace scanner.
4. **Open Graph fallback** (`og:video`, `og:image`) for the simplest cases.

Once the JSON is parsed, we use a **recursive `findByKey()` walk** rather than hardcoded paths — Meta A/B-tests their frontend constantly and exact paths shift weekly. Among matched post-shaped objects, we score by `code === shortcode` to pick the requested post (Threads pages often include surrounding feed items).

All extracted URLs are validated against a strict CDN whitelist (`cdninstagram.com`, `fbcdn.net`, `facebook.com`) before being returned or proxied.

### CDN URL expiry

Threads CDN URLs are time-limited (they carry `_nc_oe=` expiry params). The server **never caches** `/api/info` results, and if a download is attempted long after the info call, the user sees a clear "link expired — please refresh" message.

### IP blocking

Meta blocks some datacenter IPs. The service rotates between several realistic browser User-Agents and adds a 200–800 ms random delay between requests. If your VPS IP gets blocked persistently, set `PROXY_URL` to a residential proxy (BrightData, Oxylabs, etc.) — the optional `https-proxy-agent` dependency handles the rest.

---

## API reference

### `POST /api/info`

```json
{ "url": "https://www.threads.net/@user/post/ABC123" }
```

→ Returns `{ success, type, postText, author, thumbnail, media: [...] }` where `type` is `"video"`, `"image"`, or `"carousel"`.

### `GET /api/download?mediaUrl=...&type=video|image&filename=...`

Streams a single file as `attachment`. `mediaUrl` is whitelisted to Meta CDN domains server-side.

### `GET /api/download-zip?urls=<csv>&author=...`

Downloads up to 20 carousel images, streams them into a ZIP archive on the fly. Per-file cap 20 MB, total cap 100 MB.

---

## Operational notes

- **Logs:** PM2 writes to `logs/error.log` and `logs/out.log`. Rotate with `pm2 install pm2-logrotate`.
- **Restarts:** PM2 restarts the app if it exceeds 400 MB resident memory (`max_memory_restart`). It shouldn't get close — there is no disk I/O and ZIP streams are bounded.
- **Health check:** `GET /` returns 200 + the static homepage.
- **Concurrency:** No semaphore needed — every operation is pure HTTP stream proxying. Single PM2 instance is fine up to a few thousand daily users; switch to PM2 cluster mode + Cloudflare in front beyond that.

---

## Scaling roadmap

| Daily users | Setup |
|---|---|
| 0–500 | Render free tier or Hostinger KVM 1 ($6/mo) |
| 500–3,000 | Hostinger KVM 2 ($12/mo) |
| 3,000–15,000 | Hostinger KVM 4 / DigitalOcean droplet, add residential proxy |
| 15,000+ | Cloudflare CDN in front, PM2 cluster mode, optional Redis for rate limit shared state |

---

## License

MIT. Not affiliated with Threads or Meta.
