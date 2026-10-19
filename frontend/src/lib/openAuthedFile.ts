/**
 * THE way to open a private-bucket R2 file in a new tab.
 *
 * Sibling to `hooks/useAuthedFileUrl.ts` (which is THE way to *show* one in the
 * DOM). Files in the private bucket can't be handed to a plain link — the
 * browser doesn't attach the JWT to a direct navigation — so opening one means
 * fetching the bytes through api.blob and handing the browser an object URL.
 *
 * Done the obvious way, that has a bug staff experience as "the receipt won't
 * open, but only sometimes":
 *
 *     const { blob } = await api.blob(...);        // several MB, maybe seconds
 *     window.open(URL.createObjectURL(blob));      // <- outside the gesture
 *
 * A browser only allows window.open while the click's *transient user
 * activation* is still live — about 5 seconds in Chrome, stricter in Safari.
 * A 3MB invoice on a slow connection (or one queued behind a page's worth of
 * other file traffic) blows that window, the popup blocker eats the tab, and
 * nothing at all happens on screen. It works on a fast connection, which is
 * exactly why it survived this long.
 *
 * So: claim the tab FIRST, synchronously, while the activation is still ours,
 * then point it at the bytes when they land. The three things the hand-rolled
 * copies variously missed:
 *   - the tab is opened inside the gesture, so it is never blocked;
 *   - a blocked or closed tab (the person blocks popups outright) degrades to
 *     a download rather than silently doing nothing;
 *   - the object URL is revoked, so a modal that opens a dozen receipts in a
 *     session doesn't pin a dozen multi-MB blobs in memory until reload.
 *
 * Throws whatever api.blob threw, after tidying the tab away — callers keep
 * their own error message.
 */

import { api } from '../services/api';

/** Long enough for the new tab to have loaded the bytes; short enough to matter. */
const REVOKE_AFTER_MS = 60_000;

export async function openAuthedFile(path: string, filename?: string): Promise<void> {
  // Opened BEFORE the await — this is the whole point of the helper.
  const tab = window.open('', '_blank');
  // about:blank inherits our origin, so this is allowed. Without it the person
  // stares at a blank tab for as long as the download takes.
  try {
    if (tab) tab.document.write('<title>Loading…</title><p style="font:14px system-ui;color:#666">Loading…</p>');
  } catch { /* non-fatal — a blank tab still works */ }

  let url = '';
  try {
    const { blob, contentType } = await api.blob(path);
    // response.blob() normally carries the Content-Type already; re-wrap only
    // if it arrived bare, or the tab gets a download prompt for a plain PDF.
    url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: contentType }));

    if (tab && !tab.closed) {
      tab.location.href = url;
    } else {
      // Popups blocked outright. An anchor with `download` is not a popup, so
      // it survives where window.open doesn't — the file still reaches them.
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  } catch (err) {
    if (url) URL.revokeObjectURL(url);
    try { tab?.close(); } catch { /* already gone */ }
    throw err;
  }
}

/** Convenience for the common case: an R2 key on the shared download route. */
export function openR2Key(key: string, filename?: string): Promise<void> {
  return openAuthedFile(`/files/download?key=${encodeURIComponent(key)}`, filename || key.split('/').pop());
}
