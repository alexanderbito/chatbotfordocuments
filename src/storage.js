import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import 'dotenv/config';

// R2 speaks the S3 API; only the endpoint differs
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

/** Upload a file buffer to R2 and return its storage_key and url. */
export async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  const publicUrl = `${process.env.R2_PUBLIC_URL || ''}/${key}`;
  return { storage_key: key, storage_url: publicUrl };
}

/** Download a file as a buffer so its text can be extracted. */
export async function downloadFromR2(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Remove a file from R2 when an admin deletes the document. */
export async function deleteFromR2(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Build a signed download link that expires after expiresIn seconds, which
 * lets the bucket stay private while organization admins can still read files.
 */
export async function getDownloadUrl(key, filename, expiresIn = 300) {
  // RFC 5987: filename* preserves non-ASCII names, filename= is the fallback
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
