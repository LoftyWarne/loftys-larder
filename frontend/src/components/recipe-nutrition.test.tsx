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
        estimated={false}
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
    render(
      <RecipeNutrition
        values={{ ...EMPTY, sugarPerServing: 0 }}
        estimated={false}
      />,
    );
    expect(screen.getByRole('definition')).toHaveTextContent('0 g');
  });

  it('renders nothing when no nutrition is recorded', () => {
    const { container } = render(
      <RecipeNutrition values={EMPTY} estimated={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('heads the section as estimated while the flag is set', () => {
    render(
      <RecipeNutrition
        values={{ ...EMPTY, caloriesPerServing: 410 }}
        estimated={true}
      />,
    );
    expect(
      screen.getByRole('heading', {
        name: 'Nutrition per serving · estimated',
      }),
    ).toBeInTheDocument();
  });

  it('leaves the estimated label off when the flag is clear', () => {
    render(
      <RecipeNutrition
        values={{ ...EMPTY, caloriesPerServing: 410 }}
        estimated={false}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Nutrition per serving' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/estimated/)).not.toBeInTheDocument();
  });
});
