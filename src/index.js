import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import authRouter from './routes/auth.js';
import organizationsRouter from './routes/organizations.js';
import adminRouter from './routes/admin.js';
import { publicRouter as billingPublicRouter, webhookRouter } from './routes/billing.js';
import contactRouter, { publicRouter as contactPublicRouter } from './routes/contact.js';
import v1Router from './routes/v1.js';
import { purgeExpiredTrials } from './trials.js';
import { supabase } from './supabaseClient.js';

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
// The marketing site is a different origin, so this router handles its own CORS.
app.use('/public/contact', contactPublicRouter);
app.use('/admin/contact', contactRouter);

// The public API. Authenticated by API key rather than by session, so it is
// mounted at the top level and shares nothing with the browser routes.
app.use('/v1', v1Router);

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
    // Contact housekeeping rides along: it clears the IP addresses kept for
    // rate limiting once they are 30 days old, and drops messages marked as
    // spam. A failure here must not fail the trial purge, which is the part
    // that deletes customer data on a promise.
    // supabase-js resolves with { data, error } rather than rejecting, so the
    // error has to be read: wrapping this in try/catch alone left a
    // permanently failing cleanup reporting null for ever, with nothing said.
    const { data: contactData, error: contactError } = await supabase.rpc('cleanup_contact_messages');
    if (contactError) console.error('contact cleanup failed:', contactError.message);
    const contact = contactError
      ? { error: contactError.message }
      : (Array.isArray(contactData) ? contactData[0] : contactData);

    // API usage rows older than 13 months. Thirteen so a customer can still
    // compare this month against the same month a year ago.
    const { data: apiRows, error: apiError } = await supabase.rpc('cleanup_api_usage');
    if (apiError) console.error('api usage cleanup failed:', apiError.message);

    // A reservation whose request died before it could be closed out would
    // otherwise count against the customer's allowance for the rest of the
    // month.
    const { data: stale, error: staleError } = await supabase.rpc('sweep_stale_api_reservations');
    if (staleError) console.error('api reservation sweep failed:', staleError.message);

    res.json({
      ...result,
      contact,
      api_usage_deleted: apiError ? null : Number(apiRows || 0),
      api_reservations_swept: staleError ? null : Number(stale || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 for API routes; everything else falls through to the static site
app.use((req, res) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/orgs') || req.path.startsWith('/admin') || req.path.startsWith('/webhooks') || req.path.startsWith('/cron') || req.path.startsWith('/public/') || req.path.startsWith('/v1')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'), (err) => {
    if (err) res.status(404).send('Page not found');
  });
});

// Catch-all error handler (for example an over-size upload from multer)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const status = err?.status || err?.statusCode || 500;

  // The API promises that every error has the same shape, with a stable code.
  // Anything that lands here — a malformed JSON body most of all — has to keep
  // that promise, or a client parsing the documented shape breaks on the one
  // response it was least expecting.
  if (req.path.startsWith('/v1')) {
    const code = status === 400 ? 'malformed_request' : status === 413 ? 'payload_too_large' : 'internal_error';
    const message = status === 400
      ? 'The request body could not be read as JSON.'
      : status === 413
        ? 'The request body is too large.'
        : 'The request could not be completed. Please try again.';
    return res.status(status === 500 ? 500 : status).json({ error: { code, message } });
  }

  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is larger than 25 MB' });
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
