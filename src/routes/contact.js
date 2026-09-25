import express from 'express';
import { supabase } from '../supabaseClient.js';
import { logEvent } from '../logger.js';
import { requireAuth, requireSystemAdmin } from '../auth.js';

/**
 * The contact form on the marketing site.
 *
 * The form is served from botclarify.com (a static site) and posts here, to
 * app.botclarify.com. That is a cross-origin request, so this file owns a small
 * CORS allow-list — and because the endpoint takes writes from anyone on the
 * internet with no account behind them, it also owns the limits that keep the
 * table from becoming a spam bucket.
 */

// =====================================================================
// PUBLIC — no authentication. Everything below assumes a hostile caller.
// =====================================================================
export const publicRouter = express.Router();

/**
 * Origins allowed to post the form.
 *
 * An allow-list rather than "*", because a wildcard here would let any page on
 * the internet post to this endpoint from a visitor's browser. The site's own
 * domains are built in; CONTACT_ALLOWED_ORIGINS adds more, comma-separated,
 * for a preview deployment or a renamed domain.
 *
 * Adding an origin here is only half the job: the site's own
 * Content-Security-Policy in site/_headers has to name this API in connect-src,
 * or the browser blocks the request before it is ever sent and the form shows a
 * plain network error with nothing to explain it.
 */
const BUILT_IN_ORIGINS = [
  'https://botclarify.com',
  'https://www.botclarify.com',
  'https://app.botclarify.com',
];

