import type {
  CreateRecipeFromImportInput,
  IngredientListItem,
  RecipeImportProposal,
} from '@loftys-larder/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { importDraft, PROPOSAL } from '@/test/recipe-import-fixtures.ts';

const {
  getUseQueryMock,
  discardMutateAsyncMock,
  createMutateAsyncMock,
  upsertMutateMock,
  ingredientsListFetchMock,
  navigateMock,
} = vi.hoisted(() => ({
  getUseQueryMock: vi.fn(),
  discardMutateAsyncMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  upsertMutateMock: vi.fn(),
  ingredientsListFetchMock: vi.fn(),
  navigateMock: vi.fn(),
}));

const INGREDIENTS: IngredientListItem[] = [
  {
    id: 7,
    name: 'Olive oil',
    categoryId: 1,
    categoryName: 'Pantry',
    defaultUnitId: 2,
    defaultUnitName: 'ml',
    isPlant: false,
    averageShelfLifeDays: null,
  },
  {
    id: 9,
    name: 'Pepper',
    categoryId: 3,
    categoryName: 'Spices',
    defaultUnitId: 1,
    defaultUnitName: 'g',
    isPlant: true,
    averageShelfLifeDays: null,
  },
];

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      ingredients: {
        list: {
          fetch: ingredientsListFetchMock,
          invalidate: vi.fn().mockResolvedValue(undefined),
        },
      },
      recipes: {
        list: { invalidate: vi.fn().mockResolvedValue(undefined) },
        references: { invalidate: vi.fn().mockResolvedValue(undefined) },
        listTags: {
          fetch: vi.fn().mockResolvedValue([{ id: 1, name: 'Weeknight' }]),
          invalidate: vi.fn().mockResolvedValue(undefined),
        },
      },
      recipeImports: {
        list: { invalidate: vi.fn().mockResolvedValue(undefined) },
      },
    }),
    recipeImports: {
      get: { useQuery: getUseQueryMock },
      discard: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: discardMutateAsyncMock,
        }),
      },
      createRecipe: {
        useMutation: () => ({ mutateAsync: createMutateAsyncMock }),
      },
    },
    recipeDrafts: {
      upsert: { useMutation: () => ({ mutate: upsertMutateMock }) },
    },
    ingredients: {
      list: { useQuery: () => ({ data: INGREDIENTS }) },
      references: {
        useQuery: () => ({
          data: {
            categories: [
              { id: 1, name: 'Pantry' },
              { id: 3, name: 'Spices' },
            ],
            units: [
              { id: 1, name: 'g' },
              { id: 2, name: 'ml' },
            ],
          },
        }),
      },
    },
    recipes: {
      references: {
        useQuery: () => ({
          data: {
            units: [],
            prepTypes: [{ id: 4, name: 'chopped' }],
            sources: [{ id: 5, name: 'The Pasta Book' }],
          },
        }),
      },
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children: React.ReactNode;
      to: string;
      params?: Record<string, string>;
      [key: string]: unknown;
    }) => {
      const path = params
        ? to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? '')
        : to;
      return (
        <a href={path} {...rest}>
          {children}
        </a>
      );
    },
    useParams: () => ({ draftId: '41' }),
    useNavigate: () => navigateMock,
  };
});

import { RecipeImportReviewPage } from './recipe-import-review-page.tsx';

function domainError(cause: Record<string, unknown>): TRPCClientError<never> {
  const error = new TRPCClientError<never>('Rejected');
  Object.assign(error, { shape: { data: { cause } } });
  return error;
}

function lastCreateInput(): CreateRecipeFromImportInput {
  const call = createMutateAsyncMock.mock.lastCall as
    | [CreateRecipeFromImportInput]
    | undefined;
  if (!call) throw new Error('createRecipe was not called');
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  getUseQueryMock.mockReturnValue({ data: importDraft(), error: null });
  createMutateAsyncMock.mockResolvedValue({ recipeId: 77 });
  discardMutateAsyncMock.mockResolvedValue({ deleted: true });
  navigateMock.mockResolvedValue(undefined);
  ingredientsListFetchMock.mockResolvedValue(INGREDIENTS);
});

