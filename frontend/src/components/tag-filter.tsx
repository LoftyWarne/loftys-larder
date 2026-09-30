import { trpc } from '@/lib/trpc.ts';
import { cn } from '@/lib/utils.ts';

// Toggle row over the household's in-use tags (DEC-97). Selecting several
// narrows to recipes carrying all of them. Renders nothing until at least one
// tag exists, so an untagged library shows no empty control.
export interface TagFilterProps {
  selectedIds: readonly number[];
  onChange: (next: number[]) => void;
  className?: string;
}

export function TagFilter({
  selectedIds,
  onChange,
  className,
}: TagFilterProps): React.ReactElement | null {
  const tagsQuery = trpc.recipes.listTags.useQuery();
  const tags = tagsQuery.data ?? [];
  if (tags.length === 0) return null;

  const selected = new Set(selectedIds);
  return (
    <div
      role="group"
      aria-label="Filter by tag"
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {tags.map((tag) => {
        const pressed = selected.has(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              onChange(
                pressed
                  ? selectedIds.filter((id) => id !== tag.id)
                  : [...selectedIds, tag.id],
              );
            }}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition focus:outline-none focus:ring-2 focus:ring-ring',
              pressed
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input text-muted-foreground hover:border-primary',
            )}
          >
            {pressed && <span aria-hidden="true">✓ </span>}
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}
