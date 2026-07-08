import { MessageSquare } from 'lucide-react';

export interface SlotCommentLineProps {
  comment: string | null;
}

// The free-text note on a slot, rendered under its dishes. Plain text only
// (DEC-49) — React escaping is the XSS mitigation. Returns null when there's no
// comment so callers don't need to guard. Shared by the planner card and the
// home page meal list.
export function SlotCommentLine({
  comment,
}: SlotCommentLineProps): React.ReactElement | null {
  if (comment === null || comment === '') return null;
  return (
    <span
      data-testid="slot-comment"
      className="flex items-start gap-1 text-xs text-muted-foreground italic"
    >
      <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words whitespace-pre-wrap">{comment}</span>
    </span>
  );
}
