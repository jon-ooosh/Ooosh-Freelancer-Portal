/**
 * "Option 2 of 3" — the tag after a grouped job's name on global search and
 * Hire History (docs/QUOTE-VERSIONS-SPEC.md §6.5). Renders nothing for a job in
 * no options group. Pair it with `stripOptionSuffix()` on the name so the
 * option number isn't shown twice.
 */
import { OPTION_COPY } from '../lib/optionCopy';

export default function OptionTag({ optionNo, optionCount }: { optionNo?: number | null; optionCount?: number | null }) {
  if (!optionNo || !optionCount) return null;
  return (
    <span
      className="inline-flex items-center align-middle px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-ooosh-100 text-ooosh-700 whitespace-nowrap"
      title={OPTION_COPY.tagTitle(optionNo, optionCount)}
    >
      {OPTION_COPY.tag(optionNo, optionCount)}
    </span>
  );
}
