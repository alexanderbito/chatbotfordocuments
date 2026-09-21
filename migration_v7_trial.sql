-- =====================================================================
-- MIGRATION V7 — Dùng thử 3 ngày, gói dùng thử không có OCR
-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- An toàn khi chạy lại nhiều lần. Yêu cầu đã chạy migration_v6_payments.sql.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.plans') is null then
    raise exception E'Thieu bang "plans".\n=> Ban chua chay migration_v2_auth.sql.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='plans' and column_name='price_usd') then
    raise exception E'Thieu cot "plans.price_usd".\n=> Ban chua chay migration_v6_payments.sql.';
  end if;
end
$guard$;

-- 1. Số ngày dùng thử của gói (0 = không phải gói dùng thử)
alter table plans add column if not exists trial_days int not null default 0;

-- 2. Gói có được dùng nhận dạng PDF scan hay không
alter table plans add column if not exists ocr_enabled boolean not null default true;

-- 3. Gói Dùng thử: 3 ngày, KHÔNG có OCR
update plans
set trial_days = 3,
    ocr_enabled = false,
    max_ocr_pages_per_month = 0,
    name = 'Dùng thử 3 ngày',
    description = 'Trải nghiệm đầy đủ tính năng trong 3 ngày. Không bao gồm nhận dạng PDF scan. Hết 3 ngày, tài liệu sẽ bị xoá nếu không nâng cấp.'
where code = 'free';

-- Các gói trả phí giữ nguyên OCR
update plans set ocr_enabled = true, trial_days = 0 where code <> 'free';

-- 3b. Tên và mô tả gói bằng tiếng Anh (hiện khi người dùng chọn English).
--     Để trống thì giao diện dùng lại bản tiếng Việt.
alter table plans add column if not exists name_en text;
alter table plans add column if not exists description_en text;

update plans set
  name_en = 'Free trial',
  description_en = 'Every feature for 3 days, except scanned-PDF OCR. Documents are deleted after 3 days unless you upgrade.'
where code = 'free' and name_en is null;

update plans set
  name_en = 'Professional',
  description_en = 'For small and medium businesses'
where code = 'pro' and name_en is null;

update plans set
  name_en = 'Business',
  description_en = 'Generous limits and priority support'
where code = 'business' and name_en is null;

-- 4. Đánh dấu tổ chức đã bị dọn dữ liệu sau khi hết hạn dùng thử
alter table organizations add column if not exists trial_data_purged_at timestamptz;
alter table organizations add column if not exists trial_started_at timestamptz;

-- Tổ chức cũ đang ở trạng thái dùng thử mà chưa có hạn thì cho 3 ngày kể từ bây giờ
update organizations o
set plan_expires_at = now() + interval '3 days',
    trial_started_at = coalesce(trial_started_at, now())
from plans p
where o.plan_id = p.id
  and p.code = 'free'
  and o.billing_status = 'trial'
  and o.plan_expires_at is null;

create index if not exists organizations_trial_expiry_idx
  on organizations (billing_status, plan_expires_at)
  where billing_status = 'trial';

-- 5. Liệt kê các tổ chức đã hết hạn dùng thử và cần dọn dữ liệu.
--    Chỉ trả về danh sách; việc xoá file trên R2 phải do ứng dụng làm,
--    nên phần xoá thật nằm ở src/trials.js chứ không nằm trong SQL.
create or replace function list_expired_trials(grace_hours int default 0)
returns table (
  organization_id uuid,
  organization_name text,
  expired_at timestamptz,
  document_count bigint
)
language sql stable
as $$
  select o.id, o.name, o.plan_expires_at,
         (select count(*) from documents d where d.organization_id = o.id)
  from organizations o
  join plans p on p.id = o.plan_id
  where p.trial_days > 0
    and o.billing_status = 'trial'
    and o.plan_expires_at is not null
    and o.plan_expires_at < now() - (grace_hours || ' hours')::interval
    and o.trial_data_purged_at is null
  order by o.plan_expires_at;
$$;

-- =====================================================================
-- LƯU Ý: gói Dùng thử nay giới hạn 3 ngày. Các tổ chức đang dùng gói này
-- mà chưa có hạn sẽ được tính 3 ngày kể từ lúc chạy migration, chứ không
-- bị xoá dữ liệu ngay.
-- =====================================================================
