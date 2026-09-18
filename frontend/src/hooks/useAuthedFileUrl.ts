/**
 * THE way to show a private-bucket R2 file in the DOM.
 *
 * Files in the private bucket can't be handed to `<img src>` directly — the
 * browser doesn't attach the JWT to a direct navigation — so every thumbnail
 * in the app fetches the bytes through api.blob and renders an object URL.
 * Done the obvious way (eagerly, on mount, once per row) that pattern cost us
 * a 25-second Costs page: ~90 requests and ~100MB of full-size originals to
 * draw a column of 32px icons.
 *
 * So this hook is that pattern done once, with the three things the hand-rolled
 * copies kept missing:
 *   - the fetch waits until the element is actually near the viewport;
 *   - it aborts if the caller loses interest, instead of letting 3MB land for
 *     a row that has scrolled away (backed by the `close` handler on
 *     GET /api/files/download, which tears the R2 body down to match);
 *   - the object URL is revoked on the way out.
 *
 * Attach the returned `ref` to whatever element stands in for the file — and
 * critically, to the PLACEHOLDER too, not just the loaded `<img>`. The ref is
 * how the hook learns the thumbnail is on screen; put it only on the success
 * branch and nothing ever loads.
 *
 * Pass `enabled: false` when the caller already knows no image is coming (a
 * PDF that will render as an icon) and no request is made at all.
 *
 * None of this is a substitute for real server-side thumbnails — see the
 * `thumbnail_key` stub in backend/src/routes/files.ts. It just stops us
 * shipping the full original to draw a small square.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

export interface AuthedFileUrl {
  /** Callback ref — attach to the thumbnail element AND its placeholder. */
  ref: (el: HTMLElement | null) => void;
  /** Object URL for the fetched bytes, or null until it arrives. */
  url: string | null;
  /** Content-Type as served. The bytes are authoritative, not the filename. */
  contentType: string;
  /** True once the fetch has failed (not set for an abort). */
  failed: boolean;
}

export function useAuthedFileUrl(
  key: string | null | undefined,
  { enabled = true, rootMargin = '200px' }: { enabled?: boolean; rootMargin?: string } = {},
): AuthedFileUrl {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState('');
  const [failed, setFailed] = useState(false);

  const active = !!key && enabled;

  // Node is held in state rather than a ref so that attaching it re-runs the
  // observer effect below. useState's setter is identity-stable, so React
  // won't thrash the callback ref.
  const ref = useCallback((el: HTMLElement | null) => setNode(el), []);

  useEffect(() => {
    // Once we've decided to load there is nothing left to watch for. Worth the
    // early return: callers swap the ref between a placeholder and the loaded
    // element, so `node` changes at least once after `visible` is already true.
    if (!active || !node || visible) return;
    // jsdom and older Safari have no IntersectionObserver: fetch immediately
    // rather than render a placeholder that never resolves.
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); obs.disconnect(); }
    }, { rootMargin });
    obs.observe(node);
    return () => obs.disconnect();
  }, [active, node, visible, rootMargin]);

  useEffect(() => {
    if (!active || !visible) return;
    // Point at a different file and the old object URL is about to be revoked
    // by this effect's cleanup — drop it now so nothing renders a dead URL.
    setUrl(null);
    setFailed(false);

    let objUrl = '';
    let cancelled = false;
    const ac = new AbortController();

    api.blob(`/files/download?key=${encodeURIComponent(key!)}`, ac.signal)
      .then(({ blob, contentType: type }) => {
        if (cancelled) return;
        // Re-wrap only when the blob didn't pick the type up from the response:
        // <embed> needs an accurate type to pick a viewer, and re-wrapping
        // unconditionally would copy several MB for nothing.
        objUrl = URL.createObjectURL(
          type && blob.type !== type ? new Blob([blob], { type }) : blob,
        );
        setContentType(type);
        setUrl(objUrl);
      })
      // An abort lands here too, but `cancelled` is already set by then, so a
      // thumbnail scrolled out of view never reports itself as broken.
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => { cancelled = true; ac.abort(); if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [active, visible, key]);

  return { ref, url, contentType, failed };
}
