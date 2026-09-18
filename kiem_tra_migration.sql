-- =====================================================================
-- CHẨN ĐOÁN: database đang ở giai đoạn migration nào?
-- Chạy trong Supabase SQL Editor. Chỉ đọc, không thay đổi gì.
-- =====================================================================
select
  m.buoc,
  m.file_can_chay,
  case when to_regclass(m.bang_kiem_tra) is null
       then '❌ CHƯA CHẠY'
       else '✅ đã chạy' end as trang_thai,
  m.bang_kiem_tra as bang_dai_dien
from (values
  (1, 'supabase_schema.sql',        'public.organizations'),
  (2, 'migration_v2_auth.sql',      'public.folders'),
  (3, 'migration_v3_ocr.sql',       'public.documents'),
  (4, 'migration_v4_ocr_retry.sql', 'public.document_ocr_batches'),
  (5, 'migration_v5_folder_acl.sql','public.folder_permissions')
) as m(buoc, file_can_chay, bang_kiem_tra)
order by m.buoc;

-- Kiểm tra riêng các CỘT mà v3/v4/v5 thêm vào (bảng có thể đã tồn tại
-- nhưng migration vẫn chưa chạy xong)
select
  'documents.ocr_pages (v3)'        as cot,
  case when exists (select 1 from information_schema.columns
       where table_schema='public' and table_name='documents' and column_name='ocr_pages')
       then '✅ có' else '❌ thiếu' end as trang_thai
union all select 'documents.ocr_attempts (v4)',
  case when exists (select 1 from information_schema.columns
       where table_schema='public' and table_name='documents' and column_name='ocr_attempts')
       then '✅ có' else '❌ thiếu' end
union all select 'folders.visibility (v5)',
  case when exists (select 1 from information_schema.columns
       where table_schema='public' and table_name='folders' and column_name='visibility')
       then '✅ có' else '❌ thiếu' end;

-- Danh sách toàn bộ bảng đang có trong schema public
select table_name as bang_hien_co
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name;

-- Bạn đang chạy trên database nào?
select current_database() as database, current_user as nguoi_dung, current_schema() as schema_mac_dinh;
