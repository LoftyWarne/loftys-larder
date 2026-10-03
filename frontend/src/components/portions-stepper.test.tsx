import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PortionsStepper } from './portions-stepper.tsx';

function renderStepper(servings: number) {
  const onStep = vi.fn();
  const onReset = vi.fn();
  render(
    <PortionsStepper
      servings={servings}
      baseServings={2}
      max={50}
      onStep={onStep}
      onReset={onReset}
    />,
  );
  return { onStep, onReset };
}

describe('PortionsStepper', () => {
  it('reports a step per click, so a double-click steps twice', async () => {
    const user = userEvent.setup();
    const { onStep } = renderStepper(2);

    await user.dblClick(screen.getByRole('button', { name: 'More servings' }));
    await user.click(screen.getByRole('button', { name: 'Fewer servings' }));

    expect(onStep.mock.calls).toEqual([[1], [1], [-1]]);
  });

  it("keeps the reset control in place but hidden and inert at the recipe's own servings", () => {
    renderStepper(2);

    const reset = screen.getByText('Reset to 2');
    expect(reset).toHaveAttribute('aria-hidden', 'true');
    expect(reset).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reset to 2' })).toBeNull();
  });

  it('enables the reset control once scaled', async () => {
    const user = userEvent.setup();
    const { onReset } = renderStepper(3);

    await user.click(screen.getByRole('button', { name: 'Reset to 2' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('stops at one serving and at the maximum', () => {
    renderStepper(1);
    expect(
      screen.getByRole('button', { name: 'Fewer servings' }),
    ).toBeDisabled();
  });
});
