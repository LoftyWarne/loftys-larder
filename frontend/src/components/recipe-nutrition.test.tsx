import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { NutritionValues } from '@/lib/nutrition.ts';

import { RecipeNutrition } from './recipe-nutrition.tsx';

const EMPTY: NutritionValues = {
  caloriesPerServing: null,
  fatPerServing: null,
  saturatedFatPerServing: null,
  carbsPerServing: null,
  sugarPerServing: null,
  fibrePerServing: null,
  proteinPerServing: null,
  saltPerServing: null,
};

describe('RecipeNutrition', () => {
  it('lists only the recorded values, in label order, with units', () => {
    render(
      <RecipeNutrition
        values={{
          ...EMPTY,
          caloriesPerServing: 1210,
          saturatedFatPerServing: 2.5,
          proteinPerServing: 18,
          saltPerServing: 0.45,
        }}
      />,
    );

    const section = screen.getByRole('region', {
      name: 'Nutrition per serving',
    });
    expect(
      within(section)
        .getAllByRole('term')
        .map((el) => el.textContent),
    ).toEqual(['Calories', 'Saturates', 'Protein', 'Salt']);
    expect(
      within(section)
        .getAllByRole('definition')
        .map((el) => el.textContent),
    ).toEqual(['1,210 kcal', '2.5 g', '18 g', '0.45 g']);
  });

  it('shows a zero value rather than hiding it', () => {
    render(<RecipeNutrition values={{ ...EMPTY, sugarPerServing: 0 }} />);
    expect(screen.getByRole('definition')).toHaveTextContent('0 g');
  });

  it('renders nothing when no nutrition is recorded', () => {
    const { container } = render(<RecipeNutrition values={EMPTY} />);
    expect(container).toBeEmptyDOMElement();
  });
});