function allowedOrigins() {
  const extra = String(process.env.CONTACT_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return [...BUILT_IN_ORIGINS, ...extra];
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  // Set on every answer, allowed or not. Setting it only on the allowed branch
  // left the refusals uncacheable-by-origin, so an intermediary keyed on URL
  // and method alone could hand a cached "Access-Control-Allow-Origin:
  // https://botclarify.com" to a completely different site.
  res.setHeader('Vary', 'Origin');
  if (origin && allowedOrigins().includes(origin.replace(/\/$/, ''))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return true;
  }
  return false;
}

publicRouter.options('/', (req, res) => {
  applyCors(req, res);
  res.status(204).end();
});

const LIMITS = { name: 120, email: 200, company: 160, message: 5000 };

// How many messages one address may send in an hour. Generous for a person
// with a follow-up thought, tight enough that a script gets nowhere.
const PER_IP_PER_HOUR = 5;
const PER_IP_PER_DAY = 20;

/**
 * The caller's address, for rate limiting only — never for deciding who
 * somebody is.
 *
 * x-forwarded-for is a list that each proxy APPENDS to. The leftmost entry is
 * therefore whatever the client sent, which a caller can simply make up: an
 * earlier version of this read that entry, so anyone could have had a fresh
 * rate-limit bucket on every request by sending a different value each time,
 * and the limit — the only thing standing between this endpoint and a flood —
 * did nothing at all.
 *
 * The trustworthy entry is the one the nearest proxy we control appended,
 * counted from the RIGHT. With one proxy in front (Render's load balancer,
 * which is the current deployment) that is the last entry. Set
 * CONTACT_PROXY_HOPS if the number of proxies ever changes; too high a value
 * starts trusting the client again, so it is deliberately explicit rather than
 * guessed.
 */
function clientIp(req) {
  const hops = Math.max(1, parseInt(process.env.CONTACT_PROXY_HOPS || '1', 10) || 1);
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // chain.length - hops is the address the outermost proxy we trust observed.
  // If the chain is shorter than the hop count the header was not written by
  // the proxies we expect, so fall back to the socket rather than to a value
  // the caller chose.
  const picked = chain.length >= hops ? chain[chain.length - hops] : null;
  return (picked || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Deliberately loose. The point is to catch a typo, not to decide which
 * addresses are real — every stricter pattern in circulation rejects some
 * valid address, and the cost of that is a customer we never hear from.
 */
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/** POST /public/contact — one message from the marketing site. */
publicRouter.post('/', async (req, res) => {
  applyCors(req, res);
  try {
    const body = req.body || {};

    // A hidden field no human ever sees. Anything filled in here came from a
    // program that fills every input it finds. Answered with the same success
    // the form shows a person, so the bot has nothing to learn from retrying.
    if (clean(body.website, 200)) {
      await logEvent({ level: 'warn', scope: 'contact', message: 'Dropped a contact message that filled the honeypot field' });
      return res.json({ ok: true });
    }

    const name = clean(body.name, LIMITS.name);
    const email = clean(body.email, LIMITS.email).toLowerCase();
    const company = clean(body.company, LIMITS.company);
    // Only the message keeps its line breaks — it is the one field where they
    // carry meaning.
    const message = String(body.message ?? '').replace(/\r\n/g, '\n').trim().slice(0, LIMITS.message);

    if (!name) return res.status(400).json({ error: 'Please tell us your name.' });
    if (!looksLikeEmail(email)) return res.status(400).json({ error: 'Please check the email address.' });
    if (message.length < 10) return res.status(400).json({ error: 'Please tell us a little more — at least a sentence.' });

    const ip = clientIp(req);

    if (ip) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [{ count: lastHour }, { count: lastDay }] = await Promise.all([
        supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', hourAgo),
        supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', dayAgo),
      ]);
      if ((lastHour || 0) >= PER_IP_PER_HOUR || (lastDay || 0) >= PER_IP_PER_DAY) {
        await logEvent({ level: 'warn', scope: 'contact', message: `Rate-limited a contact message from ${ip}` });
        // 429 with no detail about which window was hit: a sender learning the
        // exact shape of the limit is the first step to working around it.
        return res.status(429).json({ error: 'Too many messages from this connection. Please email info@botclarify.com instead.' });
      }
    }

    const { data, error } = await supabase
      .from('contact_messages')
      .insert({ name, email, company: company || null, message, ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) })
      .select('id')
      .single();
    if (error) throw error;

    await logEvent({ scope: 'contact', message: `New contact message from ${email}`, detail: { id: data.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('contact error:', err);
    // The sender is told the send failed, not why. The detail is in the log.
    res.status(500).json({ error: 'We could not send your message. Please try again, or email info@botclarify.com.' });
  }
});

// =====================================================================
// SYSTEM ADMIN — the inbox
// =====================================================================
const router = express.Router();
router.use(requireAuth, requireSystemAdmin);

/** GET /admin/contact?status=new|read|archived|spam|all */
router.get('/', async (req, res) => {
  try {
    let query = supabase
      .from('contact_messages')
      .select('id, name, email, company, message, status, created_at, read_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(200);

    const status = req.query.status;
    if (status && status !== 'all') query = query.eq('status', status);

    const [{ data, error }, { count: unread }] = await Promise.all([
      query,
      supabase.from('contact_messages').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    ]);
    if (error) throw error;

    res.json({ items: data || [], unread: unread || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/contact/unread — just the badge count. */
router.get('/unread', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('contact_messages').select('id', { count: 'exact', head: true }).eq('status', 'new');
    if (error) throw error;
    res.json({ unread: count || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const STATUSES = ['new', 'read', 'archived', 'spam'];

/** PATCH /admin/contact/:id { status } */
router.patch('/:id', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });

    const patch = { status };
    // Reading is recorded once. Re-opening a message later should not rewrite
    // who saw it first.
    if (status !== 'new') {
      const { data: before } = await supabase.from('contact_messages').select('read_at').eq('id', req.params.id).maybeSingle();
      if (before && !before.read_at) {
        patch.read_at = new Date().toISOString();
        patch.read_by = req.user.id;
      }
    } else {
      patch.read_at = null;
      patch.read_by = null;
    }

    const { data, error } = await supabase
      .from('contact_messages').update(patch).eq('id', req.params.id)
      // Same projection as the list: the address and user-agent are kept for
      // rate limiting, not for reading, so they do not travel to the browser.
      .select('id, name, email, company, message, status, created_at, read_at').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /admin/contact/:id */
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('contact_messages').delete().eq('id', req.params.id);
    if (error) throw error;
    await logEvent({ scope: 'contact', userId: req.user.id, message: `Deleted contact message ${req.params.id}` });
    res.json({ message: 'Message deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
