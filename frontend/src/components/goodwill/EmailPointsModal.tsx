import { useState } from 'react';
import ModalShell from '../ModalShell';
import { type GoodwillCredit, emailPoints, copyText } from '../../lib/goodwillCopy';

/**
 * "Email points" for a goodwill credit or voucher — shown in full first, then copied
 * (jon, 17 Nov 2026: see it before copying it). Staff paste them into their own email;
 * OP sends nothing (GOODWILL-CREDIT-SPEC §5).
 */
export default function EmailPointsModal({ credit, onClose }: { credit: GoodwillCredit; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = emailPoints(credit);
  return (
    <ModalShell title="Email points" subtitle={`${credit.voucher_code ? `Voucher ${credit.voucher_code}` : credit.ref} · for ${credit.owner_name}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-3 text-sm">
        <pre className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-3 font-sans text-gray-800">{text}</pre>
        <p className="text-xs text-gray-500">Paste these into your own email to them.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">Close</button>
          <button type="button" onClick={async () => { if (await copyText(text)) setCopied(true); }}
            className="px-3 py-1.5 rounded-lg bg-ooosh-600 text-white hover:bg-ooosh-700">{copied ? '✓ Copied' : 'Copy'}</button>
        </div>
      </div>
    </ModalShell>
  );
}
