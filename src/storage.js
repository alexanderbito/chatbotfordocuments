import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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

/**
 * Upload buffer file lên R2, trả về storage_key + url public.
 */
export async function uploadToR2(key, buffer, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
  return { storage_key: key, storage_url: publicUrl };
}

/**
 * Tải file về dạng buffer để xử lý (trích xuất text).
 */
export async function downloadFromR2(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
