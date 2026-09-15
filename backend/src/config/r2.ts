import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'ooosh-operations';

// Second bucket, public-read. Used for vehicle book-out / check-in condition
// photos which are embedded in client-facing PDFs as clickable "View full
// size" hyperlinks. Signatures + event JSON + everything else stays in the
// private bucket above.
const R2_PUBLIC_BUCKET_NAME = process.env.R2_PUBLIC_BUCKET_NAME || 'ooosh-vehicle-photos';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  // Return the key — the frontend constructs the full URL via the download route
  return key;
}

export async function deleteFromR2(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

export async function getFromR2(key: string) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
  return response;
}

/**
 * Generate a time-limited presigned GET URL for an R2 object.
 * Used to hand off file downloads directly to the browser without
 * proxying through authenticated endpoints — short expiry keeps the
 * share radius small.
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

export async function listR2Objects(prefix: string) {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: R2_BUCKET_NAME,
    Prefix: prefix,
  }));
  return response.Contents || [];
}

// ─── Public bucket helpers ────────────────────────────────────────────────
// Same S3 client, same credentials — just a different bucket. The public
// bucket is configured on Cloudflare with Public Access enabled, so objects
// are readable via `${R2_PUBLIC_URL}/${key}` (e.g. `https://pub-<hash>.r2.dev/events/...`).

export async function uploadToPublicR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: R2_PUBLIC_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

export async function getFromPublicR2(key: string) {
  return s3.send(new GetObjectCommand({
    Bucket: R2_PUBLIC_BUCKET_NAME,
    Key: key,
  }));
}

export async function deleteFromPublicR2(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: R2_PUBLIC_BUCKET_NAME,
    Key: key,
  }));
}

export async function listPublicR2Objects(prefix: string) {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: R2_PUBLIC_BUCKET_NAME,
    Prefix: prefix,
  }));
  return response.Contents || [];
}

export { R2_BUCKET_NAME, R2_PUBLIC_BUCKET_NAME };
