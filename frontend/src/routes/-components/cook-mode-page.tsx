import { TRPCClientError } from '@trpc/client';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { GatherScreen } from '@/components/cook-mode/gather-screen.tsx';
import {
  GATHER_LABEL,
  StepListDialog,
} from '@/components/cook-mode/step-list-dialog.tsx';
import { StepScreen } from '@/components/cook-mode/step-screen.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useSwipe } from '@/hooks/use-swipe.ts';
import { useWakeLock } from '@/hooks/use-wake-lock.ts';
import { stepIngredientChips } from '@/lib/step-ingredient-amounts.ts';
import { trpc } from '@/lib/trpc.ts';

// Cook mode (DEC-116): a gather screen, then one method step per screen, with
// the screen kept awake. The portions and the screen live in the URL; ticks
// live here and are lost on reload.
export function CookModePage(): React.ReactElement {
  const params = useParams({ from: '/_authed/recipes/$recipeId/cook' });
  const search = useSearch({ from: '/_authed/recipes/$recipeId/cook' });
  const navigate = useNavigate();
  const recipeId = Number.parseInt(params.recipeId, 10);
  const idIsValid = Number.isInteger(recipeId) && recipeId > 0;
  const wakeLock = useWakeLock();
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [isStepListOpen, setIsStepListOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const query = trpc.recipes.get.useQuery(
    { id: recipeId },
    { enabled: idIsValid, retry: false },
  );
  const recipe = query.data;
  const lastStep = recipe?.method.length ?? 0;
  const step = Math.min(search.step ?? 0, lastStep);

  function goTo(next: number): void {
    setIsStepListOpen(false);
    void navigate({
      from: '/recipes/$recipeId/cook',
      search: (prev) =>
        next === 0
          ? { servings: prev.servings }
          : { servings: prev.servings, step: next },
      replace: true,
      resetScroll: true,
    });
  }

  function leave(): void {
    void navigate({
      to: '/recipes/$recipeId',
      params: { recipeId: params.recipeId },
      search: { servings: search.servings },
      replace: true,
    });
  }

  useEffect(() => {
    headingRef.current?.focus();
  }, [step, recipe?.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isStepListOpen || event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      if (event.key === 'ArrowRight' && step < lastStep) {
        goTo(step + 1);
      } else if (event.key === 'ArrowLeft') {
        if (step === 0) leave();
        else goTo(step - 1);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  useSwipe({
    enabled: recipe !== undefined && !isStepListOpen,
    onSwipeLeft: () => {
      if (step < lastStep) goTo(step + 1);
    },
    onSwipeRight: () => {
      if (step > 0) goTo(step - 1);
    },
  });

  if (!idIsValid) return <NotFound />;
  if (query.isLoading) return <p role="status">Loading recipe…</p>;
  if (query.error) {
    if (isNotFoundError(query.error)) return <NotFound />;
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load recipe: {query.error.message}
      </p>
    );
  }
  if (!recipe) return <NotFound />;

  const servings = search.servings ?? recipe.baseServings;
  const factor = servings / recipe.baseServings;
  const ingredientNames = recipe.ingredients.map((line) => line.ingredientName);
  const unitNames = recipe.ingredients.map((line) => line.unitName);
  const chipsByStep = stepIngredientChips(recipe.ingredients, recipe.method);
  const currentStep = step > 0 ? recipe.method[step - 1] : undefined;
  const nextStep = recipe.method[step];
  const label =
    step === 0 ? GATHER_LABEL : `Step ${String(step)} of ${String(lastStep)}`;

  return (
    <article className="mx-auto max-w-2xl space-y-6 pb-44">
      <header className="flex items-center justify-between gap-3">
        <Link
          to="/recipes/$recipeId"
          params={{ recipeId: params.recipeId }}
          search={{ servings: search.servings }}
          replace
          className="inline-flex h-11 items-center gap-1 rounded-md px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-5" />
          Exit
        </Link>
        <p className="min-w-0 truncate text-right text-sm text-muted-foreground">
          {recipe.name} · {String(servings)}{' '}
          {servings === 1 ? 'serving' : 'servings'}
        </p>
      </header>

      <h1 ref={headingRef} tabIndex={-1} className="focus:outline-none">
        <StepListDialog
          label={label}
          method={recipe.method}
          current={step}
          open={isStepListOpen}
          onOpenChange={setIsStepListOpen}
          onChoose={goTo}
        />
      </h1>

      {currentStep ? (
        <StepScreen
          key={currentStep.id}
          step={currentStep}
          chips={chipsByStep.get(currentStep.id) ?? []}
          factor={factor}
          baseServings={recipe.baseServings}
          ingredientNames={ingredientNames}
          unitNames={unitNames}
        />
      ) : (
        <div className="space-y-4">
          {wakeLock === 'unavailable' && (
            <p className="text-sm text-muted-foreground">
              This browser may let the screen sleep.
            </p>
          )}
          <GatherScreen
            lines={recipe.ingredients}
            factor={factor}
            ticked={ticked}
            onToggle={(lineId) => {
              setTicked((prev) => {
                const next = new Set(prev);
                if (!next.delete(lineId)) next.add(lineId);
                return next;
              });
            }}
          />
        </div>
      )}

      <nav
        aria-label="Cook mode"
        className="fixed inset-x-0 bottom-0 z-10 border-t bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto max-w-2xl space-y-3">
          {nextStep && (
            <p
              className="truncate text-sm text-muted-foreground"
              data-testid="cook-next-preview"
            >
              <span className="font-medium">Next:</span> {nextStep.instruction}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-14 text-lg"
              onClick={() => {
                if (step === 0) leave();
                else goTo(step - 1);
              }}
            >
              Back
            </Button>
            {step < lastStep ? (
              <Button
                type="button"
                className="h-14 text-lg"
                onClick={() => {
                  goTo(step + 1);
                }}
              >
                {step === 0 ? 'Start' : 'Next'}
              </Button>
            ) : (
              <Button type="button" className="h-14 text-lg" onClick={leave}>
                Finish
              </Button>
            )}
          </div>
        </div>
      </nav>
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
