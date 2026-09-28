import 'dotenv/config';

/**
 * Payment gateway for customers outside Vietnam — PayPal.
 *
 * We call the REST API directly instead of pulling in the SDK: only three calls
 * are needed (get a token, create an order, capture the money) plus one webhook
 * verification call, which is not worth an extra dependency.
 */

const LIVE = 'https://api-m.paypal.com';
const SANDBOX = 'https://api-m.sandbox.paypal.com';

/**
 * Pasting environment variables into Render very often leaves a trailing space
 * or newline behind. That corrupts the Basic auth string and PayPal answers with
 * a 401 "Client Authentication failed" — which looks exactly like a mistyped
 * credential. Trim them here, at the source.
 */
function creds() {
  return {
    id: String(process.env.PAYPAL_CLIENT_ID || '').trim(),
    secret: String(process.env.PAYPAL_SECRET || '').trim(),
  };
}

export function env() {
  return String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase() === 'live' ? 'live' : 'sandbox';
}

function apiBase(forEnv) {
  // The test suite points this at a local stub so the checkout path can be run
  // end to end without touching PayPal. It is deliberately gated on NODE_ENV:
  // an unconditional override would mean one stray environment variable could
  // silently redirect real payments to somebody else's server.
  if (process.env.NODE_ENV === 'test' && process.env.PAYPAL_API_BASE) {
    return process.env.PAYPAL_API_BASE.replace(/\/$/, '');
  }
  return (forEnv || env()) === 'live' ? LIVE : SANDBOX;
}

export function isEnabled() {
  const { id, secret } = creds();
  return !!(id && secret);
}

export const meta = {
  id: 'paypal',
  name: 'PayPal / Credit or debit card',
  currency: 'USD',
  description: 'Pay with PayPal balance, credit or debit card',
  countries: 'INTERNATIONAL',
};

let tokenCache = { value: null, expiresAt: 0 };

async function accessToken() {
  if (!isEnabled()) throw new Error('PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_SECRET)');
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const { value: token } = await fetchToken(env());
  tokenCache = token;
  return tokenCache.value;
}

/**
 * Get a token for ONE specific environment. Kept separate so that the diagnostics
 * can probe both environments without disturbing the token cache used for real
 * payments.
 */
async function fetchToken(forEnv) {
  const { id, secret } = creds();
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${apiBase(forEnv)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data?.error_description || data?.error || `HTTP ${res.status}`;
    const err = new Error(
      `PayPal: could not obtain an access token — ${why} ` +
      `(PAYPAL_ENV=${forEnv}, server ${apiBase(forEnv)}, client id starts with "${id.slice(0, 8)}…", ${id.length} characters long)`
    );
    err.status = res.status;
    throw err;
  }

  // Take 60 seconds off the lifetime so we never send a token that just expired
  return { value: { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 } };
}

/**
 * Diagnose the PayPal configuration for the System health page.
 *
 * When the credentials do not work in the environment that is configured, try
 * the other environment as well. The reason: the most common mistake is creating
 * a Live app on PayPal but forgetting to set PAYPAL_ENV=live, so Live credentials
 * are sent to the sandbox server and all that comes back is a bare "Client
 * Authentication failed" that explains nothing. This only asks for a token; it
 * creates no order and never touches money.
 */
export async function diagnose() {
  const current = env();
  if (!isEnabled()) {
    return { ok: false, env: current, detail: 'PAYPAL_CLIENT_ID / PAYPAL_SECRET are not set' };
  }

  try {
    await fetchToken(current);
  } catch (err) {
    const other = current === 'live' ? 'sandbox' : 'live';
    let otherWorks = false;
    try { await fetchToken(other); otherWorks = true; } catch { /* the credentials are wrong in both environments */ }

    if (otherWorks) {
      return {
        ok: false,
        env: current,
        mismatch: other,
        detail:
          `These credentials do NOT work in the "${current}" environment, but they do work in "${other}". ` +
          `Change PAYPAL_ENV to "${other}" on Render and redeploy the service.`,
      };
    }
    return {
      ok: false,
      env: current,
      detail: `${err.message}. The credentials do not work in the "${other}" environment either — most likely the Client ID or Secret is wrong, missing characters, or has whitespace stuck to it.`,
    };
  }

  const warnings = [];
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    warnings.push('PAYPAL_WEBHOOK_ID is not set — webhooks will be rejected, so customers will pay without their plan being upgraded');
  }
  if (current === 'sandbox') {
    warnings.push('Running in the sandbox environment — the money is not real');
  }
  return {
    ok: true,
    env: current,
    detail: warnings.length ? warnings.join(' · ') : `Successfully obtained a token in the ${current} environment`,
    warning: warnings.length > 0,
  };
}

