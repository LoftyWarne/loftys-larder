import { RECIPE_VIEW_SERVINGS_MAX } from '@loftys-larder/shared';
import { TRPCClientError } from '@trpc/client';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';

import { ViewOriginalButton } from '@/components/original-images.tsx';
import { PlanAheadSummary } from '@/components/plan-ahead-summary.tsx';
import { PortionsStepper } from '@/components/portions-stepper.tsx';
import { PrepAheadBadge } from '@/components/prep-ahead-badge.tsx';
import { RecipeComments } from '@/components/recipe-comments.tsx';
import { RecipeHealthScore } from '@/components/recipe-health-score.tsx';
import { RecipeNutrition } from '@/components/recipe-nutrition.tsx';
import { RecipeRating } from '@/components/recipe-rating.tsx';
import { RecipeTagList } from '@/components/recipe-tag-list.tsx';
import { RelatedRecipes } from '@/components/related-recipes.tsx';
import { StepIngredientChips } from '@/components/step-ingredient-chips.tsx';
import { StepInstruction } from '@/components/step-instruction.tsx';
import { StepNoteCallout } from '@/components/step-note-callout.tsx';
import { formatAverageRating } from '@/lib/format-rating.ts';
import { formatScaledQuantity } from '@/lib/scale-quantity.ts';
import { stepIngredientChips } from '@/lib/step-ingredient-amounts.ts';
import { mentionsQuantity } from '@/lib/step-highlights.ts';
import { trpc } from '@/lib/trpc.ts';

