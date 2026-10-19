import {
  S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { open } from 'fs/promises';
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

/**
 * Upload a file from disk in 64MB parts, so a large file (the nightly Traccar
 * dump, ~1GB) never sits in memory whole — uploadToR2 takes a Buffer, which on
 * this 4GB, no-swap server is not an option at that size. A failed upload is
 * aborted so R2 doesn't keep the orphaned parts.
 */
export async function uploadFileToR2(key: string, filePath: string, contentType: string): Promise<number> {
  const PART = 64 * 1024 * 1024;
  const file = await open(filePath, 'r');
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
    Bucket: R2_BUCKET_NAME, Key: key, ContentType: contentType,
  }));
  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    const buf = Buffer.alloc(PART);
    let total = 0;
    for (let n = 1; ; n++) {
      // Fill the whole part: a short read is only allowed for the last one.
      let filled = 0;
      while (filled < PART) {
        const { bytesRead } = await file.read(buf, filled, PART - filled, total + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0 && n > 1) break;
      const res = await s3.send(new UploadPartCommand({
        Bucket: R2_BUCKET_NAME, Key: key, UploadId, PartNumber: n, Body: buf.subarray(0, filled),
      }));
      parts.push({ ETag: res.ETag as string, PartNumber: n });
      total += filled;
      if (filled < PART) break;
    }
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET_NAME, Key: key, UploadId, MultipartUpload: { Parts: parts },
    }));
    return total;
  } catch (err) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET_NAME, Key: key, UploadId })).catch(() => {});
    throw err;
  } finally {
    await file.close();
  }
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
