const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// eBay OAuth token cache (client credentials flow)
// ================================================================
let ebayToken = null;

async function getEbayToken() {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    throw new Error('eBay credentials not configured');
  }

  // Reuse valid token (expire 1 min early for safety)
  if (ebayToken && ebayToken.expires_at > Date.now() + 60_000) {
    return ebayToken.access_token;
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
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay OAuth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  ebayToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return ebayToken.access_token;
}

// ================================================================
// POST /api/lookup — Google Books by barcode/ISBN
// ================================================================
app.post('/api/lookup', async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: 'barcode required' });

  try {
    // Try ISBN lookup first (most accurate for books)
    let data = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(barcode)}&maxResults=1`
    ).then((r) => r.json());

    if (!data.totalItems) {
      data = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(barcode)}&maxResults=1`
      ).then((r) => r.json());
    }

    res.json(data);
  } catch (err) {
    console.error('Books lookup error:', err.message);
    res.status(502).json({ error: 'Books lookup failed', message: err.message });
  }
});

// ================================================================
// POST /api/ebay-price — eBay Browse API (active used listings)
// ================================================================
app.post('/api/ebay-price', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const token = await getEbayToken();

    const params = new URLSearchParams({
      q: query,
      category_ids: '267', // Books category
      filter: 'conditions:{USED|VERY_GOOD|GOOD|ACCEPTABLE|LIKE_NEW},buyingOptions:{FIXED_PRICE|AUCTION}',
      sort: '-price',
      limit: '10',
    });

    const ebayRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      }
    );

    if (!ebayRes.ok) {
      const text = await ebayRes.text();
      console.error(`eBay search failed (${ebayRes.status}):`, text);
      return res.status(ebayRes.status).json({ error: 'eBay search failed' });
    }

    const data = await ebayRes.json();
    res.json(data);
  } catch (err) {
    if (err.message.includes('not configured')) {
      return res.status(503).json({ error: 'eBay not configured on server' });
    }
    console.error('eBay price error:', err.message);
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
