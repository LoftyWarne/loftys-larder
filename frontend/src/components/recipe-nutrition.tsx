import {
  formatNutritionValue,
  NUTRITION_FIELDS,
  type NutritionValues,
} from '@/lib/nutrition.ts';

// Per-serving values, so the portions stepper (DEC-98) doesn't change them.
// Hidden when the recipe has no nutrition recorded.
export function RecipeNutrition({
  values,
  estimated,
}: {
  values: NutritionValues;
  estimated: boolean;
}): React.ReactElement | null {
  const rows = NUTRITION_FIELDS.flatMap((field) => {
    const value = values[field.key];
    return value === null ? [] : [{ ...field, value }];
  });
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2" aria-labelledby="nutrition-heading">
      <h2 id="nutrition-heading" className="text-xl font-semibold">
        Nutrition per serving
        {estimated && (
          <span className="font-normal text-muted-foreground">
            {' '}
            · estimated
          </span>
        )}
      </h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.key} className="rounded-md border px-3 py-2">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="text-sm font-medium">
              {formatNutritionValue(row.value, row.unit)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
