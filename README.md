# Demo Chatbot RAG cho tài liệu doanh nghiệp (chi phí ~$0)

Stack: Supabase (Postgres + pgvector, free) + Cloudflare R2 (storage, free) +
DeepSeek Flash (LLM, trả theo request) + Render/Railway (hosting, free tier).

## Bước 1 — Tạo project Supabase (DB + pgvector)

1. Vào https://supabase.com → Sign up → **New project** (chọn gói Free).
2. Sau khi project tạo xong, vào **SQL Editor** → **New query**.
3. Copy toàn bộ nội dung file `supabase_schema.sql` trong thư mục này, dán vào và bấm **Run**.
   → Việc này tạo các bảng `organizations`, `documents`, `document_chunks` và bật pgvector.
4. Vào **Project Settings → API**, lấy 2 giá trị:
   - `Project URL` → điền vào `SUPABASE_URL`
   - `service_role` key (mục **Project API keys**, KHÔNG phải `anon` key) → điền vào `SUPABASE_SERVICE_ROLE_KEY`

   ⚠️ `service_role` key có toàn quyền, tuyệt đối không đưa lên frontend hay commit lên Git công khai.

## Bước 2 — Tạo bucket Cloudflare R2 (lưu file)

1. Vào https://dash.cloudflare.com → **R2** → **Create bucket**, đặt tên ví dụ `doc-chatbot-demo`.
2. Vào bucket vừa tạo → **Settings** → bật **Public access** (hoặc để riêng tư và tự ký URL nếu muốn bảo mật hơn — bản demo dùng public cho đơn giản) → copy **Public bucket URL** → điền vào `R2_PUBLIC_URL`.
3. Vào **R2 → Manage API tokens** → **Create API token** → chọn quyền **Object Read & Write**.
   Lấy `Account ID`, `Access Key ID`, `Secret Access Key` → điền vào `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. Điền tên bucket vào `R2_BUCKET_NAME`.

## Bước 3 — Lấy API key Voyage AI (dùng để tạo embedding — có 200 triệu token miễn phí)

1. Vào https://www.voyageai.com → Sign up → vào dashboard → **API Keys** → tạo key mới.
2. Điền vào `VOYAGE_API_KEY`. Mỗi tài khoản được tặng 200 triệu token miễn phí cho dòng model voyage-4 — đủ dùng rất lâu ở quy mô demo mà không tốn tiền. Kiểm tra khi đăng ký xem có yêu cầu thẻ thanh toán hay không (chính sách có thể thay đổi theo thời gian).

## Bước 4 — Lấy API key DeepSeek (dùng để chatbot trả lời)

1. Vào https://platform.deepseek.com → Đăng ký → **API keys** → **Create new key**.
2. Điền vào `DEEPSEEK_API_KEY`. Nạp một khoản nhỏ (vài đô) để test — giá rất rẻ như đã tính ở phần trước.

## Bước 5 — Cấu hình và chạy thử ở máy local

```bash
cp .env.example .env
# Mở file .env, điền đầy đủ các giá trị đã lấy ở bước 1-4

npm install
npm run dev
```

Server chạy tại `http://localhost:3000` — mở link này trên trình duyệt sẽ thấy **giao diện web demo** (không cần dùng `curl`): tạo doanh nghiệp, tải tài liệu lên, và chat trực tiếp. Trạng thái xử lý tài liệu (`processing` → `ready`) tự cập nhật trên giao diện sau vài giây.

### (Tuỳ chọn) Test bằng curl thay vì giao diện web

Nếu muốn kiểm tra API trực tiếp:

Vào Supabase → **Table Editor** → bảng `organizations` → **Insert row** → điền `name` bất kỳ (ví dụ "Công ty Demo") → copy `id` vừa tạo, dùng làm `organization_id` cho các bước dưới.

### Test upload tài liệu

```bash
curl -X POST http://localhost:3000/upload \
  -F "organization_id=<paste-organization-id-vào-đây>" \
  -F "file=@/duong-dan/toi/tai-lieu.pdf"
```

Đợi vài giây đến vài chục giây (tuỳ độ dài tài liệu) rồi kiểm tra bảng `documents` trên Supabase — cột `status` chuyển từ `processing` sang `ready` là xong.

### Test hỏi chatbot

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "organization_id": "<paste-organization-id-vào-đây>",
    "question": "Nội dung chính của tài liệu là gì?"
  }'
```

## Bước 6 — Deploy miễn phí lên Render hoặc Railway

**Render (Free Web Service):**
1. Đẩy code này lên một repo GitHub.
2. Vào https://render.com → **New → Web Service** → chọn repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Vào tab **Environment** → dán toàn bộ biến trong `.env` vào (không upload file `.env`).
5. Deploy — Render cấp cho bạn 1 URL public dạng `https://ten-app.onrender.com`.

**Sau khi deploy xong**, mở URL public (ví dụ `https://ten-app.onrender.com`) trên trình duyệt — giao diện web demo sẽ hiện ra, dùng y hệt như lúc chạy local.

**Railway** làm tương tự: **New Project → Deploy from GitHub repo**, rồi vào tab **Variables** để điền `.env`.

⚠️ Lưu ý gói Free của cả hai nền tảng đều có thể "ngủ" (sleep) sau một thời gian không có traffic, và request đầu tiên sau khi ngủ sẽ chậm (cold start vài chục giây) — chấp nhận được ở giai đoạn demo, cần nâng cấp khi có khách hàng thật.

## Giới hạn đã biết của bản demo này (nên biết trước khi thử)

- **Xử lý đồng bộ**: file được xử lý (extract → chunk → embed) ngay trong request upload, không dùng queue riêng. Với file lớn (vài trăm trang) có thể timeout trên Render Free (giới hạn ~30-60s/request tuỳ nền tảng). Đủ dùng cho tài liệu vài chục trang.
- **Chưa có OCR**: chỉ đọc được PDF có text thật (không phải file scan/ảnh) và DOCX/TXT.
- **Chưa có xác thực (auth)**: `organization_id` truyền trực tiếp trong request, ai biết ID cũng gọi được — đủ cho demo nội bộ, **chưa dùng được cho khách hàng thật**. Bước tiếp theo cần thêm Supabase Auth + kiểm tra quyền theo user đăng nhập.
- **Supabase Free tự pause sau 7 ngày không hoạt động** — nếu định để demo chạy lâu dài không ai dùng, cần ping định kỳ hoặc chấp nhận resume thủ công.
