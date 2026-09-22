import 'dotenv/config';

/**
 * Cổng thanh toán cho khách ngoài Việt Nam — PayPal.
 *
 * Dùng REST trực tiếp thay vì SDK: chỉ cần 3 lệnh gọi (lấy token, tạo đơn,
 * thu tiền) và một lệnh xác thực webhook, nên không đáng thêm phụ thuộc.
 */

const LIVE = 'https://api-m.paypal.com';
const SANDBOX = 'https://api-m.sandbox.paypal.com';

/**
 * Dán biến môi trường trên Render rất hay dính khoảng trắng hoặc xuống dòng ở
 * cuối. Chuỗi Basic auth vì thế sai và PayPal trả 401 "Client Authentication
 * failed" — nhìn hệt như nhập sai khoá. Cắt sạch ngay từ đầu.
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
  name: 'PayPal / Thẻ quốc tế',
  currency: 'USD',
  description: 'Pay with PayPal balance, credit or debit card',
  countries: 'INTERNATIONAL',
};

let tokenCache = { value: null, expiresAt: 0 };

async function accessToken() {
  if (!isEnabled()) throw new Error('Chưa cấu hình PayPal (PAYPAL_CLIENT_ID / PAYPAL_SECRET)');
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const { value: token } = await fetchToken(env());
  tokenCache = token;
  return tokenCache.value;
}

/**
 * Lấy token cho MỘT môi trường cụ thể. Tách riêng để phần chẩn đoán có thể thử
 * cả hai môi trường mà không đụng vào bộ nhớ đệm đang dùng để thu tiền thật.
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
      `PayPal: không lấy được access token — ${why} ` +
      `(PAYPAL_ENV=${forEnv}, máy chủ ${apiBase(forEnv)}, client id bắt đầu bằng "${id.slice(0, 8)}…", dài ${id.length} ký tự)`
    );
    err.status = res.status;
    throw err;
  }

  // Trừ hao 60 giây để không dùng token vừa hết hạn
  return { value: { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 } };
}

/**
 * Chẩn đoán cấu hình PayPal cho trang Sức khoẻ hệ thống.
 *
 * Khi khoá không dùng được ở môi trường đang đặt, thử nốt môi trường còn lại.
 * Lý do: lỗi phổ biến nhất là tạo app Live trên PayPal nhưng quên đặt
 * PAYPAL_ENV=live, nên khoá Live bị gửi tới máy chủ sandbox và nhận đúng một
 * câu "Client Authentication failed" chẳng nói lên điều gì. Đây chỉ là lệnh
 * xin token, không tạo đơn và không đụng tới tiền.
 */
export async function diagnose() {
  const current = env();
  if (!isEnabled()) {
    return { ok: false, env: current, detail: 'Chưa đặt PAYPAL_CLIENT_ID / PAYPAL_SECRET' };
  }

  try {
    await fetchToken(current);
  } catch (err) {
    const other = current === 'live' ? 'sandbox' : 'live';
    let otherWorks = false;
    try { await fetchToken(other); otherWorks = true; } catch { /* khoá sai ở cả hai nơi */ }

    if (otherWorks) {
      return {
        ok: false,
        env: current,
        mismatch: other,
        detail:
          `Khoá này KHÔNG dùng được ở môi trường "${current}" nhưng dùng được ở "${other}". ` +
          `Sửa biến PAYPAL_ENV thành "${other}" trên Render rồi deploy lại.`,
      };
    }
    return {
      ok: false,
      env: current,
      detail: `${err.message}. Khoá cũng không dùng được ở môi trường "${other}" — nhiều khả năng Client ID hoặc Secret bị sai, thiếu ký tự hoặc dính khoảng trắng.`,
    };
  }

  const warnings = [];
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    warnings.push('Chưa đặt PAYPAL_WEBHOOK_ID — webhook sẽ bị từ chối, khách trả tiền mà không được nâng gói');
  }
  if (current === 'sandbox') {
    warnings.push('Đang chạy ở môi trường sandbox — tiền không có thật');
  }
  return {
    ok: true,
    env: current,
    detail: warnings.length ? warnings.join(' · ') : `Lấy token thành công ở môi trường ${current}`,
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
 * Tạo đơn hàng PayPal. Số tiền lấy từ bản ghi payment do máy chủ tạo.
 */
export async function createCheckout({ payment, plan, org, baseUrl }) {
  const order = await callPaypal('/v2/checkout/orders', {
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          // custom_id là cầu nối để webhook tìm lại đúng giao dịch trong hệ thống
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
    headers: { 'PayPal-Request-Id': payment.id },  // chống tạo trùng đơn
  });

  const approve = (order.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  if (!approve) throw new Error('PayPal không trả về link thanh toán');

  return { checkoutUrl: approve.href, providerRef: order.id, raw: order };
}

/**
 * Thu tiền sau khi khách bấm đồng ý và quay lại.
 * Idempotent: nếu đơn đã thu rồi, PayPal trả ORDER_ALREADY_CAPTURED và ta coi là thành công.
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
 * Xác thực webhook bằng chính API của PayPal.
 *
 * Quan trọng: phải gửi lại NGUYÊN VĂN phần thân request như lúc nhận được.
 * Vì vậy tuyến webhook phải dùng express.raw() chứ không phải express.json(),
 * rồi mới parse — JSON.stringify lại một object đã parse có thể đổi thứ tự
 * khoá hoặc cách biểu diễn số và làm chữ ký sai.
 */
export async function verifyWebhook({ headers, rawBody }) {
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    throw new Error('Chưa cấu hình PAYPAL_WEBHOOK_ID nên không xác thực được webhook');
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
    const e = new Error('Chữ ký webhook PayPal không hợp lệ');
    e.invalidSignature = true;
    throw e;
  }

  const resource = event.resource || {};
  const paidEvents = ['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.COMPLETED'];

  // custom_id nằm ở vị trí khác nhau tuỳ loại sự kiện
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
