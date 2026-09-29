import type { RecipeMethodStep } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MethodEditor } from './method-editor.tsx';

function step(
  id: number,
  text: string,
  notes: {
    safetyNote?: string;
    tip?: string;
    prepAhead?: RecipeMethodStep['prepAhead'];
  } = {},
): RecipeMethodStep {
  return {
    id,
    stepNumber: id,
    instruction: text,
    safetyNote: notes.safetyNote ?? null,
    tip: notes.tip ?? null,
    prepAhead: notes.prepAhead ?? null,
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
      { instruction: 'Heat oil', safetyNote: null, tip: null, prepAhead: null },
      {
        instruction: 'Add onions',
        safetyNote: null,
        tip: null,
        prepAhead: null,
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
      { instruction: 'B', safetyNote: null, tip: null, prepAhead: null },
      { instruction: 'A', safetyNote: null, tip: null, prepAhead: null },
      { instruction: 'C', safetyNote: null, tip: null, prepAhead: null },
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
        { instruction: 'B', safetyNote: null, tip: null, prepAhead: null },
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
          { instruction: 'Fry', safetyNote: null, tip: null, prepAhead: null },
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
          { instruction: 'B', safetyNote: null, tip: 'B tip', prepAhead: null },
          { instruction: 'A', safetyNote: null, tip: null, prepAhead: null },
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
        { instruction: 'Fry', safetyNote: null, tip: 'X', prepAhead: null },
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
          },
          {
            instruction: 'Grill',
            safetyNote: null,
            tip: null,
            prepAhead: null,
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
          instruction: 'Soak beans',
          safetyNote: null,
          tip: null,
          prepAhead: 'required',
        },
      ]);
    });
  });
});
