import { supabase } from '../supabaseClient.js';
import { logEvent } from '../logger.js';
import * as payos from './payos.js';
import * as paypal from './paypal.js';

/**
 * Lớp điều phối cổng thanh toán.
 *
 * Thêm cổng mới (ví dụ Paddle) chỉ cần viết một module có đủ
 * isEnabled / meta / createCheckout / verifyWebhook rồi khai báo ở đây.
 */
const PROVIDERS = { payos, paypal };

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Cổng thanh toán không hợp lệ: ${id}`);
  if (!p.isEnabled()) throw new Error(`Cổng ${p.meta.name} chưa được cấu hình trên máy chủ`);
  return p;
}

/** Danh sách cổng đang bật, kèm cổng gợi ý theo quốc gia. */
export function availableProviders(country) {
  const isVN = String(country || 'VN').toUpperCase() === 'VN';
  return Object.values(PROVIDERS)
    .filter((p) => p.isEnabled())
    .map((p) => ({
      ...p.meta,
      recommended: isVN ? p.meta.id === 'payos' : p.meta.id === 'paypal',
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));
}

export function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  // Render đặt sẵn RENDER_EXTERNAL_URL
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}

/** Tỷ giá chỉ dùng để quy đổi cho báo cáo doanh thu, không dùng để tính tiền khách. */
export function usdToVnd(usd) {
  const rate = Number(process.env.USD_TO_VND_RATE || 26000);
  return Math.round(Number(usd) * rate);
}

/**
 * Tạo một phiên thanh toán.
 *
 * Nguyên tắc bảo mật: số tiền LUÔN lấy từ bảng plans ở máy chủ.
 * Trình duyệt chỉ được chọn gói và cổng, không bao giờ gửi lên số tiền.
 */
export async function startCheckout({ org, plan, providerId, req, userId }) {
  const provider = getProvider(providerId);
  const currency = provider.meta.currency;

  const amount = currency === 'USD' ? Number(plan.price_usd) : Number(plan.price_vnd);
  if (!(amount > 0)) {
    throw new Error(`Gói "${plan.name}" chưa đặt giá cho ${currency}. Liên hệ quản trị hệ thống.`);
  }

  // payOS yêu cầu orderCode là số nguyên duy nhất; dùng mốc thời gian + phần ngẫu nhiên
  const orderCode = Number(`${Date.now()}`.slice(-10) + String(Math.floor(Math.random() * 100)).padStart(2, '0'));

  const { data: payment, error } = await supabase
    .from('payments')
    .insert({
      organization_id: org.id,
      plan_id: plan.id,
      provider: providerId,
      currency,
      amount,
      amount_vnd: currency === 'USD' ? usdToVnd(amount) : Math.round(amount),
      order_code: orderCode,
      status: 'pending',
      method: providerId,
      created_by: userId || null,
    })
    .select()
    .single();
  if (error) throw error;

  try {
    const result = await provider.createCheckout({ payment, plan, org, baseUrl: baseUrl(req) });

    await supabase
      .from('payments')
      .update({ provider_ref: result.providerRef, checkout_url: result.checkoutUrl, raw: result.raw })
      .eq('id', payment.id);

    await logEvent({
      scope: 'billing',
      organizationId: org.id,
      userId,
      message: `Tạo phiên thanh toán ${plan.name} qua ${provider.meta.name}`,
      detail: { payment_id: payment.id, amount, currency },
    });

    return { payment_id: payment.id, checkout_url: result.checkoutUrl, amount, currency };
  } catch (err) {
    // Tạo link thất bại thì đánh dấu hỏng để không để lại phiên treo
    await supabase.from('payments').update({ status: 'failed', note: err.message }).eq('id', payment.id);
    throw err;
  }
}

/**
 * Ghi nhận thanh toán thành công và nâng gói.
 *
 * Idempotent: gọi lại nhiều lần cho cùng một giao dịch chỉ có tác dụng ở lần
 * đầu — cổng thanh toán thường gọi webhook lặp khi mạng chập chờn.
 * Trả về true nếu lần gọi này thực sự kích hoạt gói.
 */
export async function markPaid({ payment, providerRef, raw, months = 1 }) {
  // paid_at là mốc duy nhất xác định "đã xử lý" — xét thêm status sẽ tạo kẽ hở
  if (payment.paid_at) {
    return { activated: false, reason: 'đã ghi nhận trước đó' };
  }

  if (providerRef && !payment.provider_ref) {
    await supabase.from('payments').update({ provider_ref: providerRef }).eq('id', payment.id);
  }
  if (raw) {
    await supabase.from('payments').update({ raw }).eq('id', payment.id);
  }

  // Hàm SQL khoá dòng payments rồi cập nhật cả payments lẫn organizations,
  // nên không thể xảy ra cảnh ghi nhận tiền mà quên gia hạn gói.
  const { data, error } = await supabase.rpc('activate_paid_plan', {
    p_payment_id: payment.id,
    p_months: months,
  });
  if (error) throw error;

  if (data) {
    await logEvent({
      scope: 'billing',
      organizationId: payment.organization_id,
      message: `Đã nhận thanh toán và gia hạn gói (${payment.amount} ${payment.currency})`,
      detail: { payment_id: payment.id, provider: payment.provider },
    });
  }

  return { activated: !!data };
}

/** Tìm giao dịch theo mã đơn hoặc theo id, giới hạn trong đúng cổng đó. */
export async function findPayment({ id, orderCode, provider }) {
  let query = supabase.from('payments').select('*');
  if (id) query = query.eq('id', id);
  else if (orderCode) query = query.eq('order_code', orderCode);
  else return null;
  if (provider) query = query.eq('provider', provider);

  const { data } = await query.maybeSingle();
  return data || null;
}

export { payos, paypal };
