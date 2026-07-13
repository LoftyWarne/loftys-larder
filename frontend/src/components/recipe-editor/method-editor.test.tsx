import type { RecipeMethodStep } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MethodEditor } from './method-editor.tsx';

function step(id: number, text: string): RecipeMethodStep {
  return { id, stepNumber: id, instruction: text };
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
      { instruction: 'Heat oil' },
      { instruction: 'Add onions' },
    ]);
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
      { instruction: 'B' },
      { instruction: 'A' },
      { instruction: 'C' },
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
      expect(onSubmit).toHaveBeenCalledWith([{ instruction: 'B' }]);
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
      expect(onSubmit).toHaveBeenCalledWith([{ instruction: 'Heat oil' }]);
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
});
