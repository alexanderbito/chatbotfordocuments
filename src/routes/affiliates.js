import crypto from 'crypto';
import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireSystemAdmin } from '../auth.js';
import { logEvent } from '../logger.js';

/**
 * The affiliate programme.
 *
 * An affiliate is a PERSON, not an organization: the money is paid to somebody,
 * and one person may administer several organizations. Taking part requires an
 * account AND a paying organization, checked at enrolment and again whenever
 * the page is opened — somebody whose subscription lapses stops being an
 * affiliate until it comes back.
 */

const SITE_URL = process.env.SITE_URL || 'https://botclarify.com';

/** Commission rates. Repeated in record_commission; stated here for display. */
export const RATES = { monthly: 0.20, yearly: 0.30 };

/**
 * A code that goes in a URL and gets read aloud over the phone.
 *
 * No vowels, so no code accidentally spells a word; no 0/O or 1/l/I, which are
 * the characters people mistype when copying from a screenshot.
 */
const ALPHABET = 'bcdfghjkmnpqrstvwxyz23456789';

function randomCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Does this person run an organization that is actually paying? */
async function hasPaidOrganization(userId) {
  const { data: memberships } = await supabase
    .from('organization_members')
    .select('organization_id, role, status')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .neq('status', 'disabled');

  const ids = (memberships || []).map((m) => m.organization_id);
  if (!ids.length) return false;

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, billing_status, status, plan_expires_at, plan:plans(price_usd)')
    .in('id', ids);

  const now = Date.now();
  return (orgs || []).some((o) =>
    o.billing_status === 'paid'
    && o.status !== 'suspended'
    && Number(o.plan?.price_usd || 0) > 0
    && (!o.plan_expires_at || new Date(o.plan_expires_at).getTime() > now));
}

// =====================================================================
// PUBLIC — resolving a referral code. No account needed.
// =====================================================================
export const publicRouter = express.Router();

/**
 * GET /public/affiliate/:code
 *
 * Answers only whether the code is usable. It deliberately does not say who it
 * belongs to: the code appears in links posted publicly, and turning one into
 * a name and an email address is not something a stranger should be able to do.
 */
publicRouter.get('/:code', async (req, res) => {
  const code = String(req.params.code || '').toLowerCase().slice(0, 32);
  const { data } = await supabase
    .from('affiliates').select('id, status').eq('code', code).maybeSingle();
  res.json({ valid: !!data && data.status === 'active' });
});

// =====================================================================
// SIGNED IN — the affiliate's own pages
// =====================================================================
const router = express.Router();
router.use(requireAuth);

