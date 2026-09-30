import type { RecipeTag } from '@loftys-larder/shared';

import { cn } from '@/lib/utils.ts';

export interface RecipeTagListProps {
  tags: readonly RecipeTag[];
  className?: string;
}

export function RecipeTagList({
  tags,
  className,
}: RecipeTagListProps): React.ReactElement | null {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className={cn('flex flex-wrap gap-1', className)}>
      {tags.map((tag) => (
        <li
          key={tag.id}
          className="rounded-full border border-input px-2 py-0.5 text-xs text-muted-foreground"
        >
          {tag.name}
        </li>
      ))}
    </ul>
  );
}
