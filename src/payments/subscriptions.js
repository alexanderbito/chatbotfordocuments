import crypto from 'crypto';
import { supabase } from '../supabaseClient.js';
import { logEvent } from '../logger.js';
import * as paypal from './paypal.js';
import { normalizeCycle, priceFor, monthsFor } from './cycles.js';

/**
 * Automatic renewal through PayPal Subscriptions.
 *
 * PayPal needs three objects before it will charge anybody on a schedule: a
 * Product (what is being sold), a Billing Plan (how much and how often) and a
 * Subscription (this customer, on that plan). The first two are ours and are
 * created once; only the third is per customer.
 *
 * The one-off checkout in ./index.js is untouched and still works. A customer
 * whose finance department will not allow a standing charge, or who needs a
 * single invoice, uses that instead.
 */

const PRODUCT_NAME = 'BotClarify';

/**
 * PayPal billing plans are immutable in the way that matters: a price cannot be
 * edited into a different one. So the price each plan was created with is
 * stored beside its id, and a mismatch means the stored id is stale.
 *
 * Without this check, a price change in /sysadmin.html would keep charging
 * every new subscriber the old amount, and nothing would look wrong anywhere.
 */
function isStale(plan, cycle) {
  const stored = cycle === 'yearly' ? plan.paypal_synced_price_yearly : plan.paypal_synced_price_monthly;
  return Number(stored ?? -1) !== Number(priceFor(plan, cycle));
}

function planIdFor(plan, cycle) {
  return cycle === 'yearly' ? plan.paypal_plan_id_yearly : plan.paypal_plan_id_monthly;
}

/** The Product, created once and reused. */
async function ensureProduct() {
  const { data: row } = await supabase
    .from('system_settings').select('value').eq('key', 'paypal_product_id').maybeSingle();
  if (row?.value) return row.value;

  const product = await paypal.createProduct({
    name: PRODUCT_NAME,
    description: 'Chatbot for company documents',
  });
  await supabase.from('system_settings')
    .upsert({ key: 'paypal_product_id', value: product.id, updated_at: new Date().toISOString() });
  return product.id;
}

/**
 * Make sure PayPal has a billing plan matching this plan and cycle, and return
 * its id. Creates one when it is missing or when our price has moved.
 *
 * An old plan is deactivated rather than deleted: subscribers already on it go
 * on paying the price they agreed to, which is both the honest behaviour and
 * the only one PayPal allows.
 */
export async function ensurePaypalPlan(plan, cycle) {
  const c = normalizeCycle(cycle);
  const price = priceFor(plan, c);
  if (!(price > 0)) throw new Error(`The "${plan.name}" plan has no ${c} price.`);

  const existing = planIdFor(plan, c);
  if (existing && !isStale(plan, c)) return existing;

  const productId = await ensureProduct();
  const created = await paypal.createBillingPlan({
    productId,
    name: `${plan.name} — ${c}`.slice(0, 127),
    price,
    interval: c === 'yearly' ? 'YEAR' : 'MONTH',
  });

  if (existing) {
    // Best effort: a plan that cannot be deactivated is untidy, not broken.
    try { await paypal.deactivateBillingPlan(existing); }
    catch (err) { console.error('[paypal] could not deactivate the old plan:', err.message); }
  }

  const patch = c === 'yearly'
    ? { paypal_plan_id_yearly: created.id, paypal_synced_price_yearly: price }
    : { paypal_plan_id_monthly: created.id, paypal_synced_price_monthly: price };
  await supabase.from('plans').update(patch).eq('id', plan.id);

  await logEvent({
    scope: 'billing',
    message: `Created a PayPal billing plan for ${plan.name} (${c}) at $${price}`,
    detail: { plan_id: plan.id, paypal_plan_id: created.id },
  });
  return created.id;
}

/**
 * Start a subscription. Returns the approval link the customer is sent to.
 *
 * The amount never comes from the browser: the price comes from the plans
 * table, and the PayPal plan it points at was created from that same price.
 */
