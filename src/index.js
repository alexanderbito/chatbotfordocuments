import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import authRouter from './routes/auth.js';
import organizationsRouter from './routes/organizations.js';
import adminRouter from './routes/admin.js';
import { publicRouter as billingPublicRouter, webhookRouter } from './routes/billing.js';
import { purgeExpiredTrials } from './trials.js';
import { supabase } from './supabaseClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// QUAN TRỌNG: tuyến webhook phải nằm TRƯỚC express.json().
// PayPal yêu cầu gửi lại thân request nguyên văn để xác thực chữ ký, nên
// tuyến đó tự dùng express.raw(); nếu express.json() chạy trước thì luồng
// dữ liệu đã bị đọc mất và chữ ký sẽ luôn sai.
app.use('/webhooks', webhookRouter);

app.use(express.json({ limit: '2mb' }));

// Giao diện web tĩnh
app.use(express.static(path.join(__dirname, '..', 'public')));

// API
app.use('/auth', authRouter);
app.use('/orgs', organizationsRouter);
app.use('/admin', adminRouter);
app.use('/public/billing', billingPublicRouter);

// Danh sách gói cước công khai (dùng ở trang đăng ký / trang gói cước)
app.get('/public/plans', async (req, res) => {
  const { data, error } = await supabase
    .from('plans')
    .select('code, name, description, price_vnd, max_documents, max_members, max_storage_mb, max_questions_per_month')
    .eq('is_active', true)
    .order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/**
 * POST /cron/purge-trials
 * Dành cho dịch vụ cron bên ngoài gọi định kỳ (mỗi ngày một lần là đủ).
 * Bảo vệ bằng header x-cron-secret thay vì đăng nhập, vì cron không có tài khoản.
 * Không đặt CRON_SECRET thì endpoint này tắt hẳn.
 */
app.post('/cron/purge-trials', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(404).json({ error: 'Chưa bật (thiếu CRON_SECRET)' });
  if (req.headers['x-cron-secret'] !== secret) return res.status(401).json({ error: 'Sai mã bảo vệ' });

  try {
    const result = await purgeExpiredTrials();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 cho API (các route khác trả về trang tĩnh)
app.use((req, res) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/orgs') || req.path.startsWith('/admin') || req.path.startsWith('/webhooks') || req.path.startsWith('/cron')) {
    return res.status(404).json({ error: 'Không tìm thấy endpoint' });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'), (err) => {
    if (err) res.status(404).send('Không tìm thấy trang');
  });
});

// Bắt lỗi chung (ví dụ file upload quá lớn từ multer)
app.use((err, req, res, next) => {
  console.error('Lỗi không bắt được:', err);
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File vượt quá 25 MB' });
  }
  res.status(500).json({ error: err.message || 'Lỗi hệ thống' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
