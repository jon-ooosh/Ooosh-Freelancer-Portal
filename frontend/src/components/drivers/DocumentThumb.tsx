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
  // Decided from the fetched blob's real MIME type, not the filename.
  //
  // Guessing by extension gets DVLA checks wrong: they come through as PDFs (and
  // sometimes with no extension at all), so an extension test either renders a
  // broken <img> or mislabels a real image. The bytes are authoritative and we
  // are fetching them anyway.
  const [isImage, setIsImage] = useState<boolean | null>(null);
  const [isPdf, setIsPdf] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    api.blob(`/files/download?key=${encodeURIComponent(fileKey)}`)
      .then(({ blob, contentType }) => {
        if (cancelled) return;
        const type = contentType || blob.type || '';
        // The object URL is created for PDFs too — the browser's own viewer
        // renders page 1 as the thumbnail, so a DVLA summary previews like
        // everything else instead of showing a generic file icon.
        objectUrl = URL.createObjectURL(
          type ? new Blob([blob], { type }) : blob,
        );
        setSrc(objectUrl);
        setIsImage(type.startsWith('image/'));
        setIsPdf(type.includes('pdf'));
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileKey]);

  if (isImage === null && !failed) {
    return <div className="w-20 h-20 rounded-lg border border-gray-200 bg-gray-100 animate-pulse" />;
  }

  // PDFs: render page 1 through the browser's built-in viewer, scaled into the
  // thumbnail box. No pdf.js dependency — <embed> already knows how. Chrome
  // needs a real page-sized element to lay out, hence the fixed size plus a
  // transform rather than simply sizing it at 80px. The generic icon sits
  // underneath, so a browser that renders nothing still shows something.
  if (!isImage && isPdf && src) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={filename || 'Open document'}
        className="relative w-20 h-20 rounded-lg border border-gray-200 bg-white overflow-hidden hover:border-ooosh-400 focus:outline-none focus:ring-2 focus:ring-ooosh-500"
      >
        <span className="absolute inset-0 flex items-center justify-center text-xl text-gray-300">📄</span>
        <embed
          src={`${src}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
          type="application/pdf"
          // 240x310 is roughly A4's ratio; scaled to a third it fills the box.
          className="absolute top-0 left-0 pointer-events-none"
          style={{ width: 240, height: 310, transform: 'scale(0.334)', transformOrigin: 'top left' }}
        />
        <span className="absolute bottom-0 inset-x-0 bg-white/85 text-[9px] uppercase tracking-wide text-gray-500 leading-4">
          PDF
        </span>
      </button>
    );
  }

  if (!isImage) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={filename || 'Open document'}
        className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-lg border border-gray-200 bg-gray-50 text-gray-500 hover:border-ooosh-400 hover:text-ooosh-600"
      >
        <span className="text-xl leading-none">📄</span>
        <span className="text-[10px] uppercase tracking-wide">File</span>
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
      <img
        src={src}
        alt={filename || 'Document'}
        onError={() => setFailed(true)}
        className="w-full h-full object-cover"
      />
    </button>
  );
}
