# DocBot — SaaS chatbot hỏi đáp tài liệu doanh nghiệp

Mỗi doanh nghiệp đăng ký một tài khoản quản trị, tải tài liệu lên (có chia thư mục),
hệ thống lập chỉ mục và tạo chatbot trả lời **chỉ trong phạm vi tài liệu của doanh nghiệp đó**.
Admin mời thành viên vào tổ chức; thành viên chỉ trò chuyện với chatbot.

Stack: Node/Express · Supabase (Postgres + pgvector) · Cloudflare R2 · Voyage AI (embedding) ·
DeepSeek (LLM) · Render/Railway (hosting). Giao diện là HTML/CSS/JS thuần, **không cần build step**.

---

## 1. Ba vai trò trong hệ thống

| Vai trò | Truy cập | Làm được gì |
|---|---|---|
| **Admin hệ thống** (super admin) | `/sysadmin.html` | Quản lý toàn bộ doanh nghiệp, gói cước, thanh toán, người dùng, nhật ký, sức khoẻ hệ thống |
| **Admin tổ chức** | `/admin.html` | Tải lên / xoá / tải xuống tài liệu, quản lý thư mục, mời & phân quyền thành viên, xem lịch sử hỏi đáp, xem hạn mức gói |
| **Thành viên** | `/chat.html` | Chỉ trò chuyện với chatbot và xem lịch sử của chính mình |

Toàn bộ API đều kiểm tra quyền ở backend, không chỉ ẩn nút trên giao diện.

---

## 2. Các trang giao diện

| Đường dẫn | Mục đích |
|---|---|
| `/login.html` | Đăng nhập |
| `/register.html` | Đăng ký doanh nghiệp mới, hoặc tham gia qua link mời (`?invite=<token>`) |
| `/chat.html` | Không gian hỏi đáp cho mọi thành viên |
| `/admin.html` | Console admin tổ chức: Tổng quan · Tài liệu & thư mục · Thành viên · Lịch sử hỏi đáp · Gói cước · Thiết lập |
| `/sysadmin.html` | Console admin hệ thống: Bảng điều khiển · Tổ chức · Gói cước · Thanh toán · Người dùng · Nhật ký · Sức khoẻ hệ thống |
| `/` | Tự chuyển hướng theo vai trò của người đang đăng nhập |

---

## 3. Cài đặt lần đầu

### Bước 1 — Cơ sở dữ liệu

Trong **Supabase Dashboard → SQL Editor → New query**, chạy lần lượt:

1. `supabase_schema.sql` — chỉ cần chạy nếu đây là project mới (tạo `organizations`, `documents`, `document_chunks`, bật pgvector).
2. `migration_v2_auth.sql` — **bắt buộc**, tạo phần auth/phân quyền/thư mục/gói cước/nhật ký và cập nhật hàm tìm kiếm.

File `migration_v2_auth.sql` chạy lại nhiều lần vẫn an toàn (dùng `if not exists`).

> Nếu project đang dùng embedding 1536 chiều (OpenAI cũ), chạy `migration_to_voyage.sql` trước.

### Bước 2 — Biến môi trường

```bash
cp .env.example .env    # rồi điền giá trị thật
```

So với bản cũ có **thêm một biến**: `SUPABASE_ANON_KEY`
(Supabase Dashboard → Project Settings → API → `anon public`).
Bỏ trống vẫn chạy được nhưng nên điền cho đúng chuẩn bảo mật.

Bucket R2 giờ **không cần để public**: hệ thống tạo link tải có chữ ký, hết hạn sau 5 phút,
và chỉ admin tổ chức mới lấy được link.

### Bước 3 — Chạy thử

```bash
npm install
npm run dev        # http://localhost:3000
```

### Bước 4 — Tạo admin hệ thống đầu tiên

1. Vào `/register.html`, đăng ký một tài khoản (ví dụ với tên doanh nghiệp "Quản trị hệ thống").
2. Trong Supabase SQL Editor chạy:

```sql
update app_users set is_system_admin = true where email = 'email-cua-ban@example.com';
```

3. Đăng nhập lại — bạn sẽ được đưa thẳng vào `/sysadmin.html`.

---

## 4. Deploy lên Render

Cấu hình **không đổi** so với bản cũ:

- Build command: `npm install`
- Start command: `npm start`
- Tab **Environment**: dán toàn bộ biến trong `.env` (nhớ **thêm `SUPABASE_ANON_KEY`** khi deploy bản này).

Sau khi deploy, nhớ chạy `migration_v2_auth.sql` trên Supabase **trước** khi mở giao diện,
nếu không các trang sẽ báo lỗi thiếu bảng.

