import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { logEvent } from '../logger.js';
import {
  availableProviders, startCheckout, markPaid, findPayment, getProvider, payos, paypal,
} from '../payments/index.js';

const router = express.Router({ mergeParams: true });

// =====================================================================
// PHẦN CÔNG KHAI — không cần đăng nhập
// =====================================================================

/** GET /billing/plans?country=VN — bảng giá theo quốc gia */
export const publicRouter = express.Router();

publicRouter.get('/plans', async (req, res) => {
  try {
    // Tiền tệ đi theo NGÔN NGỮ người dùng đang chọn: tiếng Việt -> VNĐ, tiếng Anh -> USD.
    // Vẫn nhận tham số country cũ để không phá link đã lưu ở đâu đó.
    const currency = String(req.query.currency || (String(req.query.country || 'VN').toUpperCase() === 'VN' ? 'VND' : 'USD')).toUpperCase();
    const isVND = currency !== 'USD';

    const { data, error } = await supabase
      .from('plans')
      .select('id, code, name, name_en, description, description_en, price_vnd, price_usd, trial_days, ocr_enabled, max_documents, max_members, max_storage_mb, max_questions_per_month, max_ocr_pages_per_month')
      .eq('is_active', true)
      .order('sort_order');
    if (error) throw error;

    res.json({
      currency: isVND ? 'VND' : 'USD',
      providers: availableProviders(isVND ? 'VN' : 'INTERNATIONAL'),
      plans: (data || []).map((p) => ({
        ...p,
        // Tiếng Anh dùng name_en nếu admin đã điền, không thì giữ tên tiếng Việt
        name: isVND ? p.name : (p.name_en || p.name),
        description: isVND ? p.description : (p.description_en || p.description),
        price: isVND ? Number(p.price_vnd) : Number(p.price_usd),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// PHẦN CẦN ĐĂNG NHẬP — admin tổ chức
// =====================================================================
router.use(requireAuth, requireOrgMember, requireOrgAdmin);

/**
 * POST /orgs/:orgId/billing/checkout { plan_id, provider }
 * Lưu ý: KHÔNG nhận số tiền từ trình duyệt. Giá lấy từ bảng plans.
 */
router.post('/checkout', async (req, res) => {
  try {
    const { plan_id, provider } = req.body || {};
    if (!plan_id || !provider) return res.status(400).json({ error: 'Thiếu gói hoặc phương thức thanh toán' });

    const { data: plan } = await supabase.from('plans').select('*').eq('id', plan_id).maybeSingle();
    if (!plan) return res.status(404).json({ error: 'Không tìm thấy gói cước' });
    if (!plan.is_active) return res.status(400).json({ error: 'Gói này đã ngừng bán' });

    const result = await startCheckout({
      org: req.org,
      plan,
      providerId: provider,
      req,
      userId: req.user.id,
    });

    // Ghi nhớ quốc gia thanh toán để lần sau gợi ý đúng
    const country = provider === 'payos' ? 'VN' : 'INTERNATIONAL';
    await supabase.from('organizations').update({ billing_country: country }).eq('id', req.org.id);

    res.json(result);
  } catch (err) {
    console.error('checkout error:', err);
    res.status(400).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/billing/payments/:paymentId — trạng thái một giao dịch (trang chờ gọi) */
router.get('/payments/:paymentId', async (req, res) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('id, status, provider, provider_ref, amount, currency, order_code, paid_at, plan:plans(name)')
      .eq('id', req.params.paymentId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Không tìm thấy giao dịch' });

    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /orgs/:orgId/billing/payments/:paymentId/capture
 * PayPal cần bước thu tiền sau khi khách bấm đồng ý. Gọi khi khách quay về.
 * Webhook vẫn là đường dự phòng nếu khách đóng tab trước khi quay lại.
 */
router.post('/payments/:paymentId/capture', async (req, res) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('*')
      .eq('id', req.params.paymentId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
    if (payment.provider !== 'paypal') return res.status(400).json({ error: 'Chỉ áp dụng cho PayPal' });

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

export default router;

// =====================================================================
// WEBHOOK — công khai, KHÔNG có middleware đăng nhập.
// Bảo vệ bằng chữ ký của chính cổng thanh toán.
// =====================================================================
export const webhookRouter = express.Router();

/** payOS gọi vào đây mỗi khi có biến động thanh toán. */
webhookRouter.post('/payos', express.json(), async (req, res) => {
  try {
    // payOS gửi một request kiểm tra khi đăng ký URL — trả 200 để nó chấp nhận
    if (!req.body?.signature) return res.json({ success: true });

    const info = await payos.verifyWebhook({ body: req.body });

    const payment = await findPayment({ orderCode: info.orderCode, provider: 'payos' });
    if (!payment) {
      await logEvent({ level: 'warn', scope: 'billing', message: `Webhook payOS cho đơn lạ: ${info.orderCode}` });
      return res.json({ success: true });   // vẫn trả 200 để payOS thôi gọi lại
    }

    if (!info.paid) {
      await logEvent({ scope: 'billing', organizationId: payment.organization_id, message: `Giao dịch payOS chưa thành công (${info.raw?.desc || ''})` });
      return res.json({ success: true });
    }

    // Kiểm tra số tiền khớp với số máy chủ đã chốt — chặn trường hợp bị sửa
    if (Math.round(Number(payment.amount)) !== Math.round(info.amount)) {
      await logEvent({
        level: 'error',
        scope: 'billing',
        organizationId: payment.organization_id,
        message: 'Số tiền webhook payOS không khớp với đơn đã tạo',
        detail: { expected: payment.amount, received: info.amount, payment_id: payment.id },
      });
      return res.json({ success: true });
    }

    await markPaid({ payment, providerRef: info.providerRef, raw: info.raw });
    res.json({ success: true });
  } catch (err) {
    if (err.invalidSignature) {
      await logEvent({ level: 'error', scope: 'billing', message: 'Webhook payOS có chữ ký không hợp lệ — đã từ chối' });
      return res.status(401).json({ error: 'invalid signature' });
    }
    console.error('payos webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PayPal gọi vào đây. Dùng express.raw() vì phải gửi lại thân request
 * NGUYÊN VĂN cho API xác thực chữ ký của PayPal.
 */
webhookRouter.post('/paypal', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const info = await paypal.verifyWebhook({ headers: req.headers, rawBody: req.body });

    if (!info.paid) return res.json({ received: true });

    const payment = await findPayment({ id: info.paymentId, provider: 'paypal' });
    if (!payment) {
      await logEvent({ level: 'warn', scope: 'billing', message: `Webhook PayPal cho giao dịch lạ: ${info.paymentId}` });
      return res.json({ received: true });
    }

    if (Math.abs(Number(payment.amount) - info.amount) > 0.01) {
      await logEvent({
        level: 'error',
        scope: 'billing',
        organizationId: payment.organization_id,
        message: 'Số tiền webhook PayPal không khớp với đơn đã tạo',
        detail: { expected: payment.amount, received: info.amount, payment_id: payment.id },
      });
      return res.json({ received: true });
    }

    await markPaid({ payment, providerRef: info.providerRef, raw: info.raw });
    res.json({ received: true });
  } catch (err) {
    if (err.invalidSignature) {
      await logEvent({ level: 'error', scope: 'billing', message: 'Webhook PayPal có chữ ký không hợp lệ — đã từ chối' });
      return res.status(401).json({ error: 'invalid signature' });
    }
    console.error('paypal webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});
