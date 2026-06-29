import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RecipeTypeBadge, recipeType } from './recipe-type-badge.tsx';

describe('recipeType', () => {
  it('classifies a base recipe', () => {
    expect(recipeType({ isBase: true, baseRecipeId: null })).toBe('Base');
  });

  it('classifies a serving variation', () => {
    expect(recipeType({ isBase: false, baseRecipeId: 7 })).toBe('Variant');
  });

  it('classifies a standalone dish', () => {
    expect(recipeType({ isBase: false, baseRecipeId: null })).toBe(
      'Standalone',
    );
  });
});

describe('RecipeTypeBadge', () => {
  it('renders the classified type label', () => {
    render(<RecipeTypeBadge recipe={{ isBase: true, baseRecipeId: null }} />);
    expect(screen.getByTestId('recipe-type-badge')).toHaveTextContent('Base');
  });
});
