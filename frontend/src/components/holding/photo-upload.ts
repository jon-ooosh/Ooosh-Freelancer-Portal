/**
 * Shared photo upload for held-item capture surfaces (Quick Log, desktop
 * CreateModal, staff receipt page). Compresses each image (so emailed photos
 * stay small) then uploads to R2 as an attachment. Returns the FileAttachment
 * shape the forms store. Throws on failure so callers can surface it.
 */
import { useAuthStore } from '../../hooks/useAuthStore';
import { compressImage } from './compress';

export interface UploadedPhoto { name: string; url: string; type: string }

export async function uploadHeldItemPhotos(files: FileList | File[]): Promise<UploadedPhoto[]> {
  const out: UploadedPhoto[] = [];
  for (const original of Array.from(files)) {
    const file = await compressImage(original);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('attachment_only', 'true');
    const token = useAuthStore.getState().accessToken;
    const res = await fetch('/api/files/upload', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
    if (!res.ok) throw new Error('Upload failed');
    const j = await res.json();
    out.push({ name: j.filename || file.name, url: j.r2_key, type: 'image' });
  }
  return out;
}