async function callPaypal(path, { method = 'POST', body, headers = {} } = {}) {
  const token = await accessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.error_description || `HTTP ${res.status}`;
    const err = new Error(`PayPal: ${msg}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

/**
 * Create a PayPal order. The amount comes from the payment record the server
 * created.
 */
export async function createCheckout({ payment, plan, org, cycle, baseUrl }) {
  // The cycle goes in the description because it is what the payer sees on the
  // PayPal page. Someone paying $187 needs to read "12 months" there, not just
  // the plan name, or the amount looks like a mistake and the checkout is
  // abandoned.
  const period = cycle === 'yearly' ? '12 months' : '1 month';
  const order = await callPaypal('/v2/checkout/orders', {
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          // custom_id is the link that lets the webhook find this transaction again in our system
          custom_id: payment.id,
          invoice_id: `${payment.order_code}`,
          description: `${plan.name}, ${period} — ${org.name}`.slice(0, 127),
          amount: {
            currency_code: 'USD',
            value: Number(payment.amount).toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'BotClarify',
            user_action: 'PAY_NOW',
            return_url: `${baseUrl}/billing-return.html?payment=${payment.id}`,
            cancel_url: `${baseUrl}/billing-return.html?payment=${payment.id}&cancelled=1`,
          },
        },
      },
    },
    headers: { 'PayPal-Request-Id': payment.id },  // guards against creating duplicate orders
  });

  const approve = (order.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  if (!approve) throw new Error('PayPal did not return a checkout link');

  return { checkoutUrl: approve.href, providerRef: order.id, raw: order };
}

/**
 * Capture the money after the customer approves the payment and returns.
 * Idempotent: if the order was already captured, PayPal returns
 * ORDER_ALREADY_CAPTURED and we treat that as success.
 */
export async function capture(orderId) {
  try {
    const res = await callPaypal(`/v2/checkout/orders/${orderId}/capture`, {
      headers: { 'PayPal-Request-Id': `capture-${orderId}` },
    });
    return { paid: res.status === 'COMPLETED', raw: res };
  } catch (err) {
    const issue = err.detail?.details?.[0]?.issue;
    if (issue === 'ORDER_ALREADY_CAPTURED') {
      return { paid: true, raw: err.detail, alreadyCaptured: true };
    }
    throw err;
  }
}

/**
 * Verify a webhook through PayPal's own API.
 *
 * Important: the request body has to be sent back VERBATIM, byte for byte as it
 * arrived. That is why the webhook route must use express.raw() rather than
 * express.json() and parse the body itself — calling JSON.stringify() on an
 * already-parsed object can change the key order or the way numbers are
 * rendered, which makes the signature check fail.
 */
export async function verifyWebhook({ headers, rawBody }) {
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    throw new Error('PAYPAL_WEBHOOK_ID is not configured, so the webhook cannot be verified');
  }

  const event = JSON.parse(rawBody.toString('utf8'));

  const res = await callPaypal('/v1/notifications/verify-webhook-signature', {
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    },
  });

  if (res.verification_status !== 'SUCCESS') {
    const e = new Error('Invalid PayPal webhook signature');
    e.invalidSignature = true;
    throw e;
  }

  const resource = event.resource || {};
  const paidEvents = ['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.COMPLETED'];

  // custom_id sits in a different place depending on the event type
  const paymentId =
    resource.custom_id ||
    resource.purchase_units?.[0]?.custom_id ||
    resource.supplementary_data?.related_ids?.order_id ||
    null;

  return {
    eventType: event.event_type,
    paymentId,
    providerRef: resource.supplementary_data?.related_ids?.order_id || resource.id || null,
    amount: Number(resource.amount?.value || resource.purchase_units?.[0]?.amount?.value || 0),
    currency: resource.amount?.currency_code || 'USD',
    paid: paidEvents.includes(event.event_type),
    raw: event,
  };
}

// =====================================================================
// SUBSCRIPTIONS
//
// PayPal charges on a schedule only through its own objects: a Product, a
// Billing Plan, and then a Subscription per customer. The helpers below are
// thin wrappers over those three endpoints; the decisions about when to create
// what live in ./subscriptions.js.
// =====================================================================

/** The thing being sold. Created once for the whole installation. */
export async function createProduct({ name, description }) {
  return callPaypal('/v1/catalogs/products', {
    body: {
      name: String(name).slice(0, 127),
      description: String(description || '').slice(0, 256),
      type: 'SERVICE',
      category: 'SOFTWARE',
    },
    // PayPal deduplicates on this, so a retried request cannot create a second
    // product with the same name.
    headers: { 'PayPal-Request-Id': `product-${name}`.slice(0, 108) },
  });
}

/**
 * A price and an interval.
 *
 * total_cycles: 0 means "until cancelled", which is the whole point.
 *
 * setup_fee_failure_action and payment_failure_threshold decide what happens
 * when a card is declined: PayPal retries up to three times before suspending
 * the subscription, which is what gives a customer with an expired card a
 * chance to fix it rather than losing access the same day.
 */
export async function createBillingPlan({ productId, name, price, interval }) {
  return callPaypal('/v1/billing/plans', {
    body: {
      product_id: productId,
      name: String(name).slice(0, 127),
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: interval, interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: Number(price).toFixed(2), currency_code: 'USD' } },
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    },
  });
}

/** Retire a plan we have replaced. Subscribers already on it are unaffected. */
export async function deactivateBillingPlan(planId) {
  return callPaypal(`/v1/billing/plans/${encodeURIComponent(planId)}/deactivate`, { body: {} });
}

/**
 * Start a subscription and return the link the customer approves it at.
 *
 * custom_id carries our own subscription row id, and PayPal sends it back on
 * every later event — the activation, each renewal, the cancellation. It is the
 * only reliable way to know which customer an incoming event belongs to.
 */
export async function createSubscription({ paypalPlanId, customId, orgName, email, baseUrl }) {
  const sub = await callPaypal('/v1/billing/subscriptions', {
    body: {
      plan_id: paypalPlanId,
      custom_id: customId,
      subscriber: {
        name: { given_name: String(orgName || 'Customer').slice(0, 140) },
        ...(email ? { email_address: email } : {}),
      },
      application_context: {
        brand_name: 'BotClarify',
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
        return_url: `${baseUrl}/billing-return.html?subscription=${customId}`,
        cancel_url: `${baseUrl}/billing-return.html?subscription=${customId}&cancelled=1`,
      },
    },
    headers: { 'PayPal-Request-Id': String(customId) },
  });

  const approve = (sub.links || []).find((l) => l.rel === 'approve');
  if (!approve?.href) throw new Error('PayPal did not return an approval link for the subscription');
  return { id: sub.id, approveUrl: approve.href, raw: sub };
}

export async function getSubscription(subscriptionId) {
  return callPaypal(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'GET' });
}

export async function cancelSubscription(subscriptionId, reason) {
  return callPaypal(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    body: { reason: String(reason || 'Cancelled by the customer').slice(0, 127) },
  });
}

/**
 * Read a verified webhook event that concerns a subscription.
 *
 * Kept apart from verifyWebhook's one-off-payment shape because the two carry
 * completely different resources: a renewal arrives as PAYMENT.SALE.COMPLETED
 * whose resource is a sale, while the lifecycle events carry the subscription
 * itself. Squeezing both through one set of field lookups is how a renewal ends
 * up applied to the wrong row.
 */
export function readSubscriptionEvent(event) {
  const r = event.resource || {};
  const type = event.event_type || '';

  if (type === 'PAYMENT.SALE.COMPLETED') {
    return {
      kind: 'payment',
      // billing_agreement_id is PayPal's id for the subscription this sale
      // belongs to. A sale with no such field is a one-off payment and is
      // handled by the other webhook path.
      providerRef: r.billing_agreement_id || null,
      customId: r.custom || r.custom_id || null,
      saleId: r.id || null,
      amount: Number(r.amount?.total ?? r.amount?.value ?? 0),
      currency: r.amount?.currency ?? r.amount?.currency_code ?? 'USD',
    };
  }

  const STATUS = {
    'BILLING.SUBSCRIPTION.ACTIVATED': 'active',
    'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'active',
    'BILLING.SUBSCRIPTION.UPDATED': null,
    'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled',
    'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended',
    'BILLING.SUBSCRIPTION.EXPIRED': 'expired',
    'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'suspended',
  };

  if (type in STATUS) {
    return {
      kind: 'lifecycle',
      status: STATUS[type],
      providerRef: r.id || null,
      customId: r.custom_id || null,
      failed: type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    };
  }

  return { kind: 'other' };
}