describe('RecipeImportReviewPage', () => {
  it('shows the reader’s notes and the pasted text', () => {
    render(<RecipeImportReviewPage />);

    expect(
      screen.getByRole('heading', { name: 'Notes from the import' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The method may continue on another page.'),
    ).toBeInTheDocument();
    // At phone width the original folds away above the proposal.
    const original = screen.getByText('Original text').closest('details');
    expect(original).toHaveTextContent(
      'Weeknight Pasta 2 tbsp olive oil Black pepper to taste',
    );
  });

  it('shows an image import’s images alongside the proposal, each of which can be enlarged', async () => {
    const proposal: RecipeImportProposal = {
      ...PROPOSAL,
      input: {
        kind: 'images',
        publicIds: ['loftys-larder/imports/p1', 'loftys-larder/imports/p2'],
      },
    };
    getUseQueryMock.mockReturnValue({
      data: {
        ...importDraft(),
        proposal,
        images: [
          { url: 'https://img.test/p1' },
          { url: 'https://img.test/p2' },
        ],
        draftData: { version: 1, fields: { proposal } },
      },
      error: null,
    });
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    await user.click(screen.getByText('Original images'));
    const original = screen.getByText('Original images').closest('details');
    if (!original) throw new Error('no original');
    expect(
      within(original)
        .getAllByRole('img')
        .map((img) => [img.getAttribute('alt'), img.getAttribute('src')]),
    ).toEqual([
      ['Page 1 of 2', 'https://img.test/p1'],
      ['Page 2 of 2', 'https://img.test/p2'],
    ]);

    await user.click(
      within(original).getByRole('button', { name: 'Enlarge page 2 of 2' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Page 2 of 2' });
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      'https://img.test/p2',
    );
    expect(
      within(dialog).getByRole('link', { name: 'Open full size' }),
    ).toHaveAttribute('href', 'https://img.test/p2');

    await user.click(
      within(dialog).getByRole('button', { name: 'Previous page' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Page 1 of 2' }),
    ).toBeInTheDocument();
  });

  function renderLinkImport(url: string): void {
    const proposal: RecipeImportProposal = {
      ...PROPOSAL,
      input: { kind: 'link', url },
    };
    getUseQueryMock.mockReturnValue({
      data: {
        ...importDraft(),
        proposal,
        draftData: { version: 1, fields: { proposal } },
      },
      error: null,
    });
    render(<RecipeImportReviewPage />);
  }

  it('shows a link import’s page alongside the proposal, opening in a new tab', () => {
    renderLinkImport('https://recipes.example/pasta');

    const original = screen.getByText('Original page').closest('details');
    if (!original) throw new Error('no original');
    const link = within(original).getByRole('link', {
      name: 'https://recipes.example/pasta (opens in a new tab)',
    });
    expect(link).toHaveAttribute('href', 'https://recipes.example/pasta');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows a link that isn’t https as text only', () => {
    renderLinkImport('javascript:alert(1)');

    const original = screen.getByText('Original page').closest('details');
    if (!original) throw new Error('no original');
    expect(within(original).queryByRole('link')).not.toBeInTheDocument();
    expect(original).toHaveTextContent('javascript:alert(1)');
  });

  it('fills every section with the editor’s own controls', () => {
    render(<RecipeImportReviewPage />);

    expect(screen.getByLabelText('Name')).toHaveValue('Weeknight Pasta');
    expect(screen.getByLabelText(/^Servings/)).toHaveValue(2);
    expect(screen.getByLabelText('Ingredient for row 1')).toHaveValue(
      'Olive oil',
    );
    expect(screen.getByLabelText('Quantity for row 1')).toHaveValue('30');
    expect(screen.getByLabelText('Step 1 text')).toHaveValue(
      'Warm the oil and season with pepper.',
    );
    expect(
      within(screen.getByRole('list', { name: 'Recipe tags' })).getByText(
        'Weeknight',
      ),
    ).toBeInTheDocument();
    // Nothing saves per section in Import Review.
    expect(
      screen.queryByRole('button', { name: 'Save ingredients' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('This is a base recipe (batch-cookable)'),
    ).not.toBeInTheDocument();
  });

  it('shows each row’s original line beneath it', () => {
    render(<RecipeImportReviewPage />);

    expect(screen.getByText('2 tbsp olive oil')).toBeInTheDocument();
    expect(screen.getByText('Black pepper to taste')).toBeInTheDocument();
  });

  it('marks Estimates, wording converted and nominal quantities differently', () => {
    render(<RecipeImportReviewPage />);

    expect(
      screen.getByLabelText('Quantity for row 1'),
    ).toHaveAccessibleDescription('Converted — check the amount');
    expect(
      screen.getByLabelText('Quantity for row 2'),
    ).toHaveAccessibleDescription('Not in the original — amount guessed');
    expect(screen.getByLabelText(/^Servings/)).toHaveAccessibleDescription(
      'Estimated',
    );
    expect(
      screen.getByLabelText('Calories (kcal)'),
    ).toHaveAccessibleDescription('Estimated');
  });

  it('clears a mark when its field is edited, and autosaves the rest with the proposal', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    const quantity = screen.getByLabelText('Quantity for row 1');
    await user.clear(quantity);
    await user.type(quantity, '45');

    expect(
      screen.queryByText('Converted — check the amount'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Not in the original — amount guessed'),
    ).toBeInTheDocument();

    await waitFor(
      () => {
        expect(upsertMutateMock).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
    const [input] = upsertMutateMock.mock.lastCall as [
      {
        draftId: number;
        recipeId: null;
        draftData: { fields: Record<string, unknown> };
      },
    ];
    expect(input.draftId).toBe(41);
    expect(input.recipeId).toBeNull();
    expect(input.draftData.fields.proposal).toEqual(PROPOSAL);
    expect(input.draftData.fields.estimates).toEqual(
      PROPOSAL.estimates.filter(
        (mark) => mark.path !== 'ingredient:i1.quantity',
      ),
    );
  });

  it('shows a proposed new ingredient as new, editable in place', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    const name = screen.getByLabelText('New ingredient name for row 2');
    expect(name).toHaveValue('Black pepper');
    expect(
      screen.getByLabelText('Category for the new ingredient in row 2'),
    ).toHaveValue('3');
    expect(
      screen.getByLabelText('Unit for the new ingredient in row 2'),
    ).toHaveValue('1');

    await user.clear(name);
    await user.type(name, 'Cracked pepper');
    await user.selectOptions(
      screen.getByLabelText('Unit for the new ingredient in row 2'),
      'ml',
    );

    // Step chips follow the proposed ingredient's name and unit.
    const chips = screen.getByRole('group', { name: 'Step 1 ingredients' });
    expect(within(chips).getByText('Cracked pepper')).toBeInTheDocument();
    expect(within(chips).getAllByText('ml')).toHaveLength(2);
  });

  it('includes proposed ingredients in the step chips', () => {
    render(<RecipeImportReviewPage />);

    const chips = screen.getByRole('group', { name: 'Step 1 ingredients' });
    expect(within(chips).getByText('Olive oil')).toBeInTheDocument();
    expect(within(chips).getByText('Black pepper')).toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 Black pepper amount')).toHaveValue(
      '1',
    );
  });

  it('switches a proposed ingredient to an existing one, moving its step links', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    await user.click(
      screen.getByLabelText('Use an existing ingredient for row 2'),
    );
    await user.click(await screen.findByRole('option', { name: 'Pepper' }));

    expect(screen.getByLabelText('Ingredient for row 2')).toHaveValue('Pepper');
    expect(
      screen.queryByLabelText('New ingredient name for row 2'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 Pepper amount')).toHaveValue('1');

    await user.click(screen.getByRole('button', { name: 'Create recipe' }));
    await waitFor(() => {
      expect(createMutateAsyncMock).toHaveBeenCalled();
    });
    const input = lastCreateInput();
    expect(input.lines[1]?.ingredient).toEqual({ id: 9, unitId: 1 });
    expect(input.newIngredients).toEqual([]);
    expect(input.steps[0]?.ingredients).toEqual([
      { ingredient: { id: 7 }, quantity: null },
      { ingredient: { id: 9 }, quantity: '1' },
    ]);
  });

  it('proposes a new ingredient for a name that isn’t in the list', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    await user.click(screen.getByRole('button', { name: 'Add ingredient' }));
    await user.type(screen.getByLabelText('Ingredient for row 3'), 'Basil');
    await user.click(
      await screen.findByRole('option', { name: 'New ingredient “Basil”' }),
    );

    expect(screen.getByLabelText('New ingredient name for row 3')).toHaveValue(
      'Basil',
    );
    expect(
      screen.getByLabelText('Category for the new ingredient in row 3'),
    ).toHaveValue('');
  });

  it('blocks Create recipe until a proposed ingredient has a category and unit', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    await user.selectOptions(
      screen.getByLabelText('Category for the new ingredient in row 2'),
      'Choose…',
    );
    await user.click(screen.getByRole('button', { name: 'Create recipe' }));

    expect(await screen.findByText('Choose a category')).toBeInTheDocument();
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('shows a proposed new source as new, and can switch it to an existing one', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    expect(screen.getByLabelText('Source')).toHaveValue('Pasta Weekly');
    expect(
      screen.getByText('Added to your sources when you create the recipe.'),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText('Use an existing source'));
    await user.click(
      await screen.findByRole('option', { name: 'The Pasta Book' }),
    );

    expect(screen.getByLabelText('Source')).toHaveValue('The Pasta Book');

    await user.click(screen.getByRole('button', { name: 'Create recipe' }));
    await waitFor(() => {
      expect(createMutateAsyncMock).toHaveBeenCalled();
    });
    expect(lastCreateInput().source).toEqual({ id: 5 });
  });

  it('creates the recipe from the reviewed sections and opens it', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Pasta for two');
    await user.click(screen.getByRole('button', { name: 'Create recipe' }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/recipes/$recipeId',
        params: { recipeId: '77' },
      });
    });
    const input = lastCreateInput();
    expect(input.draftId).toBe(41);
    expect(input.header.name).toBe('Pasta for two');
    expect(input.source).toEqual({ newName: 'Pasta Weekly' });
    expect(input.newIngredients.map((ingredient) => ingredient.key)).toEqual([
      'n1',
    ]);
    expect(input.tagNames).toEqual(['Weeknight']);
    expect(input.header.nutritionIsEstimated).toBe(true);
  });

  it('drops the nutrition label once the cook unticks Estimated', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    const estimated = screen.getByRole('checkbox', { name: 'Estimated' });
    expect(estimated).toBeChecked();
    await user.click(estimated);

    expect(estimated).not.toBeChecked();
    expect(
      screen.getByLabelText('Calories (kcal)'),
    ).not.toHaveAccessibleDescription('Estimated');

    await user.click(screen.getByRole('button', { name: 'Create recipe' }));
    await waitFor(() => {
      expect(createMutateAsyncMock).toHaveBeenCalled();
    });
    expect(lastCreateInput().header.nutritionIsEstimated).toBe(false);
  });

  it('drops the nutrition label once every nutrition value is edited', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    const calories = screen.getByLabelText('Calories (kcal)');
    await user.clear(calories);
    await user.type(calories, '450');

    expect(
      screen.getByRole('checkbox', { name: 'Estimated' }),
    ).not.toBeChecked();
  });

  it('shows a name already taken on the row concerned', async () => {
    createMutateAsyncMock.mockRejectedValue(
      domainError({ code: 'INGREDIENT_NAME_TAKEN', newKey: 'n1' }),
    );
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    await user.click(screen.getByRole('button', { name: 'Create recipe' }));

    expect(
      await screen.findByText(
        'You already have an ingredient with this name. Rename it, or use the existing one.',
      ),
    ).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('resumes from the sections saved so far', () => {
    getUseQueryMock.mockReturnValue({
      data: importDraft({
        header: { name: 'Pasta for two' },
        estimates: [{ path: 'ingredient:i2.quantity', kind: 'nominal' }],
        newSource: null,
      }),
      error: null,
    });
    render(<RecipeImportReviewPage />);

    expect(screen.getByLabelText('Name')).toHaveValue('Pasta for two');
    expect(
      screen.queryByText('Converted — check the amount'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Not in the original — amount guessed'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Source')).toHaveValue('');
  });

  it('asks before discarding, then deletes the import', async () => {
    const user = userEvent.setup();
    render(<RecipeImportReviewPage />);

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Discard this import?' }),
    ).toBeInTheDocument();
    expect(discardMutateAsyncMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Discard import' }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ to: '/recipes/import' });
    });
    expect(discardMutateAsyncMock).toHaveBeenCalledWith({ draftId: 41 });
  });

  it('says so when the import has gone', () => {
    const error = new TRPCClientError<never>('Import not found');
    Object.assign(error, { data: { code: 'NOT_FOUND' } });
    getUseQueryMock.mockReturnValue({ data: undefined, error });
    render(<RecipeImportReviewPage />);

    expect(
      screen.getByRole('heading', { name: 'Import not found' }),
    ).toBeInTheDocument();
  });
});
