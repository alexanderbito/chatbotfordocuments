import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import 'dotenv/config';

// R2 tương thích API S3, chỉ cần đổi endpoint
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

/** Upload buffer file lên R2, trả về storage_key + url. */
export async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  const publicUrl = `${process.env.R2_PUBLIC_URL || ''}/${key}`;
  return { storage_key: key, storage_url: publicUrl };
}

/** Tải file về dạng buffer để xử lý (trích xuất text). */
export async function downloadFromR2(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Xoá file khỏi R2 khi admin xoá tài liệu. */
export async function deleteFromR2(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Tạo link tải có chữ ký, hết hạn sau expiresIn giây.
 * Nhờ vậy bucket có thể để riêng tư, chỉ admin tổ chức mới xem được tài liệu.
 */
export async function getDownloadUrl(key, filename, expiresIn = 300) {
  // RFC 5987: filename* giữ được tiếng Việt có dấu, filename= là bản dự phòng ASCII
  let disposition;
  if (filename) {
    const ascii = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: disposition,
  });
  return getSignedUrl(s3, cmd, { expiresIn });
}
