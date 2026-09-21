import 'dotenv/config';

/**
 * Danh sách email luôn có quyền admin hệ thống, khai báo qua biến môi trường.
 *
 * Vì sao cần: tài khoản admin hệ thống ĐẦU TIÊN không thể tạo từ trong giao
 * diện (chưa có ai để cấp quyền). Trước đây phải vào Supabase chạy SQL tay.
 * Có biến này thì chỉ cần khai báo email trên Render rồi đăng ký bình thường.
 *
 * Quyền hiệu lực = cờ trong CSDL HOẶC email nằm trong danh sách này.
 * Nhờ vế thứ hai, gỡ email khỏi biến môi trường là quyền mất theo ngay ở lần
 * gọi tiếp theo, kể cả khi cờ trong CSDL bị set nhầm.
 */

function parse() {
  return String(process.env.SYSTEM_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function systemAdminEmails() {
  return parse();
}

export function isSystemAdminEmail(email) {
  if (!email) return false;
  return parse().includes(String(email).trim().toLowerCase());
}

/** Có khai báo admin hệ thống nào qua biến môi trường không. */
export function hasBootstrapAdmins() {
  return parse().length > 0;
}