/** GET /affiliate — enrolment state, link, earnings, referrals. */
router.get('/', async (req, res) => {
  try {
    const { data: affiliate } = await supabase
      .from('affiliates')
      .select('id, code, paypal_email, status, created_at')
      .eq('user_id', req.user.id)
      .maybeSingle();

    const eligible = await hasPaidOrganization(req.user.id);

    if (!affiliate) {
      return res.json({
        enrolled: false,
        eligible,
        rates: RATES,
        // Said plainly rather than left for the person to work out from a
        // disabled button.
        reason: eligible ? null : 'The affiliate programme is open to customers on a paid plan.',
      });
    }

    const [{ data: balance }, { data: referrals }, { data: payouts }] = await Promise.all([
      supabase.rpc('affiliate_balance', { p_affiliate_id: affiliate.id }),
      supabase
        .from('referrals')
        .select('organization_id, referred_at, first_paid_at, organization:organizations(name)')
        .eq('affiliate_id', affiliate.id)
        .order('referred_at', { ascending: false })
        .limit(200),
      supabase
        .from('affiliate_payouts')
        .select('id, amount, currency, method, reference, paid_at')
        .eq('affiliate_id', affiliate.id)
        .order('paid_at', { ascending: false })
        .limit(50),
    ]);

    const { data: commissions } = await supabase
      .from('commissions')
      .select('id, amount, currency, billing_cycle, rate, status, available_at, created_at')
      .eq('affiliate_id', affiliate.id)
      .order('created_at', { ascending: false })
      .limit(100);

    const b = Array.isArray(balance) ? balance[0] : balance;

    res.json({
      enrolled: true,
      eligible,
      rates: RATES,
      affiliate: { ...affiliate, link: `${SITE_URL}/?ref=${affiliate.code}` },
      balance: {
        pending: Number(b?.pending_amount || 0),
        available: Number(b?.available_amount || 0),
        paid: Number(b?.paid_amount || 0),
        referred: Number(b?.referred_count || 0),
        paying: Number(b?.paying_count || 0),
      },
      // Only the customer's NAME is shown to the affiliate. Which plan they are
      // on and what they pay is the customer's business, not the referrer's;
      // the commission amount already tells the affiliate what they earned.
      referrals: (referrals || []).map((r) => ({
        name: r.organization?.name || 'A company',
        referred_at: r.referred_at,
        paying: !!r.first_paid_at,
      })),
      commissions: commissions || [],
      payouts: payouts || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /affiliate/join { paypal_email } */
router.post('/join', async (req, res) => {
  try {
    const { data: existing } = await supabase
      .from('affiliates').select('id').eq('user_id', req.user.id).maybeSingle();
    if (existing) return res.status(400).json({ error: 'You are already in the affiliate programme.' });

    if (!(await hasPaidOrganization(req.user.id))) {
      return res.status(403).json({
        error: 'The affiliate programme is open to customers on a paid plan. Upgrade your organization first.',
      });
    }

    const paypalEmail = String(req.body?.paypal_email || '').trim().toLowerCase().slice(0, 200);
    if (paypalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(paypalEmail)) {
      return res.status(400).json({ error: 'Please check the PayPal email address.' });
    }

    // Retried rather than assumed unique: the alphabet is small enough that a
    // collision is possible, and the database is the only thing that can say
    // for certain.
    let created = null;
    for (let attempt = 0; attempt < 6 && !created; attempt++) {
      const code = randomCode(8);
      const { data, error } = await supabase
        .from('affiliates')
        .insert({ user_id: req.user.id, code, paypal_email: paypalEmail || null })
        .select('id, code, paypal_email, status, created_at')
        .maybeSingle();
      if (!error) { created = data; break; }
      if (error.code !== '23505') throw error;
    }
    if (!created) return res.status(500).json({ error: 'Could not allocate a referral code. Please try again.' });

    await logEvent({ scope: 'billing', userId: req.user.id, message: `Joined the affiliate programme as ${created.code}` });
    res.json({ ...created, link: `${SITE_URL}/?ref=${created.code}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /affiliate { paypal_email } — where the money should go. */
router.patch('/', async (req, res) => {
  try {
    const paypalEmail = String(req.body?.paypal_email || '').trim().toLowerCase().slice(0, 200);
    if (paypalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(paypalEmail)) {
      return res.status(400).json({ error: 'Please check the PayPal email address.' });
    }
    const { data, error } = await supabase
      .from('affiliates')
      .update({ paypal_email: paypalEmail || null })
      .eq('user_id', req.user.id)
      .select('id, code, paypal_email, status')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'You are not in the affiliate programme.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// =====================================================================
// SYSTEM ADMIN — seeing everything, and paying people
// =====================================================================
export const adminRouter = express.Router();
adminRouter.use(requireAuth, requireSystemAdmin);

/** GET /admin/affiliates */
adminRouter.get('/', async (req, res) => {
  try {
    const { data: affiliates, error } = await supabase
      .from('affiliates')
      .select('id, user_id, code, paypal_email, status, created_at, user:app_users(email, full_name)')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // One balance per affiliate. Read from the same function the affiliate's
    // own page uses, so the two screens can never disagree about what is owed.
    const withBalance = await Promise.all((affiliates || []).map(async (a) => {
      const { data } = await supabase.rpc('affiliate_balance', { p_affiliate_id: a.id });
      const b = Array.isArray(data) ? data[0] : data;
      return {
        ...a,
        pending: Number(b?.pending_amount || 0),
        available: Number(b?.available_amount || 0),
        paid: Number(b?.paid_amount || 0),
        referred: Number(b?.referred_count || 0),
        paying: Number(b?.paying_count || 0),
      };
    }));

    res.json({ affiliates: withBalance, rates: RATES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/affiliates/:id/payout { method, reference, note }
 *
 * Records money that has already been sent. The claim and the total happen in
 * one statement inside the database, so two people pressing this at once cannot
 * pay the same commissions twice.
 */
adminRouter.post('/:id/payout', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('pay_affiliate', {
      p_affiliate_id: req.params.id,
      p_method: String(req.body?.method || 'paypal').slice(0, 40),
      p_reference: String(req.body?.reference || '').slice(0, 120) || null,
      p_note: String(req.body?.note || '').slice(0, 500) || null,
      p_created_by: req.user.id,
    });
    if (error) return res.status(400).json({ error: error.message });

    const row = Array.isArray(data) ? data[0] : data;
    await logEvent({
      scope: 'billing', userId: req.user.id,
      message: `Recorded an affiliate payout of $${row?.out_amount} covering ${row?.out_commission_count} commissions`,
      detail: { affiliate_id: req.params.id, payout_id: row?.out_payout_id },
    });
    res.json({
      payout_id: row?.out_payout_id,
      amount: Number(row?.out_amount || 0),
      commissions: Number(row?.out_commission_count || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /admin/affiliates/:id { status, note } */
adminRouter.patch('/:id', async (req, res) => {
  try {
    const patch = {};
    if (['active', 'suspended'].includes(req.body?.status)) patch.status = req.body.status;
    if (req.body?.note !== undefined) patch.note = String(req.body.note).slice(0, 500);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

    const { data, error } = await supabase
      .from('affiliates').update(patch).eq('id', req.params.id)
      .select('id, code, status, note').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Affiliate not found' });

    await logEvent({
      scope: 'billing', userId: req.user.id,
      message: `Affiliate ${data.code} set to ${data.status}`,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
