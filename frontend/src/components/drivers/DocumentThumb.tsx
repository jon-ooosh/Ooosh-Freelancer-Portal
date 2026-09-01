import { useEffect, useState } from 'react';
import { api } from '../../services/api';

/**
 * Thumbnail for a driver document, fetched with the session JWT.
 *
 * Driver documents live in the PRIVATE R2 bucket, so a plain <img src> to
 * /files/download 401s — browsers don't send the Authorization header on a
 * direct navigation. Same reason the messaging attachments render via a blob;
 * this is the driver-document counterpart, with a lightbox because the whole
 * point is comparing a selfie against a licence photo at a readable size.
 */
export function DocumentThumb({ fileKey, filename, onOpen }: {
  fileKey: string;
  filename?: string;
  onOpen?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const isImage = /\.(jpe?g|png|gif|webp|heic)$/i.test(filename || fileKey);

  useEffect(() => {
    if (!isImage) return;
    let objectUrl: string | null = null;
    let cancelled = false;

    api.blob(`/files/download?key=${encodeURIComponent(fileKey)}`)
      .then(({ blob }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileKey, isImage]);

  if (!isImage) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={filename || 'Open document'}
        className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 hover:border-ooosh-400 hover:text-ooosh-600"
      >
        <span className="text-xl leading-none">📄</span>
        <span className="text-[10px] uppercase tracking-wide">PDF</span>
      </button>
    );
  }

  if (failed) {
    return (
      <div className="w-20 h-20 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-[10px] text-gray-400 text-center px-1">
        Couldn&rsquo;t load
      </div>
    );
  }

  if (!src) {
    return <div className="w-20 h-20 rounded-lg border border-gray-200 bg-gray-100 animate-pulse" />;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-20 h-20 rounded-lg border border-gray-200 overflow-hidden hover:border-ooosh-400 focus:outline-none focus:ring-2 focus:ring-ooosh-500"
      title={filename || 'Open full size'}
    >
      <img src={src} alt={filename || 'Document'} className="w-full h-full object-cover" />
    </button>
  );
}
