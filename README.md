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
| **Thành viên** | `/chat.html` | Chỉ trò chuyện với chatbot **trong phạm vi thư mục được cấp quyền**, và xem lịch sử của chính mình |

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
| `/pricing.html` | Bảng giá công khai, tiền tệ đi theo ngôn ngữ đang chọn |
| `/billing-return.html` | Trang kết quả sau khi khách thanh toán xong |
| `/` | Tự chuyển hướng theo vai trò của người đang đăng nhập |

---

## 3. Cài đặt lần đầu

### Bước 1 — Cơ sở dữ liệu

Trong **Supabase Dashboard → SQL Editor → New query**, chạy lần lượt:

1. `supabase_schema.sql` — chỉ cần chạy nếu đây là project mới (tạo `organizations`, `documents`, `document_chunks`, bật pgvector).
2. `migration_v2_auth.sql` — **bắt buộc**, tạo phần auth/phân quyền/thư mục/gói cước/nhật ký và cập nhật hàm tìm kiếm.
3. `migration_v3_ocr.sql` — **bắt buộc**, thêm hạn mức và cột theo dõi OCR.
4. `migration_v4_ocr_retry.sql` — **bắt buộc**, thêm bộ đếm lần thử và bảng lưu tạm kết quả OCR.
5. `migration_v5_folder_acl.sql` — **bắt buộc**, thêm chế độ thư mục công khai/riêng tư và phân quyền theo email.
6. `migration_v6_payments.sql` — **bắt buộc**, thêm giá USD và thanh toán qua cổng.
7. `migration_v7_trial.sql` — **bắt buộc**, đặt gói miễn phí thành dùng thử 3 ngày không có OCR.

**Chạy đúng thứ tự.** Mỗi file từ v3 trở đi có bước kiểm tra điều kiện ở đầu và sẽ dừng
kèm thông báo nếu file trước chưa chạy.

Nếu gặp lỗi `relation "..." does not exist`, chạy `kiem_tra_migration.sql` — file này liệt kê
database đang ở giai đoạn nào và những bảng hiện có. Nguyên nhân thường gặp:

- Chưa chạy file migration trước đó.
- **SQL Editor đang mở nhầm project Supabase.** Nếu ứng dụng trên Render vẫn chạy bình thường
  mà SQL Editor báo thiếu bảng, gần như chắc chắn là trường hợp này — đối chiếu `SUPABASE_URL`
  trong tab Environment của Render với project đang mở trên dashboard.

File `migration_v2_auth.sql` chạy lại nhiều lần vẫn an toàn (dùng `if not exists`).

> Nếu project đang dùng embedding 1536 chiều (OpenAI cũ), chạy `migration_to_voyage.sql` trước.

### Bước 2 — Biến môi trường

```bash
cp .env.example .env    # rồi điền giá trị thật
```

So với bản gốc có **thêm các biến**:

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `SUPABASE_ANON_KEY` | Nên có | Supabase → Project Settings → API → `anon public` |
| `GEMINI_API_KEY` | Chỉ khi cần OCR | Lấy tại https://aistudio.google.com/apikey |
| `GEMINI_OCR_MODELS` | Không | Chuỗi model dự phòng, mặc định `gemini-3.5-flash,gemini-3.5-flash-lite` |
| `OCR_RETRY_ROUNDS` | Không | Số vòng thử lại mỗi lô trang, mặc định 5 |
| `OCR_DOC_RETRIES` | Không | Số lần tự hẹn chạy lại cả tài liệu, mặc định 3 |
| `OCR_MAX_PAGES` | Không | Mặc định 30 trang/file |
| `WORKER_CONCURRENCY` | Không | Mặc định 1 — giữ nguyên trên Render Free |
| `PAYOS_CLIENT_ID` / `PAYOS_API_KEY` / `PAYOS_CHECKSUM_KEY` | Nếu bán cho khách VN | Lấy tại payos.vn |
| `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET` / `PAYPAL_WEBHOOK_ID` | Nếu bán cho khách nước ngoài | Lấy tại developer.paypal.com |
| `APP_BASE_URL` | Không | URL công khai; trên Render tự đọc `RENDER_EXTERNAL_URL` |
| `SYSTEM_ADMIN_EMAILS` | Nên có | Email luôn có quyền quản trị hệ thống, ngăn cách bằng dấu phẩy |
| `CRON_SECRET` | Nên có | Bảo vệ endpoint dọn dữ liệu hết hạn dùng thử |
| `TRIAL_GRACE_HOURS` | Không | Số giờ ân hạn trước khi xoá, mặc định 0 |

