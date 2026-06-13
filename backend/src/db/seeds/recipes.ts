import { and, eq, sql } from 'drizzle-orm';

import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { ingredients } from '../schema/ingredients.ts';
import { recipeIngredients, recipeMethod, recipes } from '../schema/recipes.ts';
import {
  ingredientCategories,
  preparationTypes,
  unitsOfMeasurement,
} from '../schema/reference.ts';
import type { Tx } from '../withTransaction.ts';

// A small dev fixture so the browse view has something to render after a
// fresh migration. Idempotent: each seed step checks for existing rows
// (case-insensitive name within the household) and skips if present.

interface IngredientSpec {
  name: string;
  category: string;
  unit: string;
  isPlant: boolean;
}

interface RecipeIngredientSpec {
  ingredientName: string;
  quantity: string;
  prepType?: string;
}

interface RecipeSpec {
  name: string;
  description: string;
  baseServings: number;
  activeTimeMins: number;
  totalTimeMins: number;
  imageUrl?: string;
  ingredients: RecipeIngredientSpec[];
  method: string[];
}

const INGREDIENT_FIXTURES: IngredientSpec[] = [
  { name: 'Onion', category: 'Fruit & Veg', unit: 'piece', isPlant: true },
  { name: 'Garlic', category: 'Fruit & Veg', unit: 'piece', isPlant: true },
  { name: 'Carrot', category: 'Fruit & Veg', unit: 'piece', isPlant: true },
  { name: 'Tomato', category: 'Fruit & Veg', unit: 'piece', isPlant: true },
  { name: 'Olive oil', category: 'Pantry', unit: 'tbsp', isPlant: true },
  { name: 'Pasta', category: 'Pantry', unit: 'g', isPlant: true },
  { name: 'Butter', category: 'Dairy', unit: 'g', isPlant: false },
  { name: 'Chicken thigh', category: 'Meat', unit: 'g', isPlant: false },
];

const RECIPE_FIXTURES: RecipeSpec[] = [
  {
    name: 'Tomato pasta',
    description: 'A weeknight standby with whatever tomatoes are around.',
    baseServings: 2,
    activeTimeMins: 10,
    totalTimeMins: 25,
    ingredients: [
      { ingredientName: 'Pasta', quantity: '200' },
      { ingredientName: 'Tomato', quantity: '4', prepType: 'chopped' },
      { ingredientName: 'Garlic', quantity: '2', prepType: 'minced' },
      { ingredientName: 'Olive oil', quantity: '2' },
    ],
    method: [
      'Boil a pan of salted water and cook the pasta.',
      'Warm the olive oil and soften the garlic.',
      'Add the chopped tomato, reduce, and toss with the drained pasta.',
    ],
  },
  {
    name: 'Roast chicken with veg',
    description: 'A simple sheet-pan dinner.',
    baseServings: 4,
    activeTimeMins: 15,
    totalTimeMins: 50,
    ingredients: [
      { ingredientName: 'Chicken thigh', quantity: '600' },
      { ingredientName: 'Carrot', quantity: '3', prepType: 'chopped' },
      { ingredientName: 'Onion', quantity: '1', prepType: 'sliced' },
      { ingredientName: 'Butter', quantity: '20' },
    ],
    method: [
      'Heat the oven to 200°C.',
      'Toss vegetables in butter and roast for 15 minutes.',
      'Add the chicken thighs and roast until cooked through, about 25 minutes.',
    ],
  },
];

export async function seedDevRecipes(tx: Tx): Promise<void> {
  const categoryRows = await tx.select().from(ingredientCategories);
  const unitRows = await tx.select().from(unitsOfMeasurement);
  const prepRows = await tx.select().from(preparationTypes);

  const categoryByName = new Map(categoryRows.map((r) => [r.name, r.id]));
  const unitByName = new Map(unitRows.map((r) => [r.name, r.id]));
  const prepByName = new Map(prepRows.map((r) => [r.name, r.id]));

  for (const spec of INGREDIENT_FIXTURES) {
    const categoryId = categoryByName.get(spec.category);
    const unitId = unitByName.get(spec.unit);
    if (categoryId === undefined || unitId === undefined) continue;
    await tx
      .insert(ingredients)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: spec.name,
        categoryId,
        defaultUnitId: unitId,
        isPlant: spec.isPlant,
      })
      .onConflictDoNothing();
  }

  const ingredientRows = await tx
    .select({ id: ingredients.id, name: ingredients.name })
    .from(ingredients)
    .where(eq(ingredients.householdId, CURRENT_HOUSEHOLD_ID));
  const ingredientByName = new Map(ingredientRows.map((r) => [r.name, r.id]));

  for (const recipe of RECIPE_FIXTURES) {
    const existing = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(
        and(
          eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
          sql`lower(${recipes.name}) = ${recipe.name.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;

    const inserted = await tx
      .insert(recipes)
      .values({
        householdId: CURRENT_HOUSEHOLD_ID,
        name: recipe.name,
        description: recipe.description,
        baseServings: recipe.baseServings,
        activeTimeMins: recipe.activeTimeMins,
        totalTimeMins: recipe.totalTimeMins,
        imageUrl: recipe.imageUrl,
      })
      .returning({ id: recipes.id });
    const row = inserted[0];
    if (!row) continue;
    const recipeId = row.id;

    const lineValues = recipe.ingredients.flatMap((line) => {
      const ingredientId = ingredientByName.get(line.ingredientName);
      if (ingredientId === undefined) return [];
      const prepTypeId = line.prepType
        ? (prepByName.get(line.prepType) ?? null)
        : null;
      return [
        {
          recipeId,
          ingredientId,
          quantity: line.quantity,
          prepTypeId,
        },
      ];
    });
    if (lineValues.length > 0) {
      await tx.insert(recipeIngredients).values(lineValues);
    }

    await tx.insert(recipeMethod).values(
      recipe.method.map((instruction, index) => ({
        recipeId,
        stepNumber: index + 1,
        instruction,
      })),
    );
  }
}
