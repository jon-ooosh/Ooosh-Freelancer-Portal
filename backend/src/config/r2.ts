import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'ooosh-operations';

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

export async function listR2Objects(prefix: string) {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: R2_BUCKET_NAME,
    Prefix: prefix,
  }));
  return response.Contents || [];
}

export { R2_BUCKET_NAME };
