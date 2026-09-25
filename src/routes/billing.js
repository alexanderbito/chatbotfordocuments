import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { logEvent } from '../logger.js';
import { availableProviders, startCheckout, markPaid, findPayment, paypal } from '../payments/index.js';
import { decoratePlan } from '../payments/cycles.js';
import { buildInvoicePdf, invoiceFilename } from '../invoice.js';

const router = express.Router({ mergeParams: true });

// =====================================================================
// PUBLIC — no authentication required
// =====================================================================

/** GET /public/billing/plans — the price list shown on the marketing page. */
export const publicRouter = express.Router();

publicRouter.get('/plans', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('id, code, name, description, price_usd, price_usd_yearly, trial_days, ocr_enabled, max_documents, max_members, max_storage_mb, max_questions_per_month, max_ocr_pages_per_month')
      .eq('is_active', true)
      .order('sort_order');
    if (error) throw error;

    res.json({
      currency: 'USD',
      providers: availableProviders(),
      // decoratePlan adds price_yearly, yearly_per_month and yearly_saving_pct
      // so the pricing page never computes a discount of its own — the badge
      // and the amount charged come from the same numbers.
      plans: (data || []).map(decoratePlan),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// AUTHENTICATED — organization admins only
// =====================================================================
router.use(requireAuth, requireOrgMember, requireOrgAdmin);

/**
 * POST /orgs/:orgId/billing/checkout { plan_id, provider }
 * The browser never sends an amount. Prices always come from the plans table.
 */
router.post('/checkout', async (req, res) => {
  try {
    const { plan_id, provider, billing_cycle } = req.body || {};
    if (!plan_id || !provider) return res.status(400).json({ error: 'Plan and payment method are required' });

    const { data: plan } = await supabase.from('plans').select('*').eq('id', plan_id).maybeSingle();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (!plan.is_active) return res.status(400).json({ error: 'This plan is no longer on sale' });

    const result = await startCheckout({
      org: req.org,
      plan,
      providerId: provider,
      cycle: billing_cycle,
      req,
      userId: req.user.id,
    });

    res.json(result);
  } catch (err) {
    console.error('checkout error:', err);
    res.status(400).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/billing/payments/:paymentId — status of one transaction. */
router.get('/payments/:paymentId', async (req, res) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('id, status, provider, provider_ref, amount, currency, billing_cycle, order_code, paid_at, plan:plans(name)')
      .eq('id', req.params.paymentId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Transaction not found' });

    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /orgs/:orgId/billing/payments/:paymentId/capture
 * PayPal needs an explicit capture once the payer approves, so the return page
 * calls this. The webhook remains the fallback if the payer closes the tab.
 */
router.post('/payments/:paymentId/capture', async (req, res) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('*')
      .eq('id', req.params.paymentId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Transaction not found' });
    if (payment.provider !== 'paypal') return res.status(400).json({ error: 'Only PayPal transactions can be captured' });

    if (payment.status === 'paid') return res.json({ status: 'paid', activated: false });

    const result = await paypal.capture(payment.provider_ref);
    if (!result.paid) return res.json({ status: payment.status, activated: false });

    const out = await markPaid({ payment, raw: result.raw });
    res.json({ status: 'paid', ...out });
  } catch (err) {
    console.error('capture error:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /orgs/:orgId/billing/payments/:paymentId/invoice.pdf
 *
 * The invoice number is allocated by the database on the first download and
 * then never changes, so downloading the same invoice twice gives the same
 * document. Only a payment that has actually been received can be invoiced.
 */
router.get('/payments/:paymentId/invoice.pdf', async (req, res) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('*, plan:plans(name, description)')
      .eq('id', req.params.paymentId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Transaction not found' });
    if (!payment.paid_at) {
      return res.status(409).json({ error: 'This payment has not been received yet, so there is no invoice for it' });
    }

    const out = await renderInvoice(payment, req.org);
    sendInvoice(res, out.pdf, out.payment);
  } catch (err) {
    console.error('invoice error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Allocates the invoice number if this is the first download, then renders.
 * Shared by the customer route above and the system-admin route.
 *
 * Returns the payment as well as the bytes, because on a first download the
 * caller's copy still has invoice_number null — and the filename is built from
 * it. Returning only the bytes named the first download after the order code
 * and every later one after the invoice number, so the customer ended up with
 * two differently named copies of the same document.
 */
export async function renderInvoice(payment, organization) {
  let number = payment.invoice_number;
  if (!number) {
    const { data, error } = await supabase.rpc('assign_invoice_number', { p_payment_id: payment.id });
    if (error) throw error;
    number = data;
  }
  const invoiced = { ...payment, invoice_number: number };
  const pdf = await buildInvoicePdf({ payment: invoiced, organization, plan: payment.plan });
  return { pdf, payment: invoiced };
}

export function sendInvoice(res, pdf, payment) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceFilename(payment)}"`);
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(Buffer.from(pdf));
}

export default router;

// =====================================================================
// WEBHOOK — public, with NO authentication middleware.
// Protected by the gateway's own request signature instead.
// =====================================================================
export const webhookRouter = express.Router();

/**
 * PayPal posts here. Uses express.raw() because the signature check has to be
 * given the request body VERBATIM — re-serializing a parsed object can reorder
 * keys or change how numbers are written, and the signature then fails.
 */
webhookRouter.post('/paypal', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const info = await paypal.verifyWebhook({ headers: req.headers, rawBody: req.body });

    if (!info.paid) return res.json({ received: true });

    const payment = await findPayment({ id: info.paymentId, provider: 'paypal' });
    if (!payment) {
      await logEvent({ level: 'warn', scope: 'billing', message: `PayPal webhook for an unknown transaction: ${info.paymentId}` });
      return res.json({ received: true });
    }

    if (Math.abs(Number(payment.amount) - info.amount) > 0.01) {
      await logEvent({
        level: 'error',
        scope: 'billing',
        organizationId: payment.organization_id,
        message: 'PayPal webhook amount does not match the amount on the order',
        detail: { expected: payment.amount, received: info.amount, payment_id: payment.id },
      });
      return res.json({ received: true });
    }

    await markPaid({ payment, providerRef: info.providerRef, raw: info.raw });
    res.json({ received: true });
  } catch (err) {
    if (err.invalidSignature) {
      await logEvent({ level: 'error', scope: 'billing', message: 'Rejected a PayPal webhook with an invalid signature' });
      return res.status(401).json({ error: 'invalid signature' });
    }
    console.error('paypal webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});
