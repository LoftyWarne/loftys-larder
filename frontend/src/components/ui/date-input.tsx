import * as React from 'react';

import { Input, type InputProps } from '@/components/ui/input.tsx';
import { cn } from '@/lib/utils.ts';

// Native date inputs only open the picker when the tiny calendar icon is
// clicked. Calling showPicker() on a click anywhere in the field makes the
// whole control the target. Guarded because showPicker is unsupported on
// older browsers, where the icon still works as a fallback.
export const DateInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, onClick, ...props }, ref) => {
    return (
      <Input
        ref={ref}
        type="date"
        className={cn('cursor-pointer', className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !props.disabled) {
            const input = event.currentTarget;
            if (typeof input.showPicker === 'function') {
              try {
                input.showPicker();
              } catch {
                // showPicker throws if not user-activated; the click already
                // is, so this only guards exotic cases. Icon remains usable.
              }
            }
          }
        }}
        {...props}
      />
    );
  },
);
DateInput.displayName = 'DateInput';