Bucket R2 giờ **không cần để public**: hệ thống tạo link tải có chữ ký, hết hạn sau 5 phút,
và chỉ admin tổ chức mới lấy được link.

### Bước 3 — Chạy thử

```bash
npm install
npm run dev        # http://localhost:3000
```

### Bước 4 — Tạo tài khoản quản trị hệ thống đầu tiên

Có ba cách, chọn một.

**Cách 1 — biến môi trường (khuyến nghị).** Đặt `SYSTEM_ADMIN_EMAILS` trên Render
(hoặc trong `.env` khi chạy local), rồi vào `/register.html` đăng ký bằng đúng email đó:

```
SYSTEM_ADMIN_EMAILS=ban@congty.vn
```

Email nằm trong biến này **không bị bắt nhập tên doanh nghiệp** và không tạo tổ chức rác —
tài khoản quản trị hệ thống đứng ngoài mọi tổ chức. Đăng nhập xong vào thẳng `/sysadmin.html`.

Biến này cũng là đường "phá kính lấy búa": quyền hiệu lực = cờ trong CSDL **hoặc** email
nằm trong danh sách. Nếu lỡ tự gỡ quyền hay mất tài khoản, thêm email vào đây là vào lại được.

**Cách 2 — dòng lệnh.** Đăng ký tài khoản bình thường trước, rồi chạy ở máy có `.env`:

```bash
npm run make-admin -- ban@congty.vn          # cấp quyền
npm run make-admin -- ban@congty.vn --revoke # gỡ quyền
npm run make-admin -- --list                 # xem ai đang có quyền
```

**Cách 3 — SQL.** Đăng ký trước, rồi chạy trong Supabase SQL Editor:

```sql
update app_users set is_system_admin = true where email = 'ban@congty.vn';
```

Khi đã có một tài khoản quản trị, những tài khoản sau tạo thẳng trong
`/sysadmin.html → Người dùng → Tạo tài khoản quản trị`.

⚠️ Quản trị hệ thống **đọc được tài liệu và lịch sử hỏi đáp của mọi doanh nghiệp**.
Chỉ cấp cho người thực sự cần.

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
POST   /orgs/:orgId/billing/checkout          tạo phiên thanh toán            (admin tổ chức)
GET    /orgs/:orgId/billing/payments/:id      trạng thái giao dịch            (admin tổ chức)
POST   /orgs/:orgId/billing/payments/:id/capture  thu tiền PayPal             (admin tổ chức)

GET    /public/billing/plans?currency=VND     bảng giá công khai (VND | USD)
POST   /cron/purge-trials                     dọn dữ liệu hết hạn (header x-cron-secret)
POST   /admin/maintenance/purge-trials        dọn thủ công        (admin hệ thống)
POST   /webhooks/payos                        webhook payOS  (xác thực bằng chữ ký)
POST   /webhooks/paypal                       webhook PayPal (xác thực bằng chữ ký)

GET    /orgs/:orgId/folders                   cây thư mục (đã lọc theo quyền của người gọi)
POST   | PATCH | DELETE  /orgs/:orgId/folders quản lý thư mục                 (admin tổ chức)
GET    /orgs/:orgId/folders/:id/permissions   email đang được đọc thư mục     (admin tổ chức)
PUT    /orgs/:orgId/folders/:id/permissions   đặt lại danh sách email         (admin tổ chức)

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
       failed-documents · health · maintenance/fix-filenames
