import type { PlanSlot } from '@loftys-larder/shared';
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
  recipeId: null,
  numberOfServings: null,
  chefUserId: null,
  cooksBaseRecipeId: null,
  cooksBaseServings: null,
  comment: null,
  recipe: null,
  cooksBaseRecipe: null,
};

describe('SlotCell', () => {
  it('renders the recipe name and servings for an assigned slot', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'recipe',
          recipeId: 10,
          numberOfServings: 2,
          recipe: {
            id: 10,
            name: 'Tomato pasta',
            imageUrl: null,
            isBase: false,
            baseRecipeId: null,
            isDeleted: false,
          },
        }}
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Tomato pasta')).toBeInTheDocument();
    expect(screen.getByText('2 servings')).toBeInTheDocument();
  });

  it('renders a "(deleted)" hint when the slot still points at a soft-deleted recipe', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'recipe',
          recipeId: 10,
          numberOfServings: 2,
          recipe: {
            id: 10,
            name: 'Old recipe',
            imageUrl: null,
            isBase: false,
            baseRecipeId: null,
            isDeleted: true,
          },
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

  it('renders the baseCookLine prop when the parent provides one', () => {
    render(
      <SlotCell
        slot={{
          ...BASE_SLOT,
          slotType: 'recipe',
          recipeId: 10,
          numberOfServings: 2,
          cooksBaseRecipeId: 22,
          cooksBaseServings: 8,
          recipe: {
            id: 10,
            name: 'Curry',
            imageUrl: null,
            isBase: false,
            baseRecipeId: 22,
            isDeleted: false,
          },
          cooksBaseRecipe: {
            id: 22,
            name: 'Curry Base',
            isDeleted: false,
          },
        }}
        baseCookLine={
          <span data-testid="cook-line">Cook base: Curry Base (×8)</span>
        }
        onClick={() => undefined}
      />,
    );
    expect(screen.getByTestId('cook-line')).toHaveTextContent(
      'Cook base: Curry Base (×8)',
    );
  });
});
