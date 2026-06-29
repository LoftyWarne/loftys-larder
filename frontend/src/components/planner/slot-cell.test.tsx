import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SlotCell } from './slot-cell.tsx';

const BASE_SLOT: PlanSlot = {
  id: 1,
  planId: 1,
  date: '2026-06-15',
  occasionId: 1,
  occasionName: 'Dinner',
  slotType: 'empty',
  chefUserId: null,
  comment: null,
  items: [],
};

function eatItem(overrides: Partial<PlanSlotItem> = {}): PlanSlotItem {
  return {
    id: 1,
    recipeId: 10,
    recipeName: 'Tomato pasta',
    recipeImageUrl: null,
    isBase: false,
    baseRecipeId: null,
    isDeleted: false,
    servings: 2,
    kind: 'eat',
    sortOrder: 0,
    ...overrides,
  };
}

function cookItem(overrides: Partial<PlanSlotItem> = {}): PlanSlotItem {
  return {
    id: 2,
    recipeId: 22,
    recipeName: 'Curry Base',
    recipeImageUrl: null,
    isBase: true,
    baseRecipeId: null,
    isDeleted: false,
    servings: 8,
    kind: 'cook_ahead',
    sortOrder: 1,
    ...overrides,
  };
}

const RECIPE_SLOT: PlanSlot = {
  ...BASE_SLOT,
  slotType: 'recipe',
  items: [eatItem()],
};

describe('SlotCell', () => {
  it('renders each eaten dish with its servings', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'recipe',
          items: [
            eatItem({ id: 1, recipeName: 'Tomato pasta', servings: 2 }),
            eatItem({ id: 2, recipeId: 11, recipeName: 'Salad', servings: 4 }),
          ],
        }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Tomato pasta')).toBeInTheDocument();
    expect(screen.getByText('Salad')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByText('×4')).toBeInTheDocument();
  });

  it('renders a "(deleted)" hint when a dish recipe was soft-deleted', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'recipe',
          items: [eatItem({ recipeName: 'Old recipe', isDeleted: true })],
        }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText(/deleted/)).toBeInTheDocument();
  });

  it('renders the slot-type label for non-recipe states', () => {
    render(
      <SlotCell
        slot={{ ...BASE_SLOT, slotType: 'eat_out' }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Eat out')).toBeInTheDocument();
  });

  it('fires onClick when activated', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<SlotCell slot={BASE_SLOT} onClick={onClick} />);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a clear affordance for non-empty slots and fires onClear', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onClear = vi.fn();
    render(
      <SlotCell
        slot={{ ...BASE_SLOT, slotType: 'eat_out' }}
        onClick={onClick}
        onClear={onClear}
      />,
    );
    await user.click(screen.getByRole('button', { name: /^clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('omits the clear affordance for empty slots', () => {
    render(
      <SlotCell slot={BASE_SLOT} onClick={() => undefined} onClear={vi.fn()} />,
    );
    expect(
      screen.queryByRole('button', { name: /^clear/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the base affordance and fires onBaseClick (not onClick)', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onBaseClick = vi.fn();
    render(
      <SlotCell
        slot={RECIPE_SLOT}
        onClick={onClick}
        onBaseClick={onBaseClick}
      />,
    );
    await user.click(screen.getByTestId('slot-base-affordance'));
    expect(onBaseClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows "+ base" when nothing is cooked yet', () => {
    render(
      <SlotCell
        slot={RECIPE_SLOT}
        onClick={() => undefined}
        onBaseClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('slot-base-affordance')).toHaveTextContent(
      '+ base',
    );
  });

  it('shows the cooked base name and a shortfall indicator', () => {
    render(
      <SlotCell
        slot={{ ...RECIPE_SLOT, items: [eatItem(), cookItem()] }}
        onClick={() => undefined}
        onBaseClick={vi.fn()}
        shortBy={2}
      />,
    );
    const affordance = screen.getByTestId('slot-base-affordance');
    expect(affordance).toHaveTextContent('Curry Base');
    expect(affordance).toHaveTextContent('short 2');
  });

  it('shows the base affordance on an empty slot (prep-a-base day)', () => {
    render(
      <SlotCell
        slot={BASE_SLOT}
        onClick={() => undefined}
        onBaseClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('slot-base-affordance')).toHaveTextContent(
      '+ base',
    );
  });
});
