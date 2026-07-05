const express = require('express');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'skiprush-proxy' });
});

// --- URL Extraction Logic (server-side) ---

const BLOCKED = [
  'doubleclick.net','googlesyndication.com','googleadservices.com',
  'facebook.com/tr','analytics.google.com','adnxs.com',
  'amazon-adsystem.com','taboola.com','outbrain.com',
  'fonts.googleapis.com','fonts.gstatic.com','schema.org',
  'cdn.jsdelivr.net','cdnjs.cloudflare.com','w3.org'
];

const ASSET_EXT = ['.css','.js','.png','.jpg','.jpeg','.gif','.svg','.woff','.woff2','.ico','.webp'];

function isBlocked(url) {
  const lower = url.toLowerCase();
  return BLOCKED.some(d => lower.includes(d)) ||
    ASSET_EXT.some(ext => lower.split('?')[0].split('#')[0].endsWith(ext));
}

function isValidUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function isDifferent(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.origin + ua.pathname !== ub.origin + ub.pathname;
  } catch { return a !== b; }
}

function extractUrlFromHtml(html, sourceUrl) {
  // 1. Meta refresh
  const metaMatch = html.match(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"';\s>]+)/i);
  if (metaMatch && isValidUrl(metaMatch[1]) && !isBlocked(metaMatch[1])) return metaMatch[1];

  // 2. JS redirects
  const jsPatterns = [
    /window\.location\.href\s*=\s*['"]([^'"]+)['"]/g,
    /window\.location\s*=\s*['"]([^'"]+)['"]/g,
    /location\.href\s*=\s*['"]([^'"]+)['"]/g,
    /location\.replace\(\s*['"]([^'"]+)['"]\s*\)/g,
    /location\.assign\(\s*['"]([^'"]+)['"]\s*\)/g,
    /top\.location\s*=\s*['"]([^'"]+)['"]/g,
    /self\.location\s*=\s*['"]([^'"]+)['"]/g,
    /document\.location\s*=\s*['"]([^'"]+)['"]/g,
    /window\.open\(\s*['"]([^'"]+)['"]/g,
  ];
  const jsUrls = [];
  for (const p of jsPatterns) {
    let m;
    while ((m = p.exec(html)) !== null) {
      if (isValidUrl(m[1]) && !isBlocked(m[1]) && isDifferent(m[1], sourceUrl)) jsUrls.push(m[1]);
    }
  }
  if (jsUrls.length) return jsUrls[jsUrls.length - 1];

  // 3. setTimeout with URL
  const stPatterns = [
    /setTimeout\s*\(\s*function\s*\(\)\s*\{[^}]*?(?:window\.location|location\.href|location\.replace|location\.assign)\s*[=(]\s*['"]([^'"]+)['"]/gs,
    /setTimeout\s*\([^)]*['"]([^'"]*https?:\/\/[^'"]+)['"]/g,
  ];
  for (const p of stPatterns) {
    let m;
    while ((m = p.exec(html)) !== null) {
      if (isValidUrl(m[1]) && !isBlocked(m[1]) && isDifferent(m[1], sourceUrl)) return m[1];
    }
  }

  // 4. Hidden data / JSON keys
  const jsonPattern = /["'](?:url|href|link|redirect|destination|target|file_url|download_url|final_url|go|out|next)["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi;
  let jm;
  while ((jm = jsonPattern.exec(html)) !== null) {
    if (isValidUrl(jm[1]) && !isBlocked(jm[1]) && isDifferent(jm[1], sourceUrl)) return jm[1];
  }

  // 5. Links with target class/text
  const linkPattern = /<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const targetWords = ['download','skip','continue','direct','bypass','get-link','go-link','destination','final','proceed','click-here','btn-download'];
  let lm;
  const allLinks = [];
  while ((lm = linkPattern.exec(html)) !== null) {
    const href = lm[1];
    if (!href || href === '#' || href.startsWith('javascript:')) continue;
    const fullUrl = href.startsWith('http') ? href : (() => { try { return new URL(href, sourceUrl).href; } catch { return null; } })();
    if (!fullUrl || !isValidUrl(fullUrl) || isBlocked(fullUrl) || !isDifferent(fullUrl, sourceUrl)) continue;

    const context = lm[0].toLowerCase();
    const isTarget = targetWords.some(w => context.includes(w));
    if (isTarget) return fullUrl;
    allLinks.push(fullUrl);
  }

  // 6. Form action
  const formMatch = html.match(/<form[^>]*action\s*=\s*["']([^"']+)["']/i);
  if (formMatch) {
    const action = formMatch[1];
    const full = action.startsWith('http') ? action : (() => { try { return new URL(action, sourceUrl).href; } catch { return null; } })();
    if (full && isValidUrl(full) && !isBlocked(full) && isDifferent(full, sourceUrl)) return full;
  }

  // 7. Base64 encoded
  const b64Pattern = /atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/g;
  let bm;
  while ((bm = b64Pattern.exec(html)) !== null) {
    try {
      const decoded = Buffer.from(bm[1], 'base64').toString('utf8');
      if (isValidUrl(decoded) && !isBlocked(decoded) && isDifferent(decoded, sourceUrl)) return decoded;
    } catch {}
  }

  // 8. Return first external link as fallback
  if (allLinks.length) return allLinks[0];

  return null;
}

// --- Recursive Crawl ---

async function crawlChain(startUrl, maxDepth = 10) {
  const chain = [];
  let currentUrl = startUrl;
  const visited = new Set();

  for (let depth = 0; depth < maxDepth; depth++) {
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': currentUrl,
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // If server redirected to a different URL, record it
      if (response.redirected && isDifferent(response.url, currentUrl)) {
        chain.push({ from: currentUrl, to: response.url, method: 'http-redirect' });
        currentUrl = response.url;
        if (visited.has(currentUrl)) break;
        visited.add(currentUrl);
      }

      const html = await response.text();
      const extracted = extractUrlFromHtml(html, currentUrl);

      if (extracted && isDifferent(extracted, currentUrl) && !visited.has(extracted)) {
        chain.push({ from: currentUrl, to: extracted, method: 'html-extract' });
        currentUrl = extracted;
      } else {
        // No more redirects found, this is the final URL
        break;
      }
    } catch (e) {
      // If fetch fails on an intermediate hop, stop here
      break;
    }
  }

  return {
    finalUrl: currentUrl,
    chain,
    hops: chain.length,
  };
}

// --- Proxy Endpoint ---

app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  try {
    const result = await crawlChain(url, 10);

    res.json({
      success: true,
      finalUrl: result.finalUrl,
      hops: result.hops,
      chain: result.chain,
      redirected: result.hops > 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Crawl failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SkipRush proxy running on port ${PORT}`));
