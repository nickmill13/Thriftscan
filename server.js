const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// eBay OAuth token cache — keyed by scope
// ================================================================
const ebayTokens = {};

async function getEbayToken(scope) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    throw new Error('eBay credentials not configured');
  }
  if (ebayTokens[scope] && ebayTokens[scope].expires_at > Date.now() + 60_000) {
    return ebayTokens[scope].access_token;
  }
  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + creds,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay OAuth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  ebayTokens[scope] = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return ebayTokens[scope].access_token;
}

const SCOPE_BROWSE   = 'https://api.ebay.com/oauth/api_scope';
const SCOPE_INSIGHTS = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';

// ================================================================
// POST /api/lookup — Google Books + Open Library for specific titles
// ================================================================
app.post('/api/lookup', async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: 'barcode required' });

  try {
    let data = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(barcode)}&maxResults=1`
    ).then((r) => r.json());

    if (!data.totalItems) {
      data = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(barcode)}&maxResults=1`
      ).then((r) => r.json());
    }

    if (data.totalItems > 0) {
      const vol = data.items[0].volumeInfo;
      const isIsbn13 = /^97[89]\d{10}$/.test(barcode);

      if (!vol.subtitle && isIsbn13) {
        try {
          const olBook = await fetch(
            `https://openlibrary.org/isbn/${barcode}.json`
          ).then((r) => r.json());

          if (olBook?.title) {
            console.log('Open Library:', olBook.title, '|', olBook.subtitle || '(no subtitle)');
            if (olBook.title.length > vol.title.length) vol.title = olBook.title;
            if (olBook.subtitle) vol.subtitle = olBook.subtitle;
          }
        } catch (e) { /* silent */ }
      }

      console.log('Final title:', vol.title, '|', vol.subtitle || '(no subtitle)');
    }

    res.json(data);
  } catch (err) {
    console.error('Books lookup error:', err.message);
    res.status(502).json({ error: 'Books lookup failed', message: err.message });
  }
});

// ================================================================
// POST /api/ebay-price
//   1. Marketplace Insights API — sold listings (modern, preferred)
//   2. Browse API               — active listings, outliers trimmed (fallback)
// ================================================================
app.post('/api/ebay-price', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  if (!process.env.EBAY_CLIENT_ID) {
    return res.status(503).json({ error: 'eBay not configured on server' });
  }

  console.log('eBay price lookup:', query);

  // ── 1. Marketplace Insights (sold listings) ──────────────────────────────
  try {
    const token = await getEbayToken(SCOPE_INSIGHTS);

    const params = new URLSearchParams({
      q: query,
      category_ids: '267',
      filter: 'conditions:{USED|VERY_GOOD|GOOD|ACCEPTABLE|LIKE_NEW},price:[0.50..100],priceCurrency:USD',
      sort: '-lastSoldDate',
      limit: '20',
    });

    const r = await fetch(
      `https://api.ebay.com/buy/marketplace_insights/v1_beta/item_summary/search?${params}`,
      { headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
    );

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Insights API ${r.status}: ${errText.slice(0, 200)}`);
    }

    const data = await r.json();
    const items = data.itemSummaries || [];
    console.log(`Insights sold (${items.length}):`, items.map(i => i.price?.value));

    if (items.length > 0) {
      data.source = 'sold';
      return res.json(data);
    }
    throw new Error('Insights API returned 0 results');
  } catch (err) {
    console.warn('Insights API failed, falling back to Browse:', err.message);
  }

  // ── 2. Browse API fallback (active listings, outliers trimmed) ───────────
  try {
    const token = await getEbayToken(SCOPE_BROWSE);

    const params = new URLSearchParams({
      q: query,
      category_ids: '267',
      filter: 'price:[0.50..100],priceCurrency:USD,conditions:{USED|VERY_GOOD|GOOD|ACCEPTABLE|LIKE_NEW},buyingOptions:{FIXED_PRICE|AUCTION}',
      limit: '20',
    });

    const r = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      { headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }
    );
    if (!r.ok) throw new Error(`Browse API ${r.status}`);

    const data = await r.json();

    // Trim top 25% by price to remove expensive outliers (hardcovers, new copies
    // that slipped through, etc.) — leaves the realistic used paperback range
    const sorted = (data.itemSummaries || [])
      .filter(i => parseFloat(i.price?.value || 0) > 0)
      .sort((a, b) => parseFloat(a.price.value) - parseFloat(b.price.value));
    const trimCount = Math.ceil(sorted.length * 0.25);
    data.itemSummaries = sorted.slice(0, sorted.length - trimCount);
    data.source = 'active';

    console.log(`Browse active trimmed (${data.itemSummaries.length}):`,
      data.itemSummaries.map(i => i.price?.value));

    return res.json(data);
  } catch (err) {
    if (err.message.includes('not configured')) {
      return res.status(503).json({ error: 'eBay not configured on server' });
    }
    console.error('Browse API failed:', err.message);
    res.status(502).json({ error: 'eBay lookup failed', message: err.message });
  }
});

// ================================================================
// POST /api/ai-analysis — Claude AI book resale analysis
// ================================================================
app.post('/api/ai-analysis', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI not configured on server' });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const text = await aiRes.text();
      console.error(`Anthropic API failed (${aiRes.status}):`, text);
      return res.status(aiRes.status).json({ error: 'AI request failed' });
    }

    const data = await aiRes.json();
    res.json(data);
  } catch (err) {
    console.error('AI analysis error:', err.message);
    res.status(502).json({ error: 'AI analysis failed', message: err.message });
  }
});

// ================================================================
// Start server
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ThriftScan running on http://localhost:${PORT}`);
  console.log(`  eBay: ${process.env.EBAY_CLIENT_ID ? '✓ configured' : '✗ not set (heuristic fallback)'}`);
  console.log(`  AI:   ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ not set'}`);
});
