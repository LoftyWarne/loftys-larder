import type { ShoppingListLine } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ListLine } from './list-line.tsx';

function makeLine(overrides: Partial<ShoppingListLine> = {}): ShoppingListLine {
  return {
    ingredient: { id: 100, name: 'Tomato' },
    unit: { id: 1, name: 'g' },
    totalQuantity: '500.000',
    contributingSlots: [
      {
        slotId: 1,
        recipeId: 10,
        recipeName: 'Tomato pasta',
        date: '2026-06-15',
        scaledQuantity: '300.000',
      },
      {
        slotId: 2,
        recipeId: 11,
        recipeName: 'Bruschetta',
        date: '2026-06-17',
        scaledQuantity: '200.000',
      },
    ],
    isChecked: false,
    ...overrides,
  };
}

describe('ListLine', () => {
  it('renders the ingredient name and the formatted total quantity', () => {
    render(<ListLine line={makeLine()} onToggle={() => undefined} />);

    expect(screen.getByText('Tomato')).toBeInTheDocument();
    // g unit -> formatQuantity strips the trailing zeros after one decimal.
    expect(screen.getByText('500 g')).toBeInTheDocument();
  });

  it('toggles via the checkbox and passes the next state to the callback', async () => {
    const onToggle = vi.fn<(line: ShoppingListLine, next: boolean) => void>();
    render(<ListLine line={makeLine()} onToggle={onToggle} />);

    const checkbox = screen.getByRole('checkbox', {
      name: /mark Tomato as bought/i,
    });
    await userEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledTimes(1);
    const [line, next] = onToggle.mock.calls[0] ?? [];
    expect(line?.ingredient.id).toBe(100);
    expect(next).toBe(true);
  });

  it('renders checked lines with strikethrough styling', () => {
    render(
      <ListLine
        line={makeLine({ isChecked: true })}
        onToggle={() => undefined}
      />,
    );
    const label = screen.getByText('Tomato').closest('label');
    expect(label).not.toBeNull();
    expect(label).toHaveClass('line-through');
  });

  it('renders a shelf-life badge when the warning is present', () => {
    render(
      <ListLine
        line={makeLine({
          shelfLifeWarning: {
            latestNeededDate: '2026-06-19',
            daysOverflow: 1,
          },
        })}
        onToggle={() => undefined}
      />,
    );
    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.getByText(/Needed by/)).toBeInTheDocument();
  });

  it('omits the shelf-life badge when the warning is absent', () => {
    render(<ListLine line={makeLine()} onToggle={() => undefined} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('renders a "Pending sync" indicator when isQueued is true', () => {
    render(<ListLine line={makeLine()} onToggle={() => undefined} isQueued />);
    const indicator = screen.getByRole('status', { name: /pending sync/i });
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute('data-print-hide');
  });

  it('omits the "Pending sync" indicator by default', () => {
    render(<ListLine line={makeLine()} onToggle={() => undefined} />);
    expect(
      screen.queryByRole('status', { name: /pending sync/i }),
    ).not.toBeInTheDocument();
  });

  it('lists contributing recipes inside a collapsed-by-default disclosure', () => {
    const { container } = render(
      <ListLine line={makeLine()} onToggle={() => undefined} />,
    );

    const details = container.querySelector(
      'details[data-shopping-contributors]',
    );
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);

    // Recipes are in the DOM (just collapsed visually); the spec only requires
    // the disclosure default state.
    expect(screen.getByText('Tomato pasta')).toBeInTheDocument();
    expect(screen.getByText('Bruschetta')).toBeInTheDocument();
  });
});
