/**
 * PropPulse Proxy Server
 * 
 * This server acts as a secure intermediary between the Chrome extension and BatchData.
 * The API key is stored server-side only and never exposed to the client.
 * 
 * Deploy to: Vercel, Heroku, AWS Lambda, or your own server
 * Environment Variable: BATCHDATA_API_KEY=your_key_here
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BATCHDATA_API_KEY = process.env.BATCHDATA_API_KEY;
const BATCHDATA_API_URL = 'https://api.batchdata.com/api/v1/property/skip-trace';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// CORS: Allow requests from the Chrome extension
const corsOptions = {
  origin: (origin, callback) => {
    // Allow all origins (extension can come from any user's browser)
    // In production, you might want to add additional security checks
    callback(null, true);
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
  maxAge: 3600
};
app.use(cors(corsOptions));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const status = BATCHDATA_API_KEY ? 'ok' : 'error';
  res.status(status === 'ok' ? 200 : 500).json({
    status,
    message: status === 'ok' ? 'Proxy server is running' : 'API key not configured'
  });
});

// ─── Skip Trace Proxy Endpoint ────────────────────────────────────────────────
app.post('/api/skip-trace', async (req, res) => {
  try {
    // Validate API key is configured
    if (!BATCHDATA_API_KEY) {
      console.error('[PropPulse Proxy] API key not configured');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: API key not set'
      });
    }

    // Extract address from request
    const { street, city, state, zip } = req.body;

    // Validate required fields
    if (!street || !city || !state || !zip) {
      console.warn('[PropPulse Proxy] Missing required address fields:', {
        street: !!street,
        city: !!city,
        state: !!state,
        zip: !!zip
      });
      return res.status(400).json({
        success: false,
        message: 'Missing required address fields: street, city, state, zip'
      });
    }

    console.log('[PropPulse Proxy] Processing skip trace for:', { street, city, state, zip });

    // Call BatchData API with the hidden key
    const response = await fetch(BATCHDATA_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            propertyAddress: { street, city, state, zip }
          }
        ]
      })
    });

    // Handle HTTP errors from BatchData
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[PropPulse Proxy] BatchData API error: HTTP ${response.status}`, errorText);

      if (response.status === 401) {
        return res.status(500).json({
          success: false,
          message: 'Server error: Invalid API credentials'
        });
      }
      if (response.status === 403) {
        return res.status(500).json({
          success: false,
          message: 'Server error: API key not authorized'
        });
      }

      return res.status(response.status).json({
        success: false,
        message: `BatchData API error: ${response.statusText}`
      });
    }

    // Parse BatchData response
    const data = await response.json();
    console.log('[PropPulse Proxy] BatchData response received');

    // Extract and format the owner information
    const persons = data?.results?.persons;
    if (!persons || persons.length === 0) {
      console.warn('[PropPulse Proxy] No persons found in BatchData response');
      return res.status(200).json({
        success: false,
        message: data?.status?.message || 'No owner information found for this property'
      });
    }

    // Use first matched person or first in list
    const person = persons[0];
    if (!person) {
      console.error('[PropPulse Proxy] Person record is null');
      return res.status(200).json({
        success: false,
        message: 'No valid person record found'
      });
    }

    // ── Extract owner name ──────────────────────────────────────────────────
    const nameObj = person.name || person?.property?.owner?.name || {};
    const ownerName = [nameObj.first, nameObj.last]
      .filter(Boolean)
      .join(' ')
      .trim() || 'N/A';

    // ── Extract phone numbers ───────────────────────────────────────────────
    const phones = (person.phoneNumbers || []).filter(p => p?.number);
    let phoneList = [];
    if (phones.length > 0) {
      const sorted = [...phones].sort((a, b) => {
        const aIsMobile = (a.type || '').toLowerCase().includes('mobile') ? 0 : 1;
        const bIsMobile = (b.type || '').toLowerCase().includes('mobile') ? 0 : 1;
        if (aIsMobile !== bIsMobile) return aIsMobile - bIsMobile;
        const aScore = parseInt(a.score) || 0;
        const bScore = parseInt(b.score) || 0;
        if (aScore !== bScore) return bScore - aScore;
        return (b.reachable ? 1 : 0) - (a.reachable ? 1 : 0);
      });
      phoneList = sorted.slice(0, 3).map(p => ({
        number: formatPhone(p.number),
        type: p.type || 'Unknown',
        reachable: p.reachable === true,
        score: parseInt(p.score) || 0
      }));
    }

    // ── Extract mailing address ────────────────────────────────────────────
    let mailObj = person.mailingAddress;
    if (!mailObj || !mailObj.street) {
      mailObj = person?.property?.owner?.mailingAddress || {};
    }
    let mailingAddress = 'N/A';
    if (mailObj && mailObj.street) {
      const parts = [
        mailObj.street,
        mailObj.city,
        mailObj.state,
        mailObj.zip
      ].filter(Boolean);
      if (parts.length > 0) {
        mailingAddress = parts.join(', ');
      }
    }

    // ── Extract emails ─────────────────────────────────────────────────────
    const emails = (person.emails || [])
      .map(e => e.email || e)
      .filter(Boolean)
      .slice(0, 2);

    console.log('[PropPulse Proxy] Successfully extracted owner info:', {
      ownerName,
      phoneCount: phoneList.length,
      emailCount: emails.length
    });

    // Return formatted response to extension
    res.json({
      success: true,
      data: {
        ownerName,
        phoneList,
        mailingAddress,
        emails,
        propertyAddress: `${street}, ${city}, ${state} ${zip}`
      }
    });

  } catch (error) {
    console.error('[PropPulse Proxy] Unexpected error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error: ' + (error.message || 'Unknown error')
    });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[PropPulse Proxy] Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[PropPulse Proxy] Server running on port ${PORT}`);
  console.log(`[PropPulse Proxy] API key configured: ${BATCHDATA_API_KEY ? 'Yes' : 'No'}`);
  console.log(`[PropPulse Proxy] Health check: GET /health`);
  console.log(`[PropPulse Proxy] Skip trace endpoint: POST /api/skip-trace`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)})`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)})`;
  }
  return String(raw);
}

module.exports = app;
