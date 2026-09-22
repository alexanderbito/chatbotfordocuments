import { PayOS, WebhookError } from '@payos/node';
import 'dotenv/config';

/**
 * Cổng thanh toán cho khách Việt Nam — payOS (VietQR).
 *
 * Dùng SDK chính thức thay vì tự ký HMAC: thuật toán chữ ký của payOS có
 * vài chi tiết dễ sai (thứ tự khoá, có URI-encode hay không), mà sai thì
 * webhook bị từ chối hoặc tệ hơn là chấp nhận dữ liệu giả.
 */

let client = null;

/** Cắt khoảng trắng thừa: dán biến môi trường trên Render rất hay dính \n ở cuối. */
function creds() {
  return {
    clientId: String(process.env.PAYOS_CLIENT_ID || '').trim(),
    apiKey: String(process.env.PAYOS_API_KEY || '').trim(),
    checksumKey: String(process.env.PAYOS_CHECKSUM_KEY || '').trim(),
  };
}

export function isEnabled() {
  const c = creds();
  return !!(c.clientId && c.apiKey && c.checksumKey);
}

function getClient() {
  if (!isEnabled()) throw new Error('Chưa cấu hình payOS (PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY)');
  if (!client) client = new PayOS(creds());
  return client;
}

/** Chẩn đoán cấu hình payOS cho trang Sức khoẻ hệ thống. */
export async function diagnose() {
  if (!isEnabled()) {
    return { ok: false, detail: 'Chưa đặt PAYOS_CLIENT_ID / PAYOS_API_KEY / PAYOS_CHECKSUM_KEY' };
  }
  try {
    // Tra một mã đơn không tồn tại: đủ để payOS kiểm tra khoá mà không tạo gì.
    await getClient().paymentRequests.get(999999999);
    return { ok: true, detail: 'Khoá hợp lệ' };
  } catch (err) {
    const msg = String(err?.message || err);
    // "không tìm thấy đơn" nghĩa là khoá đã được chấp nhận — đúng thứ ta cần biết.
    if (/not.?found|không tìm thấy|kh.ng t.n t.i|1[0-9]{2}\b/i.test(msg)) {
      return { ok: true, detail: 'Khoá hợp lệ' };
    }
    return { ok: false, detail: `Không gọi được payOS — ${msg}` };
  }
}

export const meta = {
  id: 'payos',
  name: 'Chuyển khoản / VietQR',
  currency: 'VND',
  description: 'Quét mã VietQR bằng app ngân hàng bất kỳ',
  countries: 'VN',
};

/**
 * Tạo phiên thanh toán. Số tiền do máy chủ quyết định, không nhận từ trình duyệt.
 * @returns {Promise<{ checkoutUrl: string, providerRef: string, raw: object }>}
 */
export async function createCheckout({ payment, plan, org, baseUrl }) {
  const payos = getClient();

  // payOS giới hạn mô tả 9 ký tự với tài khoản chưa liên kết, nên để ngắn gọn.
  const description = `GOI ${String(plan.code || '').toUpperCase()}`.slice(0, 25);

  const res = await payos.paymentRequests.create({
    orderCode: Number(payment.order_code),
    amount: Math.round(Number(payment.amount)),
    description,
    returnUrl: `${baseUrl}/billing-return.html?payment=${payment.id}`,
    cancelUrl: `${baseUrl}/billing-return.html?payment=${payment.id}&cancelled=1`,
    buyerName: org.name || undefined,
    buyerEmail: org.contact_email || undefined,
    buyerTaxCode: org.tax_code || undefined,
    expiredAt: Math.floor(Date.now() / 1000) + 60 * 60, // hết hạn sau 1 giờ
  });

  return { checkoutUrl: res.checkoutUrl, providerRef: res.paymentLinkId, raw: res };
}

/**
 * Xác thực webhook và trả về thông tin giao dịch đã kiểm chứng.
 * Ném lỗi nếu chữ ký không hợp lệ.
 * @returns {Promise<{ orderCode: number, amount: number, providerRef: string, paid: boolean, raw: object }>}
 */
export async function verifyWebhook({ body }) {
  const payos = getClient();

  let data;
  try {
    data = await payos.webhooks.verify(body);
  } catch (err) {
    if (err instanceof WebhookError || err?.name === 'WebhookError') {
      const e = new Error('Chữ ký webhook payOS không hợp lệ');
      e.invalidSignature = true;
      throw e;
    }
    throw err;
  }

  return {
    orderCode: Number(data.orderCode),
    amount: Number(data.amount),
    providerRef: data.paymentLinkId,
    // payOS trả code '00' khi giao dịch thành công
    paid: data.code === '00',
    raw: data,
  };
}

/** Đăng ký URL webhook với payOS (chạy một lần khi thiết lập). */
export async function registerWebhook(url) {
  const payos = getClient();
  return payos.webhooks.confirm(url);
}

/** Tra cứu trạng thái một đơn — dùng cho trang chờ sau khi khách quay lại. */
export async function getStatus(orderCode) {
  const payos = getClient();
  const link = await payos.paymentRequests.get(Number(orderCode));
  return { status: link.status, raw: link };
}
