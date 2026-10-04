import type { RecipeMethodStep } from '@loftys-larder/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  MethodEditor,
  type MethodEditorHandle,
  type MethodIngredient,
} from './method-editor.tsx';

function step(
  id: number,
  text: string,
  notes: {
    safetyNote?: string;
    tip?: string;
    prepAhead?: RecipeMethodStep['prepAhead'];
    ingredients?: RecipeMethodStep['ingredients'];
  } = {},
): RecipeMethodStep {
  return {
    id,
    stepNumber: id,
    instruction: text,
    safetyNote: notes.safetyNote ?? null,
    tip: notes.tip ?? null,
    prepAhead: notes.prepAhead ?? null,
    ingredients: notes.ingredients ?? [],
  };
}

describe('MethodEditor', () => {
  it('adds a step, focuses the new textarea, and submits in display order', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<MethodEditor initialSteps={[]} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const textarea = screen.getByLabelText('Step 1 text');
    expect(textarea).toHaveFocus();
    await user.type(textarea, 'Heat oil');

    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const secondTextarea = screen.getByLabelText('Step 2 text');
    expect(secondTextarea).toHaveFocus();
    await user.type(secondTextarea, 'Add onions');

    await user.click(screen.getByRole('button', { name: 'Save method' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        instruction: 'Heat oil',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: [],
      },
      {
        instruction: 'Add onions',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: [],
      },
    ]);
  });

  it('disables Add step until every step has text', async () => {
    const user = userEvent.setup();
    render(<MethodEditor initialSteps={[]} onSubmit={vi.fn()} />);
    const addButton = screen.getByRole('button', { name: 'Add step' });

    // Enabled from the empty state — nothing precedes the first step.
    expect(addButton).toBeEnabled();

    await user.click(addButton);
    expect(addButton).toBeDisabled();

    // Whitespace alone doesn't count as step text.
    await user.type(screen.getByLabelText('Step 1 text'), '   ');
    expect(addButton).toBeDisabled();

    await user.type(screen.getByLabelText('Step 1 text'), 'Heat oil');
    expect(addButton).toBeEnabled();
  });

  it('explains via a tooltip why Add step is disabled', async () => {
    const user = userEvent.setup();
    render(<MethodEditor initialSteps={[]} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const addButton = screen.getByRole('button', { name: 'Add step' });
    expect(addButton).toBeDisabled();

    // The disabled button has `pointer-events-none`, so hover the wrapper the
    // tooltip trigger sits on.
    const trigger = addButton.parentElement;
    if (!trigger) throw new Error('expected a tooltip trigger wrapper');
    await user.hover(trigger);

    expect(
      await screen.findByRole('tooltip', {
        name: /Fill in each step before adding another/i,
      }),
    ).toBeInTheDocument();
  });

  it('reorders steps with up/down buttons and disables at boundaries', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <MethodEditor
        initialSteps={[step(1, 'A'), step(2, 'B'), step(3, 'C')]}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Move step 1 up' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move step 3 down' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    await user.click(screen.getByRole('button', { name: 'Save method' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      {
        instruction: 'B',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: [],
      },
      {
        instruction: 'A',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: [],
      },
      {
        instruction: 'C',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: [],
      },
    ]);
  });

  it('removes a step and excludes it from the submitted payload', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <MethodEditor
        initialSteps={[step(1, 'A'), step(2, 'B')]}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove step 1' }));
    await user.click(screen.getByRole('button', { name: 'Save method' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([
        {
          instruction: 'B',
          safetyNote: null,
          tip: null,
          prepAhead: null,
          ingredients: [],
        },
      ]);
    });
  });

  it('rejects an empty step text and surfaces an inline error', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<MethodEditor initialSteps={[]} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Add step' }));
    await user.click(screen.getByRole('button', { name: 'Save method' }));

    expect(await screen.findByText('Step text is required')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims whitespace before submitting', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<MethodEditor initialSteps={[]} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Add step' }));
    await user.type(screen.getByLabelText('Step 1 text'), '  Heat oil  ');
    await user.click(screen.getByRole('button', { name: 'Save method' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith([
        {
          instruction: 'Heat oil',
          safetyNote: null,
          tip: null,
          prepAhead: null,
          ingredients: [],
        },
      ]);
    });
  });

  it('clears the "Saved." notice once a step is edited', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { rerender } = render(
      <MethodEditor initialSteps={[step(1, 'Heat oil')]} onSubmit={onSubmit} />,
    );

    expect(screen.queryByText('Saved.')).toBeNull();

    // The page bumps `savedNoticeKey` when a save lands.
    rerender(
      <MethodEditor
        initialSteps={[step(1, 'Heat oil')]}
        onSubmit={onSubmit}
        savedNoticeKey={Date.now()}
      />,
    );
    expect(screen.getByText('Saved.')).toBeVisible();

    // Editing a step marks the section dirty — the stale notice must go.
    await user.type(screen.getByLabelText('Step 1 text'), ' more');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  describe('step notes', () => {
    it('opens a safety note and a tip, focuses the note, and submits them', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor initialSteps={[step(1, 'Fry')]} onSubmit={onSubmit} />,
      );

      await user.click(
        screen.getByRole('button', { name: 'Add safety note to step 1' }),
      );
      const safety = screen.getByLabelText('Step 1 safety note');
      expect(safety).toHaveFocus();
      await user.type(safety, '  Oil will spit  ');
      expect(
        screen.queryByRole('button', { name: 'Add safety note to step 1' }),
      ).toBeNull();

      await user.click(
        screen.getByRole('button', { name: 'Add tip to step 1' }),
      );
      await user.type(screen.getByLabelText('Step 1 tip'), 'Pat dry first');

      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'Fry',
            safetyNote: 'Oil will spit',
            tip: 'Pat dry first',
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('sends an opened-but-blank note as null', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor initialSteps={[step(1, 'Fry')]} onSubmit={onSubmit} />,
      );

      await user.click(
        screen.getByRole('button', { name: 'Add tip to step 1' }),
      );
      await user.type(screen.getByLabelText('Step 1 tip'), '   ');
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'Fry',
            safetyNote: null,
            tip: null,
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('seeds existing notes and removes one', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Fry', { safetyNote: 'Hot oil', tip: 'Dry it' }),
          ]}
          onSubmit={onSubmit}
        />,
      );

      expect(screen.getByLabelText('Step 1 safety note')).toHaveValue(
        'Hot oil',
      );
      expect(screen.getByLabelText('Step 1 tip')).toHaveValue('Dry it');

      await user.click(
        screen.getByRole('button', { name: 'Remove safety note from step 1' }),
      );
      expect(screen.queryByLabelText('Step 1 safety note')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Add safety note to step 1' }),
      ).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Save method' }));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'Fry',
            safetyNote: null,
            tip: 'Dry it',
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('keeps notes attached to their step when reordering', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[step(1, 'A'), step(2, 'B', { tip: 'B tip' })]}
          onSubmit={onSubmit}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Move step 2 up' }));
      expect(screen.getByLabelText('Step 1 tip')).toHaveValue('B tip');

      await user.click(screen.getByRole('button', { name: 'Save method' }));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'B',
            safetyNote: null,
            tip: 'B tip',
            prepAhead: null,
            ingredients: [],
          },
          {
            instruction: 'A',
            safetyNote: null,
            tip: null,
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('seeds a legacy draft without note fields as no notes', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[]}
          initialDraftSteps={[{ instruction: 'From draft' }]}
          onSubmit={onSubmit}
        />,
      );

      expect(screen.queryByLabelText('Step 1 safety note')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Save method' }));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'From draft',
            safetyNote: null,
            tip: null,
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('still requires step text when the step has a note', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<MethodEditor initialSteps={[]} onSubmit={onSubmit} />);

      await user.click(screen.getByRole('button', { name: 'Add step' }));
      await user.click(
        screen.getByRole('button', { name: 'Add tip to step 1' }),
      );
      await user.type(screen.getByLabelText('Step 1 tip'), 'A tip');

      expect(screen.getByRole('button', { name: 'Add step' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Save method' }));
      expect(await screen.findByText('Step text is required')).toBeVisible();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('includes notes in the autosave payload', async () => {
      const onStepsChange = vi.fn();
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[step(1, 'Fry')]}
          onSubmit={vi.fn()}
          onStepsChange={onStepsChange}
        />,
      );

      await user.click(
        screen.getByRole('button', { name: 'Add tip to step 1' }),
      );
      await user.type(screen.getByLabelText('Step 1 tip'), 'X');

      expect(onStepsChange).toHaveBeenLastCalledWith([
        {
          key: 'existing-1',
          instruction: 'Fry',
          safetyNote: null,
          tip: 'X',
          prepAhead: null,
          ingredients: [],
          followsText: true,
        },
      ]);
    });
  });

  describe('prep ahead', () => {
    it('marks a step as must-be-done-ahead and sends it on save', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[step(1, 'Marinate'), step(2, 'Grill')]}
          onSubmit={onSubmit}
        />,
      );

      const select = screen.getByLabelText('Step 1 prep ahead');
      expect(select).toHaveValue('');
      await user.selectOptions(select, 'Must be done ahead');
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'Marinate',
            safetyNote: null,
            tip: null,
            prepAhead: 'required',
            ingredients: [],
          },
          {
            instruction: 'Grill',
            safetyNote: null,
            tip: null,
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('seeds an existing mark and clears it back to on the day', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[step(1, 'Make sauce', { prepAhead: 'optional' })]}
          onSubmit={onSubmit}
        />,
      );

      const select = screen.getByLabelText('Step 1 prep ahead');
      expect(select).toHaveValue('optional');
      await user.selectOptions(select, 'On the day');
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith([
          {
            instruction: 'Make sauce',
            safetyNote: null,
            tip: null,
            prepAhead: null,
            ingredients: [],
          },
        ]);
      });
    });

    it('keeps the mark attached to its step when reordering', async () => {
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Grill'),
            step(2, 'Marinate', { prepAhead: 'required' }),
          ]}
          onSubmit={vi.fn()}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Move step 2 up' }));
      expect(screen.getByLabelText('Step 1 prep ahead')).toHaveValue(
        'required',
      );
      expect(screen.getByLabelText('Step 2 prep ahead')).toHaveValue('');
    });

    it('reads an unrecognised draft value as on the day', () => {
      render(
        <MethodEditor
          initialSteps={[]}
          initialDraftSteps={[
            {
              instruction: 'From draft',
              prepAhead: 'someday' as 'optional',
            },
          ]}
          onSubmit={vi.fn()}
        />,
      );

      expect(screen.getByLabelText('Step 1 prep ahead')).toHaveValue('');
    });

    it('includes the mark in the autosave payload', async () => {
      const onStepsChange = vi.fn();
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[step(1, 'Soak beans')]}
          onSubmit={vi.fn()}
          onStepsChange={onStepsChange}
        />,
      );

      await user.selectOptions(
        screen.getByLabelText('Step 1 prep ahead'),
        'Must be done ahead',
      );

      expect(onStepsChange).toHaveBeenLastCalledWith([
        {
          key: 'existing-1',
          instruction: 'Soak beans',
          safetyNote: null,
          tip: null,
          prepAhead: 'required',
          ingredients: [],
          followsText: true,
        },
      ]);
    });
  });
  describe('step ingredients', () => {
    const BUTTER: MethodIngredient = {
      ingredientId: 1,
      name: 'Butter',
      unitName: 'g',
      total: 100,
    };
    const ONION: MethodIngredient = {
      ingredientId: 2,
      name: 'Onion',
      unitName: 'piece',
      total: 2,
    };
    const GARLIC: MethodIngredient = {
      ingredientId: 3,
      name: 'Garlic',
      unitName: 'piece',
      total: 3,
    };
    const INGREDIENTS = [BUTTER, ONION, GARLIC];

    function savedSteps(onSubmit: ReturnType<typeof vi.fn>): unknown {
      return onSubmit.mock.calls[0]?.[0];
    }

    it('fills an untouched step from its text as it is typed', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[]}
          onSubmit={onSubmit}
          recipeIngredients={INGREDIENTS}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Add step' }));
      await user.type(
        screen.getByLabelText('Step 1 text'),
        'Melt 50 g butter and add the onions',
      );

      expect(screen.getByLabelText('Step 1 Butter amount')).toHaveValue('50');
      expect(screen.getByLabelText('Step 1 Onion amount')).toHaveValue('');

      await user.click(screen.getByRole('button', { name: 'Save method' }));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect(savedSteps(onSubmit)).toEqual([
        expect.objectContaining({
          ingredients: [
            { ingredientId: 1, quantity: '50' },
            { ingredientId: 2, quantity: null },
          ],
        }),
      ]);
    });

    it('stops following the text once chips are edited, offering new mentions as suggestions', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Melt the butter', {
              ingredients: [{ ingredientId: 1, quantity: '25.000' }],
            }),
          ]}
          onSubmit={onSubmit}
          recipeIngredients={INGREDIENTS}
        />,
      );
      expect(screen.getByLabelText('Step 1 Butter amount')).toHaveValue('25');

      await user.type(screen.getByLabelText('Step 1 text'), ', add 2 onions');
      expect(screen.queryByLabelText('Step 1 Onion amount')).toBeNull();

      await user.click(
        screen.getByRole('button', { name: 'Add Onion to step 1' }),
      );
      expect(screen.getByLabelText('Step 1 Onion amount')).toHaveValue('2');

      await user.selectOptions(
        screen.getByLabelText('Add an ingredient to step 1'),
        'Garlic',
      );
      await user.click(
        screen.getByRole('button', { name: 'Remove Butter from step 1' }),
      );
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect(savedSteps(onSubmit)).toEqual([
        expect.objectContaining({
          ingredients: [
            { ingredientId: 2, quantity: '2' },
            { ingredientId: 3, quantity: null },
          ],
        }),
      ]);
    });

    it('converts a fraction amount and sends a blank one as null', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Add garlic and onion', {
              ingredients: [
                { ingredientId: 3, quantity: '1.000' },
                { ingredientId: 2, quantity: '1.000' },
              ],
            }),
          ]}
          onSubmit={onSubmit}
          recipeIngredients={INGREDIENTS}
        />,
      );

      const garlic = screen.getByLabelText('Step 1 Garlic amount');
      await user.clear(garlic);
      await user.type(garlic, '3/2');
      await user.clear(screen.getByLabelText('Step 1 Onion amount'));
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect(savedSteps(onSubmit)).toEqual([
        expect.objectContaining({
          ingredients: [
            { ingredientId: 3, quantity: '1.5' },
            { ingredientId: 2, quantity: null },
          ],
        }),
      ]);
    });

    it('blocks saving while stated amounts add up to more than the recipe total', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Melt butter', {
              ingredients: [{ ingredientId: 1, quantity: '70.000' }],
            }),
            step(2, 'More butter', {
              ingredients: [{ ingredientId: 1, quantity: '40.000' }],
            }),
          ]}
          onSubmit={onSubmit}
          recipeIngredients={INGREDIENTS}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Butter: the steps use 110 g, but the recipe has 100 g.',
      );
      await user.click(screen.getByRole('button', { name: 'Save method' }));
      expect(onSubmit).not.toHaveBeenCalled();

      const second = screen.getByLabelText('Step 2 Butter amount');
      await user.clear(second);
      await user.type(second, '30');
      expect(screen.queryByRole('alert')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Save method' }));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
    });

    it('rejects an amount that is not a number', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Add garlic', {
              ingredients: [{ ingredientId: 3, quantity: null }],
            }),
          ]}
          onSubmit={onSubmit}
          recipeIngredients={INGREDIENTS}
        />,
      );

      await user.type(screen.getByLabelText('Step 1 Garlic amount'), '1/0');
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /number or simple fraction/,
      );
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('hides and leaves out a link to an ingredient no longer on the recipe', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[
            step(1, 'Fry', {
              ingredients: [
                { ingredientId: 1, quantity: null },
                { ingredientId: 99, quantity: '5.000' },
              ],
            }),
          ]}
          onSubmit={onSubmit}
          recipeIngredients={INGREDIENTS}
        />,
      );

      const group = screen.getByRole('group', { name: 'Step 1 ingredients' });
      expect(group.querySelectorAll('input')).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Save method' }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      expect(savedSteps(onSubmit)).toEqual([
        expect.objectContaining({
          ingredients: [{ ingredientId: 1, quantity: null }],
        }),
      ]);
    });

    it('restores chips from a draft, and treats a legacy draft step as following its text', async () => {
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[]}
          initialDraftSteps={[
            {
              instruction: 'Melt the butter',
              ingredients: [{ ingredientId: 1, quantity: '10' }],
              followsText: false,
            },
            { instruction: 'Stir' },
          ]}
          onSubmit={vi.fn()}
          recipeIngredients={INGREDIENTS}
        />,
      );

      expect(screen.getByLabelText('Step 1 Butter amount')).toHaveValue('10');
      await user.type(screen.getByLabelText('Step 2 text'), ' in the garlic');
      expect(screen.getByLabelText('Step 2 Garlic amount')).toHaveValue('');
    });

    it('includes chips in the autosave payload', async () => {
      const onStepsChange = vi.fn();
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[step(1, 'Fry')]}
          onSubmit={vi.fn()}
          onStepsChange={onStepsChange}
          recipeIngredients={INGREDIENTS}
        />,
      );

      await user.selectOptions(
        screen.getByLabelText('Add an ingredient to step 1'),
        'Butter',
      );

      expect(onStepsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          ingredients: [{ ingredientId: 1, quantity: '' }],
          followsText: false,
        }),
      ]);
    });

    it('shows no ingredient controls when the recipe has no ingredients', () => {
      render(
        <MethodEditor initialSteps={[step(1, 'Fry')]} onSubmit={vi.fn()} />,
      );
      expect(
        screen.queryByRole('group', { name: 'Step 1 ingredients' }),
      ).toBeNull();
    });
  });
  // Import Review: steps can link to an ingredient proposed by the import,
  // held by key until the recipe is created.
  describe('proposed ingredients', () => {
    const OIL: MethodIngredient = {
      ingredientId: 7,
      name: 'Olive oil',
      unitName: 'ml',
      total: 30,
    };
    const PEPPER: MethodIngredient = {
      newKey: 'n1',
      name: 'Black pepper',
      unitName: 'g',
      total: 2,
    };

    it('shows and saves links to a proposed ingredient, and keeps the step key', async () => {
      const onStepsChange = vi.fn();
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[]}
          initialDraftSteps={[
            {
              key: 's1',
              instruction: 'Season the oil',
              ingredients: [{ newKey: 'n1', quantity: '1' }],
              followsText: false,
            },
          ]}
          onSubmit={vi.fn()}
          onStepsChange={onStepsChange}
          recipeIngredients={[OIL, PEPPER]}
        />,
      );

      expect(screen.getByLabelText('Step 1 Black pepper amount')).toHaveValue(
        '1',
      );
      await user.click(
        screen.getByRole('button', { name: 'Add Olive oil to step 1' }),
      );

      expect(onStepsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          key: 's1',
          ingredients: [
            { newKey: 'n1', quantity: '1' },
            { ingredientId: 7, quantity: '' },
          ],
        }),
      ]);
    });

    it('suggests a proposed ingredient from the step text', async () => {
      const user = userEvent.setup();
      render(
        <MethodEditor
          initialSteps={[]}
          onSubmit={vi.fn()}
          recipeIngredients={[OIL, PEPPER]}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Add step' }));
      await user.type(
        screen.getByLabelText('Step 1 text'),
        'Add 1 g black pepper',
      );

      expect(screen.getByLabelText('Step 1 Black pepper amount')).toHaveValue(
        '1',
      );
    });

    it('moves links to an existing ingredient when the proposed one is swapped', () => {
      const onStepsChange = vi.fn();
      const ref = createRef<MethodEditorHandle>();
      const SALT: MethodIngredient = {
        ingredientId: 9,
        name: 'Pepper',
        unitName: 'g',
        total: 2,
      };
      const { rerender } = render(
        <MethodEditor
          ref={ref}
          initialSteps={[]}
          initialDraftSteps={[
            {
              key: 's1',
              instruction: 'Season',
              ingredients: [{ newKey: 'n1', quantity: '1' }],
              followsText: false,
            },
          ]}
          onSubmit={vi.fn()}
          onStepsChange={onStepsChange}
          recipeIngredients={[OIL, PEPPER]}
        />,
      );

      rerender(
        <MethodEditor
          ref={ref}
          initialSteps={[]}
          onSubmit={vi.fn()}
          onStepsChange={onStepsChange}
          recipeIngredients={[OIL, SALT]}
        />,
      );
      act(() => {
        ref.current?.remapIngredient('n1', 9);
      });

      expect(screen.getByLabelText('Step 1 Pepper amount')).toHaveValue('1');
      expect(onStepsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({
          ingredients: [{ ingredientId: 9, quantity: '1' }],
        }),
      ]);
    });

    it('shows a note beside a step field, and can hide the save button', () => {
      render(
        <MethodEditor
          initialSteps={[]}
          initialDraftSteps={[
            {
              key: 's1',
              instruction: 'Rest',
              tip: 'Cover it',
              followsText: true,
            },
          ]}
          onSubmit={vi.fn()}
          stepNotes={new Map([['s1', { tip: <span>Estimated tip</span> }]])}
          hideSaveButton
        />,
      );

      expect(screen.getByText('Estimated tip')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Save method' }),
      ).not.toBeInTheDocument();
    });
  });
});
