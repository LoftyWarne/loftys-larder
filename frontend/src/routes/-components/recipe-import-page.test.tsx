import type { RecipeImportDraftSummary } from '@loftys-larder/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  startMutateAsyncMock,
  startUseMutationMock,
  listUseQueryMock,
  listInvalidateMock,
  discardMutateAsyncMock,
  navigateMock,
} = vi.hoisted(() => ({
  startMutateAsyncMock: vi.fn(),
  startUseMutationMock: vi.fn(),
  listUseQueryMock: vi.fn(),
  listInvalidateMock: vi.fn(),
  discardMutateAsyncMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipeImports: { list: { invalidate: listInvalidateMock } },
    }),
    recipeImports: {
      start: { useMutation: startUseMutationMock },
      list: { useQuery: listUseQueryMock },
      discard: {
        useMutation: () => ({ mutateAsync: discardMutateAsyncMock }),
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
    useNavigate: () => navigateMock,
  };
});

import { RecipeImportPage } from './recipe-import-page.tsx';

const RECIPE_TEXT = 'Weeknight Pasta\n2 tbsp olive oil';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

function domainError(code: string): TRPCClientError<never> {
  const error = new TRPCClientError<never>('Rejected');
  Object.assign(error, { shape: { data: { cause: { code } } } });
  return error;
}

const IMPORTS: RecipeImportDraftSummary[] = [
  {
    id: 42,
    name: 'Lemon Tart',
    inputKind: 'text',
    lastUpdatedAt: Date.UTC(2026, 9, 4, 13, 30),
  },
  {
    id: 41,
    name: null,
    inputKind: null,
    lastUpdatedAt: Date.UTC(2026, 9, 3, 9, 0),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  setOnline(true);
  startUseMutationMock.mockReturnValue({
    mutateAsync: startMutateAsyncMock,
    isPending: false,
  });
  listUseQueryMock.mockReturnValue({ data: [], error: null });
  listInvalidateMock.mockResolvedValue(undefined);
  navigateMock.mockResolvedValue(undefined);
  discardMutateAsyncMock.mockResolvedValue({ deleted: true });
});

afterEach(() => {
  setOnline(true);
});

async function pasteAndImport(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByLabelText('Recipe text'));
  await user.paste(RECIPE_TEXT);
  await user.click(screen.getByRole('button', { name: 'Import' }));
}

describe('RecipeImportPage', () => {
  it('imports pasted text and opens Import Review', async () => {
    startMutateAsyncMock.mockResolvedValue({ kind: 'draft', draftId: 43 });
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await pasteAndImport(user);

    expect(startMutateAsyncMock).toHaveBeenCalledWith({
      input: { kind: 'text', text: RECIPE_TEXT },
    });
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/recipes/import/$draftId',
        params: { draftId: '43' },
      });
    });
  });

  it('shows a working state while the import runs', () => {
    startUseMutationMock.mockReturnValue({
      mutateAsync: startMutateAsyncMock,
      isPending: true,
    });
    render(<RecipeImportPage />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Reading the recipe… This can take up to a minute.',
    );
    expect(screen.getByLabelText('Recipe text')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('lists several recipes, and picking one continues with the same text', async () => {
    startMutateAsyncMock
      .mockResolvedValueOnce({
        kind: 'several',
        names: ['Lemon Tart', 'Shortcrust Pastry'],
      })
      .mockResolvedValueOnce({ kind: 'draft', draftId: 44 });
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await pasteAndImport(user);
    await user.click(
      await screen.findByRole('button', { name: 'Shortcrust Pastry' }),
    );

    expect(startMutateAsyncMock).toHaveBeenLastCalledWith({
      input: { kind: 'text', text: RECIPE_TEXT },
      pick: 'Shortcrust Pastry',
    });
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/recipes/import/$draftId',
        params: { draftId: '44' },
      });
    });
  });

  it('says when it couldn’t find a recipe, keeping the text', async () => {
    startMutateAsyncMock.mockRejectedValue(domainError('IMPORT_NOT_A_RECIPE'));
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await pasteAndImport(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t find a recipe in that.',
    );
    expect(screen.getByLabelText('Recipe text')).toHaveValue(RECIPE_TEXT);
  });

  it('says to try again after a timeout or provider failure, keeping the text', async () => {
    startMutateAsyncMock.mockRejectedValue(domainError('IMPORT_TRY_AGAIN'));
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await pasteAndImport(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The import didn’t work. Try again.',
    );
    expect(screen.getByLabelText('Recipe text')).toHaveValue(RECIPE_TEXT);
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('says when the import limit is reached', async () => {
    startMutateAsyncMock.mockRejectedValue(domainError('IMPORT_RATE_LIMITED'));
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await pasteAndImport(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You’ve reached the import limit. Try again in an hour.',
    );
  });

  it('disables Import while offline', async () => {
    const user = userEvent.setup();
    render(<RecipeImportPage />);
    await user.click(screen.getByLabelText('Recipe text'));
    await user.paste(RECIPE_TEXT);
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(
      screen.getByText('You’re offline. Importing needs a connection.'),
    ).toBeInTheDocument();
  });

  it('lists imports in progress, newest first, to resume', () => {
    listUseQueryMock.mockReturnValue({ data: IMPORTS, error: null });
    render(<RecipeImportPage />);

    const list = within(
      screen.getByRole('region', { name: 'Imports in progress' }),
    ).getAllByRole('listitem');
    expect(list.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Lemon Tart',
      'Untitled import',
    ]);
    expect(
      screen.getByRole('link', { name: 'Resume Lemon Tart' }),
    ).toHaveAttribute('href', '/recipes/import/42');
    expect(list[0]).toHaveTextContent('Last changed 4 Oct 2026, 14:30');
  });

  it('discards an import in progress after confirmation', async () => {
    listUseQueryMock.mockReturnValue({ data: IMPORTS, error: null });
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await user.click(
      screen.getByRole('button', { name: 'Discard Lemon Tart' }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Discard import' }),
    );

    await waitFor(() => {
      expect(discardMutateAsyncMock).toHaveBeenCalledWith({ draftId: 42 });
    });
    expect(listInvalidateMock).toHaveBeenCalled();
  });

  it('shows no list when nothing is in progress', () => {
    render(<RecipeImportPage />);

    expect(
      screen.queryByRole('region', { name: 'Imports in progress' }),
    ).not.toBeInTheDocument();
  });
});
