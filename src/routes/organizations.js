import express from 'express';
import { supabase } from '../supabaseClient.js';

const router = express.Router();

// GET /organizations — danh sách doanh nghiệp (để chọn trên giao diện)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, name')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /organizations — tạo nhanh doanh nghiệp mới từ giao diện (chỉ dùng cho demo)
router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Thiếu tên doanh nghiệp' });

  const { data, error } = await supabase
    .from('organizations')
    .insert({ name })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /organizations/:id/documents — danh sách tài liệu + trạng thái xử lý
router.get('/:id/documents', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('id, filename, status, created_at')
    .eq('organization_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
