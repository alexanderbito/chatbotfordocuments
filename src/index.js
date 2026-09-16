import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import authRouter from './routes/auth.js';
import organizationsRouter from './routes/organizations.js';
import adminRouter from './routes/admin.js';
import { supabase } from './supabaseClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '2mb' }));

// Giao diện web tĩnh
app.use(express.static(path.join(__dirname, '..', 'public')));

// API
app.use('/auth', authRouter);
app.use('/orgs', organizationsRouter);
app.use('/admin', adminRouter);

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

// 404 cho API (các route khác trả về trang tĩnh)
app.use((req, res) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/orgs') || req.path.startsWith('/admin')) {
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
