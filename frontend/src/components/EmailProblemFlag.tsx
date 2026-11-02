import type { EmailProblem } from '../hooks/useEmailProblems';

/**
 * A small red flag beside an email address that is NOT receiving our email
 * (see hooks/useEmailProblems.ts). Hover for what happened; click to read what
 * to do and, once sorted, "Mark as fixed". Renders nothing when there is no
 * open problem.
 */
const LABEL: Record<EmailProblem['problem'], string> = {
  bounced: 'Email bouncing',
  suppressed: 'Email blocked',
  complained: 'Reported as spam',
};

const WHAT: Record<EmailProblem['problem'], string> = {
  bounced: 'Emails to this address are bouncing (the mail server refuses them — usually a mistyped or closed address).',
  suppressed: 'Resend is blocking emails to this address, because earlier ones bounced or were reported as spam.',
  complained: 'They reported one of our emails as spam, so Resend will not send to them again.',
};

const TODO: Record<EmailProblem['problem'], string> = {
  bounced: 'Check the address with them. If it is wrong, correct it and re-send. If it is right, remove it from Resend\'s suppression list (Resend › Emails › Suppressions) first, then re-send.',
  suppressed: 'Check the address with them. If it is wrong, correct it and re-send. If it is right, remove it from Resend\'s suppression list (Resend › Emails › Suppressions) first, then re-send.',
  complained: 'Speak to them. Only if they do want our emails: remove the address from Resend\'s suppression list (Resend › Emails › Suppressions) and re-send.',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function EmailProblemFlag({
  problem,
  onMarkFixed,
  compact = false,
}: {
  problem: EmailProblem | null;
  onMarkFixed: (email: string) => Promise<void>;
  /** Smaller text, for inside a chip. */
  compact?: boolean;
}) {
  if (!problem) return null;

  const since = fmtDate(problem.first_seen_at);
  const count = problem.failed_count === 1 ? '1 email' : `${problem.failed_count} emails`;
  const summary = `${WHAT[problem.problem]}\n${count} not delivered${since ? ` since ${since}` : ''}.`
    + `${problem.detail ? `\nResend says: ${problem.detail}` : ''}`;

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = window.confirm(
      `${problem.email}\n\n${summary}\n\nWhat to do: ${TODO[problem.problem]}\n\n`
      + 'This clears by itself when an email to this address is delivered.\n'
      + 'Mark it as fixed now?',
    );
    if (!ok) return;
    try {
      await onMarkFixed(problem.email);
    } catch {
      window.alert('Could not mark it as fixed — please try again.');
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`${summary}\n\nClick for what to do, or to mark it as fixed.`}
      className={`inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-medium leading-none ${
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'
      }`}
    >
      ⚠ {LABEL[problem.problem]}
    </button>
  );
}
