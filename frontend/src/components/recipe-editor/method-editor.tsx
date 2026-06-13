import type {
  RecipeMethodStep,
  ReplaceRecipeMethodStepInput,
} from '@loftys-larder/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button.tsx';

interface DraftStep {
  rowKey: string;
  instruction: string;
  error?: string;
}

export interface MethodDraftStep {
  instruction: string;
}

export interface MethodEditorProps {
  initialSteps: readonly RecipeMethodStep[];
  // If provided, the editor seeds its state from these draft steps instead
  // of `initialSteps`. Used by the draft autosave hook on mount; omit it
  // and the editor behaves exactly as before.
  initialDraftSteps?: readonly MethodDraftStep[];
  onSubmit: (steps: ReplaceRecipeMethodStepInput[]) => Promise<void>;
  // Fires whenever the in-progress step list changes. Used by the draft
  // autosave hook — omit to opt out of autosave.
  onStepsChange?: (steps: MethodDraftStep[]) => void;
  savedNoticeKey?: number;
}

let nextRowSeed = 0;
function newRowKey(): string {
  nextRowSeed += 1;
  return `new-${String(nextRowSeed)}`;
}

function toDraft(step: RecipeMethodStep): DraftStep {
  return {
    rowKey: `existing-${String(step.id)}`,
    instruction: step.instruction,
  };
}

export function MethodEditor({
  initialSteps,
  initialDraftSteps,
  onSubmit,
  onStepsChange,
  savedNoticeKey,
}: MethodEditorProps): React.ReactElement {
  const [steps, setSteps] = useState<DraftStep[]>(() => {
    if (initialDraftSteps) {
      return initialDraftSteps.map((step) => ({
        rowKey: newRowKey(),
        instruction: step.instruction,
      }));
    }
    return initialSteps.map(toDraft);
  });

  useEffect(() => {
    if (!onStepsChange) return;
    onStepsChange(steps.map((step) => ({ instruction: step.instruction })));
  }, [steps, onStepsChange]);
  const [submitting, setSubmitting] = useState(false);
  const focusNewIndex = useRef<number | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  const updateStep = useCallback((rowKey: string, instruction: string) => {
    setSteps((current) =>
      current.map((step) =>
        step.rowKey === rowKey
          ? { ...step, instruction, error: undefined }
          : step,
      ),
    );
  }, []);

  const removeStep = useCallback((rowKey: string) => {
    setSteps((current) => current.filter((step) => step.rowKey !== rowKey));
  }, []);

  const moveStep = useCallback((index: number, direction: -1 | 1) => {
    setSteps((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return current;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }, []);

  const addStep = useCallback(() => {
    setSteps((current) => {
      focusNewIndex.current = current.length;
      return [...current, { rowKey: newRowKey(), instruction: '' }];
    });
  }, []);

  // Focus the most-recently-added step's textarea once it renders.
  function registerTextarea(
    rowKey: string,
    el: HTMLTextAreaElement | null,
  ): void {
    if (el) {
      textareaRefs.current.set(rowKey, el);
      const stepIndex = steps.findIndex((s) => s.rowKey === rowKey);
      if (
        focusNewIndex.current !== null &&
        stepIndex === focusNewIndex.current
      ) {
        el.focus();
        focusNewIndex.current = null;
      }
    } else {
      textareaRefs.current.delete(rowKey);
    }
  }

  async function handleSubmit(event: React.SyntheticEvent): Promise<void> {
    event.preventDefault();

    let firstInvalid = -1;
    const validated = steps.map((step, index) => {
      const trimmed = step.instruction.trim();
      if (trimmed.length === 0) {
        if (firstInvalid < 0) firstInvalid = index;
        return { ...step, error: 'Step text is required' };
      }
      return { ...step, error: undefined };
    });

    if (firstInvalid >= 0) {
      setSteps(validated);
      return;
    }

    const payload: ReplaceRecipeMethodStepInput[] = steps.map((step) => ({
      instruction: step.instruction.trim(),
    }));

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="space-y-4"
      noValidate
      aria-labelledby="recipe-method-heading"
    >
      <h2 id="recipe-method-heading" className="text-lg font-semibold">
        Method
      </h2>

      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No steps yet. Click &ldquo;Add step&rdquo; to start.
        </p>
      ) : (
        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li
              key={step.rowKey}
              className="flex items-start gap-2 rounded-md border border-input p-2"
            >
              <span
                className="mt-2 w-6 text-center text-sm font-medium text-muted-foreground"
                aria-hidden
              >
                {index + 1}.
              </span>
              <div className="flex-1 space-y-1">
                <textarea
                  ref={(el) => {
                    registerTextarea(step.rowKey, el);
                  }}
                  aria-label={`Step ${String(index + 1)} text`}
                  rows={2}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={step.instruction}
                  onChange={(event) => {
                    updateStep(step.rowKey, event.target.value);
                  }}
                />
                {step.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {step.error}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Move step ${String(index + 1)} up`}
                  disabled={index === 0}
                  onClick={() => {
                    moveStep(index, -1);
                  }}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Move step ${String(index + 1)} down`}
                  disabled={index === steps.length - 1}
                  onClick={() => {
                    moveStep(index, 1);
                  }}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove step ${String(index + 1)}`}
                  onClick={() => {
                    removeStep(step.rowKey);
                  }}
                >
                  ×
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" onClick={addStep}>
          Add step
        </Button>

        <div className="flex items-center gap-3">
          {savedNoticeKey !== undefined && (
            <p
              key={savedNoticeKey}
              role="status"
              className="text-sm text-emerald-600"
            >
              Saved.
            </p>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save method'}
          </Button>
        </div>
      </div>
    </form>
  );
}
