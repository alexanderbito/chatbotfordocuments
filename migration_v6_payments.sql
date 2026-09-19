-- =====================================================================
-- MIGRATION V6 — Giá đa tiền tệ và thanh toán qua cổng
-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- An toàn khi chạy lại nhiều lần. Yêu cầu đã chạy migration_v5_folder_acl.sql.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.plans') is null then
    raise exception E'Thieu bang "plans".\n=> Ban chua chay migration_v2_auth.sql.';
  end if;
  if to_regclass('public.payments') is null then
    raise exception E'Thieu bang "payments".\n=> Ban chua chay migration_v2_auth.sql.';
  end if;
end
$guard$;

-- 1. Giá theo USD cho khách ngoài Việt Nam
--    price_vnd giữ nguyên cho khách trong nước.
alter table plans add column if not exists price_usd numeric(10,2) not null default 0;

-- Giá USD gợi ý ban đầu (admin hệ thống sửa lại được trong /sysadmin.html)
update plans set price_usd = 0  where code = 'free'     and price_usd = 0;
update plans set price_usd = 19 where code = 'pro'      and price_usd = 0;
update plans set price_usd = 79 where code = 'business' and price_usd = 0;

-- 2. Tổ chức nhớ quốc gia thanh toán đã chọn (VN dùng VietQR, còn lại dùng PayPal)
alter table organizations add column if not exists billing_country text default 'VN';

-- 3. Bổ sung cột cho bảng payments
alter table payments add column if not exists provider text not null default 'manual';   -- payos | paypal | manual
alter table payments add column if not exists currency text not null default 'VND';      -- VND | USD
alter table payments add column if not exists amount numeric(14,2) not null default 0;   -- số tiền theo đúng currency
alter table payments add column if not exists order_code bigint;                          -- mã đơn payOS (số nguyên)
alter table payments add column if not exists provider_ref text;                          -- id đơn/giao dịch bên cổng
alter table payments add column if not exists checkout_url text;
alter table payments add column if not exists paid_at timestamptz;
alter table payments add column if not exists raw jsonb;

-- Dữ liệu cũ: amount_vnd chính là amount
update payments set amount = amount_vnd where amount = 0 and amount_vnd > 0;

-- 4. CHỐNG GHI TRÙNG — quan trọng nhất của file này.
--    Cổng thanh toán có thể gọi webhook nhiều lần cho cùng một giao dịch
--    (retry khi mạng lỗi). Hai ràng buộc dưới đây đảm bảo mỗi giao dịch chỉ
--    tồn tại một dòng, nên không thể gia hạn gói hai lần cho một lần trả tiền.
create unique index if not exists payments_order_code_idx
  on payments (order_code) where order_code is not null;
create unique index if not exists payments_provider_ref_idx
  on payments (provider, provider_ref) where provider_ref is not null;

create index if not exists payments_status_idx on payments (status, created_at desc);

-- 5. Kích hoạt gói sau khi thanh toán thành công — làm trong MỘT giao dịch DB
--    để tránh tình trạng ghi nhận tiền nhưng quên nâng gói (hoặc ngược lại).
--    Trả về true nếu lần gọi này thực sự kích hoạt, false nếu đã kích hoạt trước đó.
create or replace function activate_paid_plan(
  p_payment_id uuid,
  p_months int default 1
)
returns boolean
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_current_expiry timestamptz;
  v_base timestamptz;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception 'Khong tim thay giao dich %', p_payment_id;
  end if;

  -- Đã ghi nhận rồi thì thôi, không cộng thêm lần nữa.
  -- Chỉ xét paid_at: cột này chỉ được ghi bên trong chính hàm này nên là mốc
  -- đáng tin duy nhất. Nếu xét kèm status thì một lần cập nhật status sai ở
  -- nơi khác sẽ mở đường cho việc gia hạn gói hai lần cho một lần trả tiền.
  if v_payment.paid_at is not null then
    return false;
  end if;

  select plan_expires_at into v_current_expiry
  from organizations where id = v_payment.organization_id;

  -- Còn hạn thì cộng dồn tiếp, hết hạn thì tính từ hôm nay
  v_base := greatest(coalesce(v_current_expiry, now()), now());

  update organizations
  set plan_id         = coalesce(v_payment.plan_id, plan_id),
      billing_status  = 'paid',
      plan_expires_at = v_base + (p_months || ' months')::interval,
      status          = case when status = 'suspended' then 'active' else status end
  where id = v_payment.organization_id;

  update payments
  set status  = 'paid',
      paid_at = now(),
      period_start = coalesce(period_start, v_base::date),
      period_end   = coalesce(period_end, (v_base + (p_months || ' months')::interval)::date)
  where id = p_payment_id;

  return true;
end;
$$;

-- 6. Dọn các phiên thanh toán bỏ dở quá 24 giờ
create or replace function cleanup_stale_payments()
returns int
language sql
as $$
  with updated as (
    update payments
    set status = 'expired'
    where status = 'pending'
      and created_at < now() - interval '24 hours'
    returning id
  )
  select count(*)::int from updated;
$$;