export async function startSubscription({ org, plan, cycle, userId, baseUrl }) {
  const c = normalizeCycle(cycle);
  const amount = priceFor(plan, c);
  if (!(amount > 0)) {
    throw new Error(c === 'yearly'
      ? `The "${plan.name}" plan is not sold yearly.`
      : `The "${plan.name}" plan has no price set.`);
  }

  // One live subscription per organization. The database enforces this too, but
  // refusing here lets us explain it rather than surfacing a constraint error.
  const { data: live } = await supabase
    .from('subscriptions')
    .select('id, status')
    .eq('organization_id', org.id)
    .in('status', ['pending', 'active', 'suspended'])
    .maybeSingle();
  if (live) {
    throw new Error('This organization already has a subscription. Cancel it before starting another.');
  }

  const paypalPlanId = await ensurePaypalPlan(plan, c);

  const { data: row, error } = await supabase
    .from('subscriptions')
    .insert({
      organization_id: org.id,
      plan_id: plan.id,
      provider: 'paypal',
      // Replaced below. The row exists first so custom_id can point at it.
      provider_ref: `pending-${crypto.randomUUID()}`,
      billing_cycle: c,
      amount,
      currency: 'USD',
      status: 'pending',
      created_by: userId || null,
    })
    .select()
    .single();
  if (error) throw error;

  try {
    const result = await paypal.createSubscription({
      paypalPlanId,
      // custom_id is how every later event finds this row again.
      customId: row.id,
      orgName: org.name,
      email: org.contact_email || undefined,
      baseUrl,
    });

    await supabase
      .from('subscriptions')
      .update({ provider_ref: result.id, approve_url: result.approveUrl, raw: result.raw })
      .eq('id', row.id);

    await logEvent({
      scope: 'billing', organizationId: org.id, userId,
      message: `Started a ${c} subscription for ${plan.name} ($${amount})`,
      detail: { subscription_id: row.id, paypal_ref: result.id },
    });

    return { subscription_id: row.id, approve_url: result.approveUrl, amount, currency: 'USD', billing_cycle: c };
  } catch (err) {
    // Leave nothing half-open: the unique index would otherwise block the
    // customer's next attempt with a row that never became a subscription.
    await supabase.from('subscriptions')
      .update({ status: 'failed', ended_at: new Date().toISOString() }).eq('id', row.id);
    throw err;
  }
}

/**
 * Cancel. The plan stays active until the period already paid for runs out —
 * cancelling is a decision not to renew, not a refund.
 */
export async function cancelSubscription({ org, subscriptionId, userId, reason }) {
  const { data: sub } = await supabase
    .from('subscriptions').select('*')
    .eq('id', subscriptionId).eq('organization_id', org.id).maybeSingle();
  if (!sub) throw new Error('Subscription not found');
  if (['cancelled', 'expired', 'failed'].includes(sub.status)) {
    return { already: true, status: sub.status };
  }

  // A subscription PayPal has never had approved cannot be cancelled there:
  // /cancel wants ACTIVE or SUSPENDED and answers 422 for anything else. Letting
  // that error through left the row alive, and the one-live-per-organization
  // index then refused every further attempt — a customer locked out of
  // subscribing for good by closing the approval tab. On an active subscription
  // the error still travels, because telling somebody renewal has stopped when
  // it has not is worse than showing them an error.
  try {
    await paypal.cancelSubscription(sub.provider_ref, reason || 'Cancelled by the customer');
  } catch (err) {
    if (sub.status !== 'pending') throw err;
    console.error('[paypal] could not cancel an unapproved subscription:', err.message);
  }

  // Written here as well as on the webhook. The webhook is the authority, but
  // somebody who has just clicked Cancel should see it reflected at once.
  await supabase.from('subscriptions')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', sub.id);

  await logEvent({
    scope: 'billing', organizationId: org.id, userId,
    message: 'Cancelled the subscription; the plan runs to the end of the paid period',
    detail: { subscription_id: sub.id },
  });
  return { already: false, status: 'cancelled' };
}

/**
 * A renewal arrived.
 *
 * Writes a payment row and extends the plan exactly as a one-off payment does,
 * so invoices, the payment history and the affiliate commission all behave the
 * same whether the money came in automatically or by hand.
 *
 * Idempotent on the gateway's own transaction id: PayPal retries webhooks, and
 * a retry must not buy a second month.
 */
