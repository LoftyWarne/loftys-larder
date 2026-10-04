import {
  RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMPORT_IMAGE_FOLDER,
  RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE,
  type RecipeImportDraftSummary,
  type RecipeImportImageUploadCredentials,
} from '@loftys-larder/shared';
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
  credentialsRefetchMock,
} = vi.hoisted(() => ({
  startMutateAsyncMock: vi.fn(),
  startUseMutationMock: vi.fn(),
  listUseQueryMock: vi.fn(),
  listInvalidateMock: vi.fn(),
  discardMutateAsyncMock: vi.fn(),
  navigateMock: vi.fn(),
  credentialsRefetchMock: vi.fn(),
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
    uploads: {
      getRecipeImportImageCredentials: {
        useQuery: () => ({ refetch: credentialsRefetchMock }),
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

const CREDENTIALS: RecipeImportImageUploadCredentials = {
  cloudName: 'test-cloud',
  apiKey: 'test-key',
  timestamp: 1_700_000_000,
  signature: '0123456789abcdef0123456789abcdef01234567',
  folder: RECIPE_IMPORT_IMAGE_FOLDER,
  allowedFormats: [...RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS],
  maxFileSize: RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE,
  transformation: RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION,
};

const PAGE_1 = new File(['one'], 'page-1.heic', { type: 'image/heic' });
const PAGE_2 = new File(['two'], 'page-2.jpg', { type: 'image/jpeg' });

// Answers each Cloudinary upload with a public id named after the file.
function mockCloudinary() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    const file = (init?.body as FormData).get('file') as File;
    const id = file.name.replace(/\..*$/, '');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          secure_url: `https://res.cloudinary.com/test-cloud/${id}.jpg`,
          public_id: `loftys-larder/imports/${id}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });
}

async function chooseImagesAndImport(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Photos' }));
  await user.upload(screen.getByLabelText('Choose images to import'), [
    PAGE_1,
    PAGE_2,
  ]);
  await user.click(screen.getByRole('button', { name: 'Import' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  credentialsRefetchMock.mockResolvedValue({ data: CREDENTIALS });
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

  it('says when trying again won’t help, keeping the text', async () => {
    startMutateAsyncMock.mockRejectedValue(
      domainError('IMPORT_REQUEST_REJECTED'),
    );
    const user = userEvent.setup();
    render(<RecipeImportPage />);

    await pasteAndImport(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Importing isn’t working at the moment, and trying again won’t help. The problem has been reported.',
    );
    expect(screen.getByLabelText('Recipe text')).toHaveValue(RECIPE_TEXT);
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

  describe('from images', () => {
    it('uploads the images to Cloudinary, then imports them in page order', async () => {
      const fetchSpy = mockCloudinary();
      startMutateAsyncMock.mockResolvedValue({ kind: 'draft', draftId: 45 });
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await chooseImagesAndImport(user);

      await waitFor(() => {
        expect(startMutateAsyncMock).toHaveBeenCalledWith({
          input: {
            kind: 'images',
            publicIds: [
              'loftys-larder/imports/page-1',
              'loftys-larder/imports/page-2',
            ],
          },
        });
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(
        'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
      );
      expect((init?.body as FormData).get('folder')).toBe(
        'loftys-larder/imports',
      );
      await waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: '/recipes/import/$draftId',
          params: { draftId: '45' },
        });
      });
    });

    it('shows that the images are uploading', async () => {
      vi.spyOn(globalThis, 'fetch').mockReturnValue(
        new Promise<Response>(() => undefined),
      );
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await chooseImagesAndImport(user);

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Uploading the images…',
      );
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    });

    it('picks one of several recipes from the same images without uploading them again', async () => {
      const fetchSpy = mockCloudinary();
      startMutateAsyncMock
        .mockResolvedValueOnce({
          kind: 'several',
          names: ['Lemon Tart', 'Shortcrust Pastry'],
        })
        .mockResolvedValueOnce({ kind: 'draft', draftId: 46 });
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await chooseImagesAndImport(user);
      expect(
        await screen.findByRole('heading', {
          name: 'Those images have more than one recipe. Which one?',
        }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Lemon Tart' }));

      expect(startMutateAsyncMock).toHaveBeenLastCalledWith({
        input: {
          kind: 'images',
          publicIds: [
            'loftys-larder/imports/page-1',
            'loftys-larder/imports/page-2',
          ],
        },
        pick: 'Lemon Tart',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps the images after a failed import, and tries again without uploading them again', async () => {
      const fetchSpy = mockCloudinary();
      startMutateAsyncMock
        .mockRejectedValueOnce(domainError('IMPORT_NOT_A_RECIPE'))
        .mockResolvedValueOnce({ kind: 'draft', draftId: 47 });
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await chooseImagesAndImport(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t find a recipe in that.',
      );
      expect(
        within(
          screen.getByRole('list', { name: 'Chosen images' }),
        ).getAllByRole('listitem'),
      ).toHaveLength(2);

      await user.click(screen.getByRole('button', { name: 'Import' }));

      await waitFor(() => {
        expect(startMutateAsyncMock).toHaveBeenCalledTimes(2);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('says when the upload fails, keeping the images and starting nothing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Server error', { status: 500 }),
      );
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await chooseImagesAndImport(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t upload the images. Try again.',
      );
      expect(startMutateAsyncMock).not.toHaveBeenCalled();
      expect(screen.getByText('page-1.heic')).toBeInTheDocument();
    });

    it('disables Import until an image is chosen, and while offline', async () => {
      const user = userEvent.setup();
      render(<RecipeImportPage />);
      await user.click(screen.getByRole('button', { name: 'Photos' }));
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

      await user.upload(screen.getByLabelText('Choose images to import'), [
        PAGE_1,
      ]);
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

      act(() => {
        setOnline(false);
        window.dispatchEvent(new Event('offline'));
      });
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    });
  });

  it('shows no list when nothing is in progress', () => {
    render(<RecipeImportPage />);

    expect(
      screen.queryByRole('region', { name: 'Imports in progress' }),
    ).not.toBeInTheDocument();
  });
});
