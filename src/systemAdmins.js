import 'dotenv/config';

/**
 * Danh sách email luôn có quyền admin hệ thống, khai báo qua biến môi trường.
 *
 * Vì sao cần: tài khoản admin hệ thống ĐẦU TIÊN không thể tạo từ trong giao
 * diện (chưa có ai để cấp quyền). Trước đây phải vào Supabase chạy SQL tay.
 * Có biến này thì chỉ cần khai báo email trên Render rồi đăng ký bình thường.
 *
 * Quyền hiệu lực = cờ trong CSDL HOẶC email nằm trong danh sách này. Vế thứ
 * hai là đường khôi phục: kể cả khi cờ trong CSDL bị xoá nhầm, chỉ cần email
 * còn trong biến môi trường là vẫn vào được.
 *
 * LƯU Ý: lần đầu đăng nhập, cờ trong CSDL được bật để đồng bộ. Vì vậy GỠ EMAIL
 * KHỎI BIẾN MÔI TRƯỜNG KHÔNG THU HỒI QUYỀN — phải thu hồi hẳn bằng
 * `npm run make-admin -- email@congty.vn --revoke` hoặc trong trang Người dùng
 * của quản trị hệ thống (và phải gỡ khỏi biến môi trường trước, nếu không thao
 * tác thu hồi sẽ bị chặn).
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