export async function recordSubscriptionPayment({ subscription, saleId, amount, currency, raw }) {
  const { data: existing } = await supabase
    .from('payments').select('id')
    .eq('provider', 'paypal').eq('provider_ref', saleId).maybeSingle();
  if (existing) return { activated: false, reason: 'already recorded', payment_id: existing.id };

  const orderCode = Number(`${Date.now()}`.slice(-10) + String(Math.floor(Math.random() * 100)).padStart(2, '0'));

  const { data: payment, error } = await supabase
    .from('payments')
    .insert({
      organization_id: subscription.organization_id,
      plan_id: subscription.plan_id,
      subscription_id: subscription.id,
      provider: 'paypal',
      provider_ref: saleId,
      method: 'paypal',
      currency: currency || 'USD',
      // The amount PayPal actually took, not what we expected it to take.
      amount: Number(amount || subscription.amount),
      billing_cycle: subscription.billing_cycle,
      order_code: orderCode,
      status: 'pending',
      raw,
    })
    .select()
    .single();
  if (error) {
    // A unique violation means a concurrent delivery of the same webhook won
    // the race. That is the correct outcome, not a failure.
    if (error.code === '23505') return { activated: false, reason: 'already recorded' };
    throw error;
  }

  // Recorded either way — the customer has been charged and must get what they
  // paid for — but a renewal that is not the amount we expect means our billing
  // plan and PayPal's have drifted apart, and that has to be findable.
  if (Math.abs(Number(payment.amount) - Number(subscription.amount)) > 0.01) {
    await logEvent({
      level: 'error', scope: 'billing',
      organizationId: subscription.organization_id,
      message: 'PayPal took a different amount than the subscription says',
      detail: { expected: subscription.amount, charged: payment.amount, subscription_id: subscription.id },
    });
  }

  const { data: activated, error: rpcError } = await supabase.rpc('activate_paid_plan', { p_payment_id: payment.id });
  if (rpcError) throw rpcError;

  await supabase.from('subscriptions').update({
    status: 'active',
    last_payment_at: new Date().toISOString(),
    activated_at: subscription.activated_at || new Date().toISOString(),
  }).eq('id', subscription.id);

  // The commission is derived by the database from the payment row, so it is
  // computed from the money actually received.
  const { error: commissionError } = await supabase.rpc('record_commission', { p_payment_id: payment.id });
  if (commissionError) console.error('[billing] could not record a commission:', commissionError.message);

  await logEvent({
    scope: 'billing',
    organizationId: subscription.organization_id,
    message: `Subscription renewed: ${payment.amount} ${payment.currency} (${subscription.billing_cycle})`,
    detail: { payment_id: payment.id, subscription_id: subscription.id },
  });

  return { activated: !!activated, payment_id: payment.id };
}

/** Find a subscription from whatever identifier an event carries. */
export async function findSubscription({ customId, providerRef }) {
  if (customId) {
    const { data } = await supabase.from('subscriptions').select('*').eq('id', customId).maybeSingle();
    if (data) return data;
  }
  if (providerRef) {
    const { data } = await supabase.from('subscriptions').select('*')
      .eq('provider', 'paypal').eq('provider_ref', providerRef).maybeSingle();
    if (data) return data;
  }
  return null;
}

/** Record a lifecycle change that is not a payment. */
export async function applySubscriptionStatus(subscription, status, detail) {
  const patch = { status };
  const now = new Date().toISOString();
  if (status === 'active') patch.activated_at = subscription.activated_at || now;
  if (status === 'cancelled') patch.cancelled_at = subscription.cancelled_at || now;
  if (['expired', 'cancelled'].includes(status)) patch.ended_at = now;

  await supabase.from('subscriptions').update(patch).eq('id', subscription.id);
  await logEvent({
    scope: 'billing',
    organizationId: subscription.organization_id,
    level: status === 'active' ? 'info' : 'warn',
    message: `Subscription ${status}`,
    detail: { subscription_id: subscription.id, ...detail },
  });
}

export { monthsFor };
