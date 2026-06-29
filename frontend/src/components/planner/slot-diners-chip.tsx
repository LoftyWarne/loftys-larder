import { Users } from 'lucide-react';

export interface SlotDinersChipProps {
  // Names of the household members eating this slot, already resolved from ids.
  dinerNames: readonly string[];
  // Diners with no account (kids, guests).
  guestCount: number;
}

// Renders "who's eating" on a slot card: the named members, a "+N" for
// accountless guests, and the total headcount in parentheses. Plain text only
// (DEC-49). Returns null when nobody is recorded so empty slots stay clean.
export function SlotDinersChip({
  dinerNames,
  guestCount,
}: SlotDinersChipProps): React.ReactElement | null {
  const total = dinerNames.length + guestCount;
  if (total === 0) return null;

  const namePart = dinerNames.join(', ');
  const label =
    namePart === ''
      ? `${String(guestCount)} guest${guestCount === 1 ? '' : 's'}`
      : guestCount > 0
        ? `${namePart} +${String(guestCount)}`
        : namePart;

  return (
    <span
      data-testid="slot-diners"
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0">({String(total)})</span>
    </span>
  );
}
