import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button.tsx';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover.tsx';
import { cn } from '@/lib/utils.ts';

// The one shape every recipes-page filter takes (DEC-100): a button naming
// the filter, and what it's set to once set, opening a panel of choices.
export interface FilterPopoverProps {
  label: string;
  summary: string | null;
  onClear: () => void;
  children: ReactNode;
}

export function FilterPopover({
  label,
  summary,
  onClear,
  children,
}: FilterPopoverProps): React.ReactElement {
  const isSet = summary !== null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            'max-w-full rounded-full',
            isSet &&
              'border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
          )}
        >
          <span className="truncate">
            {isSet ? `${label}: ${summary}` : label}
          </span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="flex w-64 flex-col gap-3 p-3"
      >
        {children}
        {isSet && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-end"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
