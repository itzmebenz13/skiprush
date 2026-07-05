const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'skiprush-proxy', engine: 'puppeteer' });
});

app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const page = await browser.newPage();

    // Block unnecessary resources to speed things up
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Track all navigation URLs
    const chain = [];
    let currentUrl = url;

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const newUrl = frame.url();
        if (newUrl && newUrl !== 'about:blank' && newUrl !== currentUrl) {
          chain.push({ from: currentUrl, to: newUrl, method: 'navigation' });
          currentUrl = newUrl;
        }
      }
    });

    // Go to the URL
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Strategy: override timers to speed things up, then interact with the page
    // Kill all countdown timers by setting them to 0
    await page.evaluate(() => {
      // Speed up all setTimeouts and setIntervals
      const originalSetTimeout = window.setTimeout;
      const originalSetInterval = window.setInterval;
      window.setTimeout = (fn, delay, ...args) => originalSetTimeout(fn, Math.min(delay, 100), ...args);
      window.setInterval = (fn, delay, ...args) => originalSetInterval(fn, Math.min(delay, 100), ...args);

      // Force any countdown variables to 0
      const globals = Object.keys(window);
      for (const key of globals) {
        if (/count|timer|second|wait|delay/i.test(key) && typeof window[key] === 'number') {
          window[key] = 0;
        }
      }

      // Click all visible buttons/links that might be the "continue" or "skip" button
      // after a short delay to let timers fire
    });

    // Wait for timers to fire with our accelerated timing
    await new Promise(r => setTimeout(r, 3000));

    // Try to find and click continue/skip/get-link buttons
    const clickSelectors = [
      'a[class*="download"]', 'a[class*="skip"]', 'a[class*="continue"]',
      'a[class*="get-link"]', 'a[class*="go-link"]', 'a[class*="btn-download"]',
      'a[class*="bypass"]', 'a[class*="direct"]',
      'button[class*="download"]', 'button[class*="skip"]', 'button[class*="continue"]',
      'button[class*="get-link"]', 'button[class*="go-link"]',
      'a[id*="download"]', 'a[id*="skip"]', 'a[id*="continue"]',
      'a[id*="link"]', 'a[id*="btn"]',
      '#btn-main', '#skip', '#continue', '#download', '#get-link',
      '.btn-primary', '.download-btn', '.skip-btn',
      'a[href]:not([href="#"]):not([href^="javascript"])',
    ];

    for (const selector of clickSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          const isVisible = await el.evaluate(node => {
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          });
          if (isVisible) {
            await el.click();
            await new Promise(r => setTimeout(r, 2000));
            // Check if we navigated
            const newUrl = page.url();
            if (newUrl !== currentUrl && newUrl !== 'about:blank') {
              currentUrl = newUrl;
              break;
            }
          }
        }
      } catch {}
    }

    // Wait a bit more for any final redirects
    await new Promise(r => setTimeout(r, 2000));

    // Check if there were further navigations
    const finalUrl = page.url();
    if (finalUrl !== currentUrl) {
      chain.push({ from: currentUrl, to: finalUrl, method: 'navigation' });
      currentUrl = finalUrl;
    }

    // If we're still on a shortener/redirect page, try one more round
    if (currentUrl.includes('adlinkfly') || currentUrl.includes('short') || currentUrl.includes('link')) {
      await page.evaluate(() => {
        window.setTimeout = (fn, delay, ...args) => window.originalSetTimeout?.(fn, 0, ...args) || fn();
      });
      await new Promise(r => setTimeout(r, 3000));

      // Try clicking again
      for (const selector of clickSelectors.slice(0, -1)) {
        try {
          const el = await page.$(selector);
          if (el) {
            const isVisible = await el.evaluate(node => {
              const style = window.getComputedStyle(node);
              return style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (isVisible) {
              await el.click();
              await new Promise(r => setTimeout(r, 2000));
              break;
            }
          }
        } catch {}
      }
    }

    const ultimateFinal = page.url();
    if (ultimateFinal !== currentUrl) {
      chain.push({ from: currentUrl, to: ultimateFinal, method: 'navigation' });
    }

    await browser.close();

    res.json({
      success: true,
      finalUrl: ultimateFinal,
      hops: chain.length,
      chain,
      redirected: chain.length > 0,
    });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: e.message || 'Crawl failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SkipRush proxy (Puppeteer) on port ${PORT}`));