Gói Free của Render "ngủ" sau một thời gian không có traffic — request đầu tiên sau khi ngủ
sẽ chậm vài chục giây.

---

## 5. Bản đồ API

```
POST   /auth/register                         đăng ký doanh nghiệp mới hoặc nhận lời mời
POST   /auth/login                            đăng nhập
GET    /auth/me                               hồ sơ + danh sách tổ chức
POST   /auth/change-password
PATCH  /auth/profile
GET    /auth/invite/:token                    xem thông tin lời mời (công khai)

GET    /orgs/:orgId                           thông tin tổ chức + vai trò
PATCH  /orgs/:orgId                           sửa hồ sơ doanh nghiệp          (admin tổ chức)
GET    /orgs/:orgId/overview                  số liệu dashboard               (admin tổ chức)
GET    /orgs/:orgId/billing                   gói cước + lịch sử thanh toán   (admin tổ chức)

GET    /orgs/:orgId/folders                   cây thư mục
POST   | PATCH | DELETE  /orgs/:orgId/folders quản lý thư mục                 (admin tổ chức)

GET    /orgs/:orgId/documents                 danh sách tài liệu              (admin tổ chức)
POST   /orgs/:orgId/documents                 tải lên (multipart: file, folder_id)
PATCH  /orgs/:orgId/documents/:id             đổi tên / chuyển thư mục
GET    /orgs/:orgId/documents/:id/download    link tải có chữ ký (5 phút)
POST   /orgs/:orgId/documents/:id/reindex     xử lý lại tài liệu lỗi
DELETE /orgs/:orgId/documents/:id             xoá tài liệu + chunk + file R2

GET    | POST | PATCH | DELETE  /orgs/:orgId/members   quản lý thành viên     (admin tổ chức)

POST   /orgs/:orgId/chat                      hỏi chatbot (mọi thành viên)
GET    /orgs/:orgId/chat/mine                 lịch sử của chính mình
GET    /orgs/:orgId/chat/history              toàn bộ lịch sử                 (admin tổ chức)

/admin/*                                      toàn bộ khu vực admin hệ thống
       overview · organizations · users · plans · payments · logs
       failed-documents · health
```

Xác thực: header `Authorization: Bearer <access_token>` (token do Supabase Auth cấp).

---

## 6. Hạn mức theo gói cước

Backend chặn ở mức API, không chỉ hiển thị:

- Tải tài liệu: kiểm tra số tài liệu và dung lượng còn lại → trả `402` nếu vượt.
- Mời thành viên: kiểm tra số thành viên tối đa.
- Hỏi chatbot: kiểm tra số lượt hỏi trong tháng.

Ba gói mặc định (Dùng thử / Chuyên nghiệp / Doanh nghiệp) được tạo sẵn bởi migration
và có thể sửa trong `/sysadmin.html → Gói cước`.

---

## 7. Xử lý sự cố thường gặp

**Tên tài liệu hiển thị lỗi font** (`Quy định` thành `Quy Ä‘á»‹nh`)

Nguyên nhân: multer 1.x đọc tên file trong header multipart theo latin-1, còn macOS
gửi tên ở dạng NFD (ký tự và dấu tách rời). Đã xử lý trong `src/utils/filename.js`:
tên hiển thị được giải mã lại và chuẩn hoá NFC, còn key lưu trên R2 dùng bản không dấu
thuần ASCII cho an toàn khi ký URL.

Tài liệu đã tải lên **trước** bản vá vẫn giữ tên sai trong CSDL. Để sửa:
`/sysadmin.html` → **Sức khoẻ hệ thống** → **Bảo trì dữ liệu** → "Xem trước danh sách"
rồi "Sửa tên tài liệu". (Tương đương `POST /admin/maintenance/fix-filenames`,
thêm `?dry_run=1` để chỉ xem trước.)

## 8. Giới hạn đã biết

- **Xử lý tài liệu đồng bộ trong tiến trình web**: file rất lớn có thể timeout trên Render Free.
  Khi có khách hàng thật nên tách thành worker riêng.
- **Chưa có OCR**: chỉ đọc PDF có text thật, DOCX và TXT. PDF scan sẽ báo lỗi kèm nguyên nhân
  và có thể bấm "Xử lý lại" sau khi thay file.
- **Lời mời gửi bằng link thủ công**: hệ thống tạo link mời để admin tự gửi, chưa gắn dịch vụ email.
- **Thanh toán ghi nhận thủ công**: admin hệ thống nhập giao dịch, chưa tích hợp cổng thanh toán.
- **Supabase Free tự pause sau 7 ngày không hoạt động.**
