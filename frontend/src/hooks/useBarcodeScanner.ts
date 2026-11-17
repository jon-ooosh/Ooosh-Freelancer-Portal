import { useEffect, useRef, type RefObject } from 'react';

/**
 * Catches a hand-held barcode scanner wherever the cursor is (the shop till).
 *
 * A USB or Bluetooth scanner is a keyboard: it types the code and presses Enter.
 * Typed into the search box that is exactly right, and the box's own Enter
 * handler looks it up. Typed anywhere else it is wrong: into a quantity box it
 * sold 749,699,128,328 strings (jon, Nov 2026), and its Enter "presses" whatever
 * button still has focus — possibly the one that takes the payment.
 *
 * So, listening before anything else on the page: a burst of letters/digits
 * arriving faster than anyone types (each within GAP_MS of the last), at least
 * MIN_LENGTH long and finished by Enter, is a scan. The Enter is swallowed, the
 * box it landed in is put back exactly as it was, and `onScan(code)` is called.
 * Normal typing — slower, or with spaces and punctuation — is never touched.
 *
 * `searchInput` is skipped: a scan there is already handled by that box.
 */
const GAP_MS = 60;
const MIN_LENGTH = 6;
const CODE_RE = /^[0-9A-Za-z]+$/;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isField(el: EventTarget | null): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * Put a React-controlled field back to `value`. Setting `.value` directly is
 * invisible to React, so go through the native setter and fire the event React
 * listens for — the component's own onChange then sets its state back too.
 */
function restoreField(el: Field, value: string) {
  if (el.value === value) return;
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

export function useBarcodeScanner(
  onScan: (code: string) => void,
  searchInput: RefObject<HTMLInputElement | null>,
) {
  // The page re-renders constantly; the listener always calls the newest handler.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let chars = '';
    let last = 0;
    let field: Field | null = null;
    let fieldBefore = '';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target === searchInput.current) { chars = ''; return; }
      const now = e.timeStamp;

      if (e.key.length === 1) {
        if (now - last > GAP_MS) {
          // A new burst. Remember the box it starts in, before this key lands.
          chars = '';
          field = isField(e.target) ? e.target : null;
          fieldBefore = field ? field.value : '';
        }
        chars += e.key;
        last = now;
        return;
      }

      if (e.key === 'Enter') {
        const code = chars;
        const fast = now - last <= GAP_MS;
        chars = '';
        if (!fast || code.length < MIN_LENGTH || !CODE_RE.test(code)) return;
        e.preventDefault();
        e.stopPropagation();
        if (field) restoreField(field, fieldBefore);
        field = null;
        onScanRef.current(code);
      }
    };

    // Capture phase, so this runs before the focused element's own handlers.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [searchInput]);
}
