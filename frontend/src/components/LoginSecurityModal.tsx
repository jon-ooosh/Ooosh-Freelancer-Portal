/**
 * The banner's modal — "Set up now" opens the setup flow right here rather than
 * sending people to the bottom of their profile (jon, Oct 2026). Also the admin
 * mandate: an admin without a passkey sees it on every page and cannot close it
 * until they have one (STAFF-LOGIN-SECURITY-SPEC §1.2).
 */
import LoginSecuritySetup from './LoginSecuritySetup';

interface Props {
  /** True for the admin mandate: no close button, no click-away. */
  required: boolean;
  enforcedFrom?: string | null;
  onClose: () => void;
}

export default function LoginSecurityModal({ required, enforcedFrom, onClose }: Props) {
  const deadline = enforcedFrom
    ? new Date(enforcedFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={() => { if (!required) onClose(); }}>
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {required ? 'Add a passkey to your admin login' : 'Set up your login security'}
            </h2>
            <p className="mt-0.5 text-[13px] text-gray-500">
              {required
                ? 'Admin logins use a passkey. It takes a few seconds and this box will not go away until it is done.'
                : deadline ? `Needed from ${deadline}. Two minutes, once.` : 'Two minutes, once.'}
            </p>
          </div>
          {!required && (
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        <div className="mt-4">
          <LoginSecuritySetup onDone={onClose} />
        </div>
        {!required && (
          <p className="mt-4 text-xs text-gray-500">
            You can also do this later from My profile › Login security.
          </p>
        )}
      </div>
    </div>
  );
}
