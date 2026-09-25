import { supabase } from '../supabaseClient.js';
import { logEvent } from '../logger.js';
import * as paypal from './paypal.js';
import { normalizeCycle, priceFor, monthsFor } from './cycles.js';

/**
 * Payment gateway registry.
 *
 * Adding a gateway means writing a module that exports
 * isEnabled / meta / createCheckout / verifyWebhook and listing it here.
 */
const PROVIDERS = { paypal };

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown payment method: ${id}`);
  if (!p.isEnabled()) throw new Error(`${p.meta.name} is not configured on the server`);
  return p;
}

/** Gateways that are currently configured and can accept a payment. */
export function availableProviders() {
  return Object.values(PROVIDERS).filter((p) => p.isEnabled()).map((p) => ({ ...p.meta }));
}

export function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  // Render sets RENDER_EXTERNAL_URL for us
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}

/**
 * Open a payment session.
 *
 * Security rule: the amount ALWAYS comes from the plans table on the server.
 * The browser only ever picks a plan and a gateway, never a price.
 */
export async function startCheckout({ org, plan, providerId, req, userId, cycle }) {
  const provider = getProvider(providerId);
  const currency = provider.meta.currency;
  const billingCycle = normalizeCycle(cycle);

  const amount = priceFor(plan, billingCycle);
  if (!(amount > 0)) {
    throw new Error(
      billingCycle === 'yearly'
        ? `The "${plan.name}" plan is not sold yearly. Choose monthly billing, or contact the system administrator.`
        : `The "${plan.name}" plan has no price set. Contact the system administrator.`
    );
  }

  // A unique integer order reference: timestamp tail plus a random suffix.
  const orderCode = Number(`${Date.now()}`.slice(-10) + String(Math.floor(Math.random() * 100)).padStart(2, '0'));

  const { data: payment, error } = await supabase
    .from('payments')
    .insert({
      organization_id: org.id,
      plan_id: plan.id,
      provider: providerId,
      currency,
      amount,
      billing_cycle: billingCycle,
      order_code: orderCode,
      status: 'pending',
      method: providerId,
      created_by: userId || null,
    })
    .select()
    .single();
  if (error) throw error;

  try {
    const result = await provider.createCheckout({ payment, plan, org, cycle: billingCycle, baseUrl: baseUrl(req) });

    await supabase
      .from('payments')
      .update({ provider_ref: result.providerRef, checkout_url: result.checkoutUrl, raw: result.raw })
      .eq('id', payment.id);

    await logEvent({
      scope: 'billing',
      organizationId: org.id,
      userId,
      message: `Opened a checkout for ${plan.name} (${billingCycle}) via ${provider.meta.name}`,
      detail: { payment_id: payment.id, amount, currency, billing_cycle: billingCycle },
    });

    return { payment_id: payment.id, checkout_url: result.checkoutUrl, amount, currency, billing_cycle: billingCycle };
  } catch (err) {
    // If the gateway would not give us a link, close the row so no session is left hanging.
    await supabase.from('payments').update({ status: 'failed', note: err.message }).eq('id', payment.id);
    throw err;
  }
}

/**
 * Record a successful payment and extend the plan.
 *
 * Idempotent: calling it repeatedly for one transaction only has an effect the
 * first time, because gateways retry their webhooks on a flaky connection.
 * Returns true when this call is the one that actually activated the plan.
 *
 * How long the payment buys is NOT passed in. The database reads it off the
 * payment's own billing_cycle, which was written at checkout in the same step
 * that fixed the price. A caller that could name the number of months could
 * hand out a year for the price of a month.
 */
export async function markPaid({ payment, providerRef, raw }) {
  // paid_at is the single marker for "already handled" — also checking status
  // would leave a gap through which a plan could be extended twice.
  if (payment.paid_at) {
    return { activated: false, reason: 'already recorded' };
  }

  if (providerRef && !payment.provider_ref) {
    await supabase.from('payments').update({ provider_ref: providerRef }).eq('id', payment.id);
  }
  if (raw) {
    await supabase.from('payments').update({ raw }).eq('id', payment.id);
  }

  // The SQL function locks the payments row and updates both payments and
  // organizations, so money can never be recorded without the plan being extended.
  const { data, error } = await supabase.rpc('activate_paid_plan', {
    p_payment_id: payment.id,
  });
  if (error) throw error;

  if (data) {
    const months = monthsFor(payment.billing_cycle);
    await logEvent({
      scope: 'billing',
      organizationId: payment.organization_id,
      message: `Payment received and plan extended by ${months} month${months === 1 ? '' : 's'} (${payment.amount} ${payment.currency})`,
      detail: { payment_id: payment.id, provider: payment.provider, billing_cycle: payment.billing_cycle || 'monthly' },
    });
  }

  return { activated: !!data };
}

/** Find a transaction by order code or id, scoped to one gateway. */
export async function findPayment({ id, orderCode, provider }) {
  let query = supabase.from('payments').select('*');
  if (id) query = query.eq('id', id);
  else if (orderCode) query = query.eq('order_code', orderCode);
  else return null;
  if (provider) query = query.eq('provider', provider);

  const { data } = await query.maybeSingle();
  return data || null;
}

export { paypal };
export { normalizeCycle, priceFor, monthsFor, decoratePlan } from './cycles.js';
