import type { Recipe } from '@loftys-larder/shared';

export type NutritionKey =
  | 'caloriesPerServing'
  | 'fatPerServing'
  | 'saturatedFatPerServing'
  | 'carbsPerServing'
  | 'sugarPerServing'
  | 'fibrePerServing'
  | 'proteinPerServing'
  | 'saltPerServing';

export type NutritionValues = Pick<Recipe, NutritionKey>;

export interface NutritionField {
  key: NutritionKey;
  slug: string;
  label: string;
  unit: 'kcal' | 'g';
}

// UK front-of-pack order, shared by the recipe page and the editor so the two
// always list the same fields the same way.
export const NUTRITION_FIELDS: readonly NutritionField[] = [
  {
    key: 'caloriesPerServing',
    slug: 'calories',
    label: 'Calories',
    unit: 'kcal',
  },
  { key: 'fatPerServing', slug: 'fat', label: 'Fat', unit: 'g' },
  {
    key: 'saturatedFatPerServing',
    slug: 'saturates',
    label: 'Saturates',
    unit: 'g',
  },
  { key: 'carbsPerServing', slug: 'carbs', label: 'Carbs', unit: 'g' },
  { key: 'sugarPerServing', slug: 'sugars', label: 'Sugars', unit: 'g' },
  { key: 'fibrePerServing', slug: 'fibre', label: 'Fibre', unit: 'g' },
  { key: 'proteinPerServing', slug: 'protein', label: 'Protein', unit: 'g' },
  { key: 'saltPerServing', slug: 'salt', label: 'Salt', unit: 'g' },
];

const numberFormat = new Intl.NumberFormat('en-GB', {
  maximumFractionDigits: 2,
});

export function formatNutritionValue(
  value: number,
  unit: NutritionField['unit'],
): string {
  return `${numberFormat.format(value)} ${unit}`;
}
