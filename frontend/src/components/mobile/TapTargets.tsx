import { ReactNode } from 'react';

/**
 * Tap-to-call link. On mobile devices the `tel:` href triggers the dialer.
 * Desktop browsers may prompt to choose a calling app or do nothing — that's
 * fine, the visible content is still readable.
 */
export function TelLink({
  phone,
  children,
  className = '',
  showIcon = true,
}: {
  phone: string;
  children?: ReactNode;
  className?: string;
  showIcon?: boolean;
}) {
  const href = `tel:${phone.replace(/[^\d+]/g, '')}`;
  return (
    <a
      href={href}
      className={`text-ooosh-600 hover:underline inline-flex items-center gap-1 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {showIcon && (
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
      )}
      {children || phone}
    </a>
  );
}

/**
 * Tap-to-map link. Uses Google Maps' universal search URL — handled
 * natively by Maps on iOS / Android and renders in the browser otherwise.
 */
export function MapLink({
  address,
  children,
  className = '',
  showIcon = true,
}: {
  address: string;
  children?: ReactNode;
  className?: string;
  showIcon?: boolean;
}) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-ooosh-600 hover:underline inline-flex items-center gap-1 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {showIcon && (
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
        </svg>
      )}
      {children || address}
    </a>
  );
}