export function RecipeDetailPage(): React.ReactElement {
  const params = useParams({ from: '/_authed/recipes/$recipeId/' });
  const search = useSearch({ from: '/_authed/recipes/$recipeId/' });
  const navigate = useNavigate();
  const recipeId = Number.parseInt(params.recipeId, 10);
  const idIsValid = Number.isInteger(recipeId) && recipeId > 0;

  const query = trpc.recipes.get.useQuery(
    { id: recipeId },
    { enabled: idIsValid, retry: false },
  );

  if (!idIsValid) {
    return <NotFound />;
  }

  if (query.isLoading) {
    return <p role="status">Loading recipe…</p>;
  }

  if (query.error) {
    if (isNotFoundError(query.error)) return <NotFound />;
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load recipe: {query.error.message}
      </p>
    );
  }

  const recipe = query.data;
  if (!recipe) return <NotFound />;
  const ingredientNames = recipe.ingredients.map((line) => line.ingredientName);
  const unitNames = recipe.ingredients.map((line) => line.unitName);
  // Display-only scaling (DEC-98): the number lives in `?servings=`, absent
  // means the recipe's own servings.
  const servings = search.servings ?? recipe.baseServings;
  const factor = servings / recipe.baseServings;
  const isScaled = servings !== recipe.baseServings;
  const chipsByStep = stepIngredientChips(recipe.ingredients, recipe.method);
  const stepsStateAmounts =
    isScaled &&
    recipe.method.some((step) => mentionsQuantity(step.instruction, unitNames));

  // Applied to the URL as it is at navigation time, not as last rendered, so
  // two quick taps on + add two servings.
  function updateServings(update: (current: number) => number): void {
    const baseServings = recipe?.baseServings ?? 1;
    void navigate({
      from: '/recipes/$recipeId/',
      search: (prev) => {
        const next = Math.min(
          Math.max(update(prev.servings ?? baseServings), 1),
          RECIPE_VIEW_SERVINGS_MAX,
        );
        return next === baseServings ? {} : { servings: next };
      },
      replace: true,
      resetScroll: false,
    });
  }

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <p className="flex items-center justify-between text-sm">
          <Link to="/recipes" className="text-muted-foreground hover:underline">
            ← Back to recipes
          </Link>
          <Link
            to="/recipes/$recipeId/edit"
            params={{ recipeId: String(recipe.id) }}
            className="text-primary hover:underline"
          >
            Edit recipe
          </Link>
        </p>
        <h1 className="text-3xl font-semibold">{recipe.name}</h1>
        {recipe.description && (
          <p className="text-muted-foreground">{recipe.description}</p>
        )}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {recipe.isBase && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              Base recipe
            </span>
          )}
          <span>Serves {String(recipe.baseServings)}</span>
          {recipe.totalTimeMins !== null && (
            <span>· {String(recipe.totalTimeMins)} min total</span>
          )}
          {recipe.activeTimeMins !== null && (
            <span>· {String(recipe.activeTimeMins)} min active</span>
          )}
          <span>· 🌱 {String(recipe.plantPointsCount)}</span>
          {recipe.ratingCount > 0 && (
            <span aria-label="average rating">
              · ★ {formatAverageRating(recipe.averageRating)} (
              {String(recipe.ratingCount)})
            </span>
          )}
          {(recipe.sourceName ?? recipe.sourceDetail) && (
            <span>
              ·{' '}
              {recipe.sourceName &&
                (recipe.sourceUrl ? (
                  <a
                    href={recipe.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:underline"
                  >
                    {recipe.sourceName}
                  </a>
                ) : (
                  recipe.sourceName
                ))}
              {recipe.sourceDetail && (
                <>
                  {recipe.sourceName ? ', ' : ''}
                  {recipe.sourceDetail}
                </>
              )}
            </span>
          )}
        </p>
        {recipe.originals.length > 0 && (
          <ViewOriginalButton originals={recipe.originals} />
        )}
        <RecipeTagList tags={recipe.tags} />
        <RecipeRating
          recipeId={recipe.id}
          yourRating={recipe.yourRating}
          isDisabled={recipe.isDeleted}
        />
      </header>

      {recipe.imageUrl && (
        <img
          src={recipe.imageUrl}
          alt={recipe.name}
          className="aspect-[4/3] w-full rounded-lg object-cover"
        />
      )}

      <section className="space-y-2" aria-labelledby="ingredients-heading">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="ingredients-heading" className="text-xl font-semibold">
            Ingredients
          </h2>
          <PortionsStepper
            servings={servings}
            baseServings={recipe.baseServings}
            max={RECIPE_VIEW_SERVINGS_MAX}
            onStep={(delta) => {
              updateServings((current) => current + delta);
            }}
            onReset={() => {
              updateServings(() => recipe.baseServings);
            }}
          />
        </div>
        {recipe.ingredients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ingredients yet.</p>
        ) : (
          <ul className="space-y-1">
            {recipe.ingredients.map((line) => (
              <li key={line.id} className="text-sm">
                <span className="font-medium">
                  {formatScaledQuantity(
                    Number(line.quantity),
                    line.unitName,
                    factor,
                  )}{' '}
                  {line.unitName}
                </span>{' '}
                {line.ingredientName}
                {line.prepTypeName && (
                  <span className="text-muted-foreground">
                    , {line.prepTypeName}
                  </span>
                )}
                {line.isOptional && (
                  <span className="text-muted-foreground"> (optional)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <RecipeNutrition
        values={recipe}
        estimated={recipe.nutritionIsEstimated}
      />

      <RecipeHealthScore
        recipeId={recipe.id}
        healthScore={recipe.healthScore}
        hasIngredients={
          recipe.ingredients.length > 0 || recipe.baseRecipeId !== null
        }
        isDeleted={recipe.isDeleted}
      />

      <PlanAheadSummary
        method={recipe.method}
        ingredientNames={ingredientNames}
        unitNames={unitNames}
        boldQuantities={!isScaled}
      />

      <section className="space-y-2" aria-labelledby="method-heading">
        <h2 id="method-heading" className="text-xl font-semibold">
          Method
        </h2>
        {stepsStateAmounts && (
          <p className="text-sm text-muted-foreground">
            Amounts written in the steps are for the original{' '}
            {recipe.baseServings} servings.
          </p>
        )}
        {recipe.method.length === 0 ? (
          <p className="text-sm text-muted-foreground">No method yet.</p>
        ) : (
          <ol className="space-y-2 list-decimal pl-5">
            {recipe.method.map((step) => (
              <li key={step.id} className="text-sm">
                {step.prepAhead !== null && (
                  <PrepAheadBadge
                    prepAhead={step.prepAhead}
                    className="mb-1 flex w-fit"
                  />
                )}
                <StepInstruction
                  text={step.instruction}
                  ingredientNames={ingredientNames}
                  unitNames={unitNames}
                  boldQuantities={!isScaled}
                />
                <StepIngredientChips
                  stepNumber={step.stepNumber}
                  chips={chipsByStep.get(step.id) ?? []}
                  factor={factor}
                />
                {(step.safetyNote !== null || step.tip !== null) && (
                  <div className="mt-2 space-y-2">
                    {step.safetyNote !== null && (
                      <StepNoteCallout kind="safety">
                        <p>{step.safetyNote}</p>
                      </StepNoteCallout>
                    )}
                    {step.tip !== null && (
                      <StepNoteCallout kind="tip">
                        <p>{step.tip}</p>
                      </StepNoteCallout>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <RelatedRecipes recipeId={recipe.id} isDisabled={recipe.isDeleted} />

      <RecipeComments recipeId={recipe.id} />
    </article>
  );
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === 'NOT_FOUND';
}

function NotFound(): React.ReactElement {
  return (
    <section className="mx-auto max-w-3xl space-y-3">
      <h1 className="text-2xl font-semibold">Recipe not found</h1>
      <p className="text-sm text-muted-foreground">
        This recipe doesn’t exist or isn’t available.
      </p>
      <p className="text-sm">
        <Link to="/recipes" className="hover:underline">
          ← Back to recipes
        </Link>
      </p>
    </section>
  );
}