POST   /admin/users                           tạo tài khoản quản trị hệ thống mới
GET    /admin/system-admins                   ai đang có quyền quản trị hệ thống
```

Xác thực: header `Authorization: Bearer <access_token>` (token do Supabase Auth cấp).

---

## 6. Hạn mức theo gói cước

Backend chặn ở mức API, không chỉ hiển thị:

- Tải tài liệu: kiểm tra số tài liệu và dung lượng còn lại → trả `402` nếu vượt.
- Mời thành viên: kiểm tra số thành viên tối đa.
- Hỏi chatbot: kiểm tra số lượt hỏi trong tháng.
- Nhận dạng PDF scan: kiểm tra số trang OCR còn lại trong tháng (xem mục 8).

Ba gói mặc định (Dùng thử / Chuyên nghiệp / Doanh nghiệp) được tạo sẵn bởi migration
và có thể sửa trong `/sysadmin.html → Gói cước`.

---

## 7. Xử lý sự cố thường gặp

**PDF scan không đọc được / báo lỗi OCR**

Kiểm tra `/sysadmin.html` → **Sức khoẻ hệ thống** → dòng "Gemini (nhận dạng PDF scan)".
Nếu báo "Chưa bật" nghĩa là thiếu `GEMINI_API_KEY`. Nếu tài liệu bị chặn vì hạn mức,
lỗi sẽ ghi rõ trong cột trạng thái ở trang Tài liệu của admin tổ chức.

**Tên tài liệu hiển thị lỗi font** (`Quy định` thành `Quy Ä‘á»‹nh`)

Nguyên nhân: multer 1.x đọc tên file trong header multipart theo latin-1, còn macOS
gửi tên ở dạng NFD (ký tự và dấu tách rời). Đã xử lý trong `src/utils/filename.js`:
tên hiển thị được giải mã lại và chuẩn hoá NFC, còn key lưu trên R2 dùng bản không dấu
thuần ASCII cho an toàn khi ký URL.

Tài liệu đã tải lên **trước** bản vá vẫn giữ tên sai trong CSDL. Để sửa:
`/sysadmin.html` → **Sức khoẻ hệ thống** → **Bảo trì dữ liệu** → "Xem trước danh sách"
rồi "Sửa tên tài liệu". (Tương đương `POST /admin/maintenance/fix-filenames`,
thêm `?dry_run=1` để chỉ xem trước.)

## 8. Thư mục công khai và riêng tư

Mỗi thư mục có một chế độ truy cập:

- **Công khai** (mặc định): mọi thành viên trong tổ chức đều hỏi chatbot được về tài liệu bên trong.
- **Riêng tư**: chỉ những email được admin cấp quyền mới đọc được.

### Bốn quy tắc cần nhớ

**1. Kế thừa hạn chế từ thư mục cha.** Muốn đọc một thư mục thì phải có quyền ở *tất cả*
thư mục cha riêng tư nằm trên đường đi tới nó. Một thư mục công khai đặt bên trong thư mục
riêng tư vẫn bị hạn chế — nhờ vậy không thể vô tình lộ dữ liệu bằng cách tạo thư mục con.

**2. Ẩn hoàn toàn.** Thành viên không có quyền sẽ không thấy tên thư mục ở bất kỳ đâu,
kể cả trong ô chọn phạm vi khi chat. Bản thân tên thư mục ("Lương ban giám đốc") cũng là
thông tin nhạy cảm.

**3. Chatbot không đọc được nội dung không được phép.** Backend tính danh sách thư mục
người hỏi được đọc, rồi truyền vào hàm tìm kiếm `match_document_chunks_acl`. Cách này
"fail closed": nếu việc tính quyền có sai sót thì người dùng không thấy gì, thay vì thấy
nhầm tài liệu mật. Nếu người dùng tự chỉ định `folder_ids` ngoài phạm vi, API trả `403`.

**4. Admin tổ chức đọc được tất cả.** Họ vốn đã quản lý toàn bộ tài liệu nên không cần
cấp quyền riêng.

### Vài điểm vận hành

- Chỉ cấp quyền được cho email **đã là thành viên** của tổ chức. Email lạ bị bỏ qua và
  giao diện báo lại, tránh trường hợp gõ nhầm rồi tưởng đã cấp quyền.
- Gỡ một thành viên khỏi tổ chức sẽ thu hồi luôn quyền đọc các thư mục riêng tư của họ.
- Chuyển một thư mục từ riêng tư về công khai sẽ xoá danh sách quyền cũ.
- Xoá một thư mục riêng tư còn tài liệu bên trong: API trả `409` bắt xác nhận, vì tài liệu
  sẽ rơi về mục "Chưa phân loại" và cả tổ chức đọc được.
- Tài liệu chưa phân loại (`folder_id = null`) được coi là công khai trong tổ chức.

## 9. Dùng thử 3 ngày

Gói miễn phí nay là **bản dùng thử 3 ngày**: đủ mọi tính năng **trừ nhận dạng PDF scan**.
Hết 3 ngày mà không nâng cấp thì tài liệu bị xoá.

### Ba mốc

**Trong 3 ngày.** Đồng hồ chạy từ lúc đăng ký (`organizations.plan_expires_at`).
Giao diện hiện dải băng đếm ngược ở mọi trang, chuyển vàng khi còn dưới 24 giờ.

**Hết hạn.** Chặn hỏi chatbot và tải tài liệu lên (trả mã `402`), nhưng **vẫn vào được
trang gói cước và thiết lập** để nâng cấp. Cố ý không chặn ở tầng chung, vì chặn hết
thì khách không còn đường trả tiền.

**Sau khi hết hạn.** Dọn tài liệu, file trên R2, các đoạn đã lập chỉ mục, bản OCR tạm
và lịch sử hỏi đáp. **Giữ lại** tài khoản, tổ chức, thành viên và cây thư mục — khách
quay lại nâng cấp là dùng được ngay, không phải đăng ký từ đầu.

### Việc dọn chạy khi nào

Hai đường, để không phụ thuộc vào một thứ duy nhất:

1. **Bám theo lưu lượng** — mỗi khi có request, nếu đã quá 6 giờ kể từ lần dọn trước
   thì chạy một lượt ở chế độ nền. Không cần cấu hình gì.
2. **Cron ngoài** — `POST /cron/purge-trials` kèm header `x-cron-secret`. Nên trỏ một
   dịch vụ cron miễn phí vào đây chạy mỗi ngày, vì Render Free ngủ sau 15 phút không
   có traffic nên đường (1) có thể không chạy với tổ chức bị bỏ hoang.

Admin hệ thống cũng dọn thủ công được: `POST /admin/maintenance/purge-trials`
(thêm `?dry_run=1` để chỉ xem danh sách).

### Gói nào có OCR

Cột `plans.ocr_enabled`, bật/tắt trong `/sysadmin.html → Gói cước`. Gói tắt OCR mà
gặp PDF scan sẽ báo lỗi kèm gợi ý nâng cấp và **không gọi Gemini**, nên không phát
sinh chi phí.

## 10. Song ngữ Việt / Anh

Nút **VI / EN** nằm ở thanh bên (trang nội bộ) và góc trên bên phải (trang công khai).
Lựa chọn lưu trong trình duyệt; lần đầu vào thì đoán theo ngôn ngữ hệ điều hành.

**Ngôn ngữ quyết định tiền tệ:** tiếng Việt xem giá VNĐ và thanh toán VietQR,
tiếng Anh xem giá USD và thanh toán PayPal. Không còn nút chọn quốc gia riêng.

### Cách dịch hoạt động

`public/assets/i18n.js` dùng **chính chuỗi tiếng Việt làm khoá**. Thiếu bản dịch thì
giao diện hiện tiếng Việt chứ không vỡ thành mã khoá.

Có hai đường: `t('...')` gọi trực tiếp khi dựng chuỗi, và `translateDOM()` quét DOM
sau mỗi lần render (cần thiết vì các trang dựng HTML bằng `innerHTML`). Phần quét chỉ
dịch khi nội dung khớp **chính xác** một khoá, và bỏ qua mọi thứ nằm trong phần tử
đánh dấu `data-no-i18n` — tên tài liệu, tên thư mục, email, nội dung chat.

Tên và mô tả gói cước lấy từ CSDL nên có cột riêng `plans.name_en` và
`plans.description_en`, sửa trong `/sysadmin.html`. Bỏ trống thì hiện bản tiếng Việt.

Console admin hệ thống (`/sysadmin.html`) giữ nguyên tiếng Việt vì chỉ nội bộ dùng.

## 11. Thanh toán

Khách chọn quốc gia ở `/pricing.html`; trang tự đoán theo múi giờ trình duyệt và
người dùng đổi lại được.

| Khách | Tiền tệ | Cổng | Vì sao |
|---|---|---|---|
| Việt Nam | VNĐ | **payOS** (VietQR) | Miễn phí giao dịch, quét mã bằng app ngân hàng bất kỳ |
| Ngoài Việt Nam | USD | **PayPal** | Stripe không hỗ trợ doanh nghiệp đặt tại Việt Nam |

Giá mỗi gói lưu hai cột: `plans.price_vnd` và `plans.price_usd`, sửa được trong
`/sysadmin.html → Gói cước`.

### Luồng

1. Admin tổ chức chọn gói → `POST /orgs/:orgId/billing/checkout {plan_id, provider}`
2. Máy chủ tạo bản ghi `payments` trạng thái `pending` rồi gọi cổng tạo link
3. Khách thanh toán trên trang của cổng
4. Cổng gọi webhook → hệ thống xác thực chữ ký → gọi `activate_paid_plan()` → gói có hiệu lực ngay
5. Khách quay về `/billing-return.html`, trang này hỏi lại trạng thái vài lần rồi báo kết quả

Với PayPal còn một bước thu tiền (`capture`) gọi khi khách quay lại; webhook là
đường dự phòng nếu khách đóng tab giữa chừng.

### Bốn chốt chặn an toàn

**1. Số tiền luôn tính ở máy chủ.** Trình duyệt chỉ gửi `plan_id` và `provider`.
Gửi kèm `amount` cũng bị bỏ qua.

**2. Xác thực chữ ký webhook.** payOS dùng SDK chính thức `@payos/node`
(thuật toán HMAC của họ có vài chi tiết dễ sai, tự ký là rủi ro không cần thiết).
PayPal xác thực qua chính API `verify-webhook-signature` của họ — vì vậy tuyến
webhook PayPal phải nằm **trước** `express.json()` trong `src/index.js` và dùng
`express.raw()`, do PayPal yêu cầu gửi lại thân request nguyên văn.

**3. Đối chiếu số tiền.** Webhook báo số tiền khác với đơn đã tạo thì bị bỏ qua
và ghi nhật ký mức `error`.

**4. Chống cộng gói hai lần.** Cổng thanh toán hay gọi webhook lặp khi mạng lỗi.
Có ba lớp: chốt chặn ở ứng dụng (`payments.paid_at`), chốt chặn trong hàm SQL
`activate_paid_plan()` (khoá dòng bằng `for update`), và ràng buộc `unique` trên
`order_code` cùng `(provider, provider_ref)`. Mốc duy nhất xác định "đã xử lý" là
`paid_at`, vì cột này chỉ được ghi bên trong hàm SQL đó.

Nếu gói hiện tại còn hạn, thời gian còn lại được **cộng dồn** chứ không mất.

### Chưa làm

- **Chưa tự động trừ tiền định kỳ.** Mỗi kỳ khách phải chủ động thanh toán lại.
- **Chưa xuất hoá đơn VAT.** payOS đăng ký bằng CCCD nghĩa là tiền vào tài khoản
  cá nhân. Bán thật cho doanh nghiệp cần pháp nhân và kết nối hoá đơn điện tử —
  payOS có sẵn API hoá đơn (`invoices`) để nối sau.
- **Chưa hoàn tiền trong giao diện**; phải xử lý bên trang của cổng thanh toán.

## 12. OCR cho PDF scan

Khi tải lên một PDF, hệ thống đọc text thật trước. Nếu thu được dưới ~60 ký tự mỗi trang
thì coi đó là bản scan và chuyển sang nhận dạng bằng Gemini.

Cách hoạt động:

1. `pdf-lib` tách file thành từng lô 5 trang (thuần JS, không cần thư viện native).
2. Mỗi lô gửi thẳng dưới dạng PDF tới `generativelanguage.googleapis.com` — **không cần**
   bước render trang thành ảnh, nên deploy Render giữ nguyên, không cần Docker.
3. Text nhận được ghép lại rồi đi tiếp vào pipeline chia đoạn và tạo embedding như bình thường.
4. Gặp lỗi tạm thời sẽ thử lại theo ba tầng (xem bên dưới).

### Chống lỗi "model is overloaded"

Gemini hay trả 503 *"This model is currently experiencing high demand"* vào giờ cao điểm.
Hệ thống xử lý ở ba tầng:

**Tầng 1 — đổi model.** Khi model chính báo quá tải, thử ngay model kế tiếp trong
`GEMINI_OCR_MODELS`. Quá tải thường xảy ra trên từng model riêng lẻ, nên model nhẹ hơn
vẫn chạy được — tầng này thường giải quyết xong mà không phải chờ giây nào.

**Tầng 2 — backoff luỹ thừa có jitter.** Nếu cả chuỗi model đều bận, chờ 1s → 2s → 4s → 8s…
(trần 60s, dao động ngẫu nhiên ±30% để nhiều tiến trình không cùng gọi lại một lúc),
tối đa `OCR_RETRY_ROUNDS` vòng. Đây đúng khuyến nghị chính thức của Google.

**Tầng 3 — hẹn giờ chạy lại cả tài liệu.** Quá tải kéo dài thì tài liệu chuyển sang trạng thái
**Chờ thử lại** và tự chạy lại sau 2 → 5 → 10 phút, tối đa `OCR_DOC_RETRIES` lần.
Giao diện hiển thị thời điểm sẽ chạy lại; admin vẫn có thể bấm "Chạy lại ngay".

**Không nhận dạng lại phần đã xong.** Mỗi lô trang OCR thành công được lưu vào
`document_ocr_batches`. Lần thử lại chỉ gọi Gemini cho những lô còn thiếu — tiết kiệm cả
thời gian lẫn hạn mức. Bảng tạm được xoá khi tài liệu hoàn tất.

Lỗi *không* tạm thời (sai API key, request hỏng, tài liệu bị chặn) báo hỏng ngay,
không thử lại vô ích.

Tài liệu đang OCR hiển thị trạng thái **Đang nhận dạng** (hoặc **Chờ thử lại**) trên giao diện admin tổ chức,
và số trang đã nhận dạng được ghi vào cột `documents.ocr_pages` để tính hạn mức.

**Hạn mức theo gói** (`plans.max_ocr_pages_per_month`, sửa được trong `/sysadmin.html`):
Dùng thử 50 trang/tháng · Chuyên nghiệp 2.000 · Doanh nghiệp 20.000.

**Hàng đợi**: OCR chạy tuần tự (`WORKER_CONCURRENCY=1`) vì Render Free chỉ có 512 MB RAM.
Nhiều file tải lên cùng lúc sẽ xếp hàng chứ không chạy song song. Trạng thái hàng đợi
xem được ở trang Sức khoẻ hệ thống. Khi có khách hàng thật nên tách thành
Background Worker riêng trên Render.

## 13. Giới hạn đã biết

- **Xử lý tài liệu đồng bộ trong tiến trình web**: file rất lớn có thể timeout trên Render Free.
  Khi có khách hàng thật nên tách thành worker riêng.
- **OCR giới hạn 30 trang mỗi file** (đổi bằng `OCR_MAX_PAGES`). File dài hơn cần tách nhỏ.
  Giới hạn này có chủ đích: OCR tính tiền theo trang và chạy lâu.
- **Lời mời gửi bằng link thủ công**: hệ thống tạo link mời để admin tự gửi, chưa gắn dịch vụ email.
- **Thanh toán ghi nhận thủ công**: admin hệ thống nhập giao dịch, chưa tích hợp cổng thanh toán.
- **Supabase Free tự pause sau 7 ngày không hoạt động.**
