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
export async function createCheckout({ payment, plan, org, baseUrl }) {
  const order = await callPaypal('/v2/checkout/orders', {
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          // custom_id is the link that lets the webhook find this transaction again in our system
          custom_id: payment.id,
          invoice_id: `${payment.order_code}`,
          description: `${plan.name} — ${org.name}`.slice(0, 127),
          amount: {
            currency_code: 'USD',
            value: Number(payment.amount).toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'DocBot',
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

export async function getStatus(orderId) {
  const order = await callPaypal(`/v2/checkout/orders/${orderId}`, { method: 'GET' });
  return { status: order.status, raw: order };
}
