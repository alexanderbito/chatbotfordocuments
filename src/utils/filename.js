/**
 * Chuẩn hoá tên file nhận từ multipart upload.
 *
 * Vì sao cần: multer 1.x (busboy) đọc tên file trong header multipart theo latin-1,
 * nên tên tiếng Việt UTF-8 bị biến thành mojibake ("Quy định" -> "Quy Ä‘á»‹nh").
 * Ngoài ra macOS lưu tên file ở dạng NFD (ký tự + dấu rời), cần đưa về NFC
 * để hiển thị và tìm kiếm nhất quán với dữ liệu nhập từ Windows/Linux.
 */
export function decodeFilename(name) {
  if (!name) return name;

  // Có ký tự ngoài dải latin-1 => chuỗi đã là UTF-8 đúng, chỉ cần chuẩn hoá NFC.
  if (/[^\x00-\xFF]/.test(name)) return name.normalize('NFC');

  // Thử diễn giải lại theo latin-1 -> UTF-8.
  const decoded = Buffer.from(name, 'latin1').toString('utf8');

  // Nếu ra ký tự thay thế (U+FFFD) nghĩa là chuỗi gốc vốn đã đúng, giữ nguyên.
  if (decoded.includes('�')) return name.normalize('NFC');

  return decoded.normalize('NFC');
}

/**
 * Tạo key an toàn để lưu trên R2/S3: bỏ dấu tiếng Việt, chỉ giữ [a-zA-Z0-9._-].
 * Tên hiển thị cho người dùng vẫn là tên gốc có dấu, lưu ở cột filename.
 */
export function toStorageSafeName(name, fallback = 'tai-lieu') {
  const base = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // bỏ dấu thanh và dấu phụ
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (base || fallback).slice(0, 120);
}
