import type { RecipeReferenceItem } from '@loftys-larder/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  HeaderFields,
  type HeaderFieldsProps,
  type HeaderFormValues,
} from './header-fields.tsx';

const SOURCES: RecipeReferenceItem[] = [
  { id: 11, name: 'BBC Good Food' },
  { id: 12, name: 'Mob' },
];

function blankDefaults(): HeaderFormValues {
  return {
    name: '',
    description: null,
    imageUrl: null,
    baseServings: 2,
    activeTimeMins: null,
    totalTimeMins: null,
    estimatedCostPerServing: null,
    sourceId: null,
    sourceUrl: null,
    caloriesPerServing: null,
    proteinPerServing: null,
    carbsPerServing: null,
    fatPerServing: null,
    saturatedFatPerServing: null,
    fibrePerServing: null,
    sugarPerServing: null,
    saltPerServing: null,
    isBase: false,
  };
}

type OnSubmitMock = ReturnType<
  typeof vi.fn<(values: HeaderFormValues) => Promise<boolean>>
>;

function renderHeader(overrides: Partial<HeaderFieldsProps> = {}): {
  onSubmit: OnSubmitMock;
} {
  const onSubmit: OnSubmitMock = vi
    .fn<(values: HeaderFormValues) => Promise<boolean>>()
    .mockResolvedValue(true);
  render(
    <HeaderFields
      mode="create"
      defaultValues={blankDefaults()}
      sources={SOURCES}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onSubmit };
}

describe('HeaderFields', () => {
  it('renders the existing values when given defaults', () => {
    const defaults = blankDefaults();
    defaults.name = 'Onion Bhaji';
    defaults.baseServings = 4;
    renderHeader({ mode: 'edit', defaultValues: defaults });
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      'Onion Bhaji',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Servings *').value).toBe(
      '4',
    );
  });

  it('blocks submit and surfaces an inline error when name is empty', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Save details' }));

    expect(await screen.findByText('Name is required')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the full form values on valid create submit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderHeader();

    await user.type(screen.getByLabelText('Name'), 'Tomato Soup');
    await user.clear(screen.getByLabelText('Servings *'));
    await user.type(screen.getByLabelText('Servings *'), '4');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    const submitted = onSubmit.mock.calls[0]?.[0];
    if (!submitted) throw new Error('expected one submit call');
    expect(submitted.name).toBe('Tomato Soup');
    expect(submitted.baseServings).toBe(4);
    expect(submitted.isBase).toBe(false);
  });

  it('shows the isBase checkbox only in create mode', () => {
    const { rerender } = render(
      <HeaderFields
        mode="create"
        defaultValues={blankDefaults()}
        sources={SOURCES}
        onSubmit={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText('This is a base recipe (batch-cookable)'),
    ).toBeInTheDocument();

    rerender(
      <HeaderFields
        mode="edit"
        defaultValues={blankDefaults()}
        sources={SOURCES}
        onSubmit={vi.fn()}
      />,
    );
    expect(
      screen.queryByLabelText('This is a base recipe (batch-cookable)'),
    ).not.toBeInTheDocument();
  });

  it('omits the source picker when no sources exist', () => {
    renderHeader({ sources: [] });
    expect(screen.queryByLabelText('Source')).not.toBeInTheDocument();
  });

  it('coerces a chosen source into a numeric id at submit time', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderHeader();

    await user.type(screen.getByLabelText('Name'), 'Borsch');
    await user.selectOptions(screen.getByLabelText('Source'), '12');
    await user.click(screen.getByRole('button', { name: 'Save details' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    const submitted = onSubmit.mock.calls[0]?.[0];
    if (!submitted) throw new Error('expected one submit call');
    expect(submitted.sourceId).toBe(12);
  });
});
