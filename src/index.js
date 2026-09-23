import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import authRouter from './routes/auth.js';
import organizationsRouter from './routes/organizations.js';
import adminRouter from './routes/admin.js';
import { publicRouter as billingPublicRouter, webhookRouter } from './routes/billing.js';
import { purgeExpiredTrials } from './trials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// IMPORTANT: the webhook routes must be mounted BEFORE express.json().
// PayPal verifies a signature against the verbatim request body, so that route
// installs its own express.raw(); if express.json() ran first the stream would
// already be consumed and every signature check would fail.
app.use('/webhooks', webhookRouter);

app.use(express.json({ limit: '2mb' }));

// Static front-end
app.use(express.static(path.join(__dirname, '..', 'public')));

// API
app.use('/auth', authRouter);
app.use('/orgs', organizationsRouter);
app.use('/admin', adminRouter);
app.use('/public/billing', billingPublicRouter);

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/**
 * POST /cron/purge-trials
 * Called by an external cron service on a schedule; once a day is enough.
 * Guarded by the x-cron-secret header rather than a session, because a cron job
 * has no account. Leaving CRON_SECRET unset disables the endpoint entirely.
 */
app.post('/cron/purge-trials', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(404).json({ error: 'Disabled (CRON_SECRET is not set)' });
  if (req.headers['x-cron-secret'] !== secret) return res.status(401).json({ error: 'Wrong secret' });

  try {
    const result = await purgeExpiredTrials();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 for API routes; everything else falls through to the static site
app.use((req, res) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/orgs') || req.path.startsWith('/admin') || req.path.startsWith('/webhooks') || req.path.startsWith('/cron')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'), (err) => {
    if (err) res.status(404).send('Page not found');
  });
});

// Catch-all error handler (for example an over-size upload from multer)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is larger than 25 MB' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
