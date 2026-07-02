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
  leftoversSource: null,
  chefUserId: null,
  comment: null,
  items: [],
  dinerUserIds: [],
  guestCount: 0,
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
    prepared: 2,
    eaten: 2,
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
    prepared: 8,
    eaten: 0,
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
            eatItem({
              id: 1,
              recipeName: 'Tomato pasta',
              prepared: 2,
              eaten: 2,
            }),
            eatItem({
              id: 2,
              recipeId: 11,
              recipeName: 'Salad',
              prepared: 4,
              eaten: 4,
            }),
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

  it('no longer renders a separate base affordance', () => {
    render(
      <SlotCell
        slot={{ ...RECIPE_SLOT, items: [eatItem(), cookItem()] }}
        onClick={() => undefined}
      />,
    );
    expect(
      screen.queryByTestId('slot-base-affordance'),
    ).not.toBeInTheDocument();
  });

  it('renders cooked-ahead bases inline with a type badge', () => {
    render(
      <SlotCell
        slot={{ ...RECIPE_SLOT, items: [eatItem(), cookItem()] }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Curry Base')).toBeInTheDocument();
    expect(screen.getByText('prep ×8')).toBeInTheDocument();
    const badges = screen.getAllByTestId('recipe-type-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['Standalone', 'Base']);
  });

  it('shows a shortfall nudge under the dish in question', () => {
    render(
      <SlotCell
        // eatItem() has id 1; attribute the shortfall to it.
        slot={{ ...RECIPE_SLOT, items: [eatItem(), cookItem()] }}
        onClick={() => undefined}
        shortfallByItem={new Map([[1, 2]])}
      />,
    );
    const nudges = screen.getAllByTestId('slot-item-shortfall');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toHaveTextContent(
      'Short 2 servings — not enough cooked yet',
    );
    // The nudge sits in the same dish container as the short dish (id 1).
    expect(nudges[0]?.parentElement).toHaveTextContent('Tomato pasta');
  });

  it('uses the singular "serving" when short by one', () => {
    render(
      <SlotCell
        slot={{ ...RECIPE_SLOT, items: [eatItem(), cookItem()] }}
        onClick={() => undefined}
        shortfallByItem={new Map([[1, 1]])}
      />,
    );
    expect(
      screen.getByText(/Short 1 serving — not enough cooked yet/),
    ).toBeInTheDocument();
  });

  it('names the base when a serving variation runs its base short', () => {
    render(
      <SlotCell
        // A variation of base 22 (baseRecipeId set), short by 2.
        slot={{ ...RECIPE_SLOT, items: [eatItem({ baseRecipeId: 22 })] }}
        onClick={() => undefined}
        shortfallByItem={new Map([[1, 2]])}
      />,
    );
    expect(
      screen.getByText(/Short 2 servings — not enough base cooked yet/),
    ).toBeInTheDocument();
  });

  it('opens the editor when a card with a base is clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <SlotCell
        slot={{ ...RECIPE_SLOT, items: [eatItem(), cookItem()] }}
        onClick={onClick}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Dinner on/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the slot comment when present', () => {
    render(
      <SlotCell
        slot={{ ...RECIPE_SLOT, comment: 'Use the leftover chicken' }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByTestId('slot-comment')).toHaveTextContent(
      'Use the leftover chicken',
    );
  });

  it('omits the comment line when there is no comment', () => {
    render(<SlotCell slot={RECIPE_SLOT} onClick={() => undefined} />);
    expect(screen.queryByTestId('slot-comment')).not.toBeInTheDocument();
  });

  it('renders a prepped base on an otherwise-empty occasion', () => {
    render(
      <SlotCell
        slot={{ ...BASE_SLOT, items: [cookItem()] }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Curry Base')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-type-badge')).toHaveTextContent('Base');
  });

  it('renders a plan-meal leftover with the source dish and servings', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'leftovers',
          leftoversSource: 'plan_meal',
          items: [
            eatItem({ recipeName: 'Tomato pasta', prepared: 0, eaten: 2 }),
          ],
        }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Leftovers')).toBeInTheDocument();
    expect(screen.getByText('Tomato pasta ×2')).toBeInTheDocument();
  });

  it('renders a takeaway leftover with the source label', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'leftovers',
          leftoversSource: 'takeaway',
        }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Leftovers')).toBeInTheDocument();
    expect(screen.getByText('Takeaway')).toBeInTheDocument();
  });
});
