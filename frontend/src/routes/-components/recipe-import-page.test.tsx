import {
  RECIPE_IMPORT_IMAGE_ALLOWED_FORMATS,
  RECIPE_IMPORT_IMAGE_EAGER_TRANSFORMATION,
  RECIPE_IMPORT_IMAGE_FOLDER,
  RECIPE_IMPORT_IMAGE_MAX_FILE_SIZE,
  RECIPE_IMPORT_PDF_MAX_FILE_SIZE,
  type RecipeImportDraftSummary,
  type RecipeImportImageUploadCredentials,
  type RecipeImportPdfUploadCredentials,
} from '@loftys-larder/shared';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
  pdfCredentialsRefetchMock,
} = vi.hoisted(() => ({
  startMutateAsyncMock: vi.fn(),
  startUseMutationMock: vi.fn(),
  listUseQueryMock: vi.fn(),
  listInvalidateMock: vi.fn(),
  discardMutateAsyncMock: vi.fn(),
  navigateMock: vi.fn(),
  credentialsRefetchMock: vi.fn(),
  pdfCredentialsRefetchMock: vi.fn(),
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
      getRecipeImportPdfCredentials: {
        useQuery: () => ({ refetch: pdfCredentialsRefetchMock }),
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

function domainError(
  code: string,
  metadata: Record<string, unknown> = {},
): TRPCClientError<never> {
  const error = new TRPCClientError<never>('Rejected');
  Object.assign(error, { shape: { data: { cause: { code, ...metadata } } } });
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

const PDF_CREDENTIALS: RecipeImportPdfUploadCredentials = {
  cloudName: 'test-cloud',
  apiKey: 'test-key',
  timestamp: 1_700_000_000,
  signature: 'abcdef0123456789abcdef0123456789abcdef01',
  folder: RECIPE_IMPORT_IMAGE_FOLDER,
  allowedFormats: ['pdf'],
  maxFileSize: RECIPE_IMPORT_PDF_MAX_FILE_SIZE,
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
  pdfCredentialsRefetchMock.mockResolvedValue({ data: PDF_CREDENTIALS });
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

  describe('from a link', () => {
    const LINK = 'https://recipes.example/lemon-tart';

    async function enterLinkAndImport(
      user: ReturnType<typeof userEvent.setup>,
      link = LINK,
    ): Promise<void> {
      await user.click(screen.getByRole('button', { name: 'Link' }));
      await user.click(screen.getByLabelText('Recipe link'));
      await user.paste(link);
      await user.click(screen.getByRole('button', { name: 'Import' }));
    }

    it('imports the link and opens Import Review', async () => {
      startMutateAsyncMock.mockResolvedValue({ kind: 'draft', draftId: 45 });
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await enterLinkAndImport(user, `  ${LINK} `);

      expect(startMutateAsyncMock).toHaveBeenCalledWith({
        input: { kind: 'link', url: LINK },
      });
      await waitFor(() => {
        expect(navigateMock).toHaveBeenCalledWith({
          to: '/recipes/import/$draftId',
          params: { draftId: '45' },
        });
      });
    });

    it('takes a link typed without https:// as https', async () => {
      startMutateAsyncMock.mockResolvedValue({ kind: 'draft', draftId: 46 });
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await enterLinkAndImport(user, 'recipes.example/lemon-tart');

      expect(startMutateAsyncMock).toHaveBeenCalledWith({
        input: { kind: 'link', url: LINK },
      });
    });

    it('says when what was typed isn’t a link, without importing', async () => {
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await enterLinkAndImport(user, 'lemon tart recipe');

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'That doesn’t look like a web link.',
      );
      expect(startMutateAsyncMock).not.toHaveBeenCalled();
    });

    it('lists several recipes on the page, and picking one continues with the same link', async () => {
      startMutateAsyncMock
        .mockResolvedValueOnce({
          kind: 'several',
          names: ['Lemon Tart', 'Shortcrust Pastry'],
        })
        .mockResolvedValueOnce({ kind: 'draft', draftId: 47 });
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await enterLinkAndImport(user);

      expect(
        await screen.findByRole('heading', {
          name: 'That page has more than one recipe. Which one?',
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Back to the link' }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Lemon Tart' }));
      expect(startMutateAsyncMock).toHaveBeenLastCalledWith({
        input: { kind: 'link', url: LINK },
        pick: 'Lemon Tart',
      });
    });

    it.each([
      [
        'IMPORT_LINK_NOT_ALLOWED',
        'That link can’t be imported. Use an https link to a public recipe page.',
      ],
      [
        'IMPORT_LINK_UNREADABLE',
        'Couldn’t read that page. Paste the text or a screenshot instead.',
      ],
      [
        'IMPORT_NOT_A_RECIPE',
        'Couldn’t find a recipe in that. If the page has one, paste the text or a screenshot instead.',
      ],
    ])('explains %s, keeping the link', async (code, message) => {
      startMutateAsyncMock.mockRejectedValue(domainError(code));
      const user = userEvent.setup();
      render(<RecipeImportPage />);

      await enterLinkAndImport(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByLabelText('Recipe link')).toHaveValue(LINK);
    });

    it('disables Import until a link is entered, and while offline', async () => {
      const user = userEvent.setup();
      render(<RecipeImportPage />);
      await user.click(screen.getByRole('button', { name: 'Link' }));
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

      await user.click(screen.getByLabelText('Recipe link'));
      await user.paste(LINK);
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

      act(() => {
        setOnline(false);
        window.dispatchEvent(new Event('offline'));
      });
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    });
  });

  describe('from a document', () => {
    const SAVED_PAGE =
      '<!DOCTYPE html><html><head><script type="application/ld+json">{"@type":"Recipe"}</script><script>track()</script></head><body><p>Lemon Tart</p></body></html>';
    const PRUNED_PAGE =
      '<!DOCTYPE html><html><head><script type="application/ld+json">{"@type":"Recipe"}</script></head><body><p>Lemon Tart</p></body></html>';

    async function chooseDocument(
      user: ReturnType<typeof userEvent.setup>,
      file: File,
    ): Promise<void> {
      await user.click(screen.getByRole('button', { name: 'Document' }));
      await user.upload(screen.getByLabelText('Choose a document to import'), [
        file,
      ]);
    }

    function documentUser() {
      return userEvent.setup({ applyAccept: false });
    }

    it('opens a text file in a box headed with its name, and imports what the cook leaves as pasted text', async () => {
      startMutateAsyncMock.mockResolvedValue({ kind: 'draft', draftId: 48 });
      const user = documentUser();
      render(<RecipeImportPage />);

      await chooseDocument(
        user,
        new File([`${RECIPE_TEXT}\r\nA story about pasta.`], 'pasta.md'),
      );

      const box = await screen.findByLabelText('From pasta.md');
      expect(box).toHaveValue(`${RECIPE_TEXT}\nA story about pasta.`);
      expect(screen.getByText(/^Text file ·/)).toBeInTheDocument();
      await user.clear(box);
      await user.type(box, 'Weeknight Pasta');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(startMutateAsyncMock).toHaveBeenCalledWith({
        input: { kind: 'text', text: 'Weeknight Pasta' },
      });
    });

    it('loads only the start of a long text file, and says so', async () => {
      const user = documentUser();
      render(<RecipeImportPage />);

      await chooseDocument(
        user,
        new File(['a'.repeat(20_500)], 'long.txt', { type: 'text/plain' }),
      );

      expect(await screen.findByLabelText('From long.txt')).toHaveValue(
        'a'.repeat(20_000),
      );
      expect(
        screen.getByText(
          'Only the first 20,000 characters were loaded. Trim it to the recipe.',
        ),
      ).toBeInTheDocument();
    });

    it('imports a saved web page as its pruned markup, keeping it for a pick', async () => {
      startMutateAsyncMock
        .mockResolvedValueOnce({
          kind: 'several',
          names: ['Lemon Tart', 'Shortcrust Pastry'],
        })
        .mockResolvedValueOnce({ kind: 'draft', draftId: 49 });
      const user = documentUser();
      render(<RecipeImportPage />);

      await chooseDocument(
        user,
        new File([SAVED_PAGE], 'Lemon tart.html', { type: 'text/html' }),
      );
      expect(await screen.findByText(/^Saved web page ·/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^From /)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Import' }));

      const input = {
        kind: 'html',
        fileName: 'Lemon tart.html',
        html: PRUNED_PAGE,
      };
      expect(startMutateAsyncMock).toHaveBeenCalledWith({ input });
      expect(
        await screen.findByRole('heading', {
          name: 'That page has more than one recipe. Which one?',
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Back to the document' }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Lemon Tart' }));
      expect(startMutateAsyncMock).toHaveBeenLastCalledWith({
        input,
        pick: 'Lemon Tart',
      });
    });

    it('suggests pasting the text when a saved page has no recipe', async () => {
      startMutateAsyncMock.mockRejectedValue(
        domainError('IMPORT_NOT_A_RECIPE'),
      );
      const user = documentUser();
      render(<RecipeImportPage />);

      await chooseDocument(
        user,
        new File([SAVED_PAGE], 'tart.htm', { type: 'text/html' }),
      );
      await screen.findByText(/^Saved web page ·/);
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t find a recipe in that. If the page has one, paste the text or a screenshot instead.',
      );
    });

    it.each([
      [
        'a file it can’t import',
        new File(['PK'], 'tart.docx', { type: 'application/msword' }),
        'That file can’t be imported. Use a PDF, text, Markdown or web page (.html) file.',
      ],
      [
        'a password-protected PDF',
        new File(
          ['%PDF-1.7\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF'],
          'tart.pdf',
          { type: 'application/pdf' },
        ),
        'That PDF is password-protected. Save an unlocked copy, or screenshot the recipe.',
      ],
      [
        'a PDF over 10 MB',
        (() => {
          const big = new File(['%PDF'], 'tart.pdf');
          Object.defineProperty(big, 'size', { value: 10_485_761 });
          return big;
        })(),
        'That file is too big to import.',
      ],
      [
        'a file over 10 MB',
        (() => {
          const big = new File(['x'], 'tart.txt');
          Object.defineProperty(big, 'size', { value: 10_485_761 });
          return big;
        })(),
        'That file is too big to import.',
      ],
      [
        'a page still too big once pruned',
        new File(
          [`<html><body><p>${'a'.repeat(750_000)}</p></body></html>`],
          'huge.html',
        ),
        'That page is too big to import. Paste the recipe’s text instead.',
      ],
    ])('refuses %s', async (_label, file, message) => {
      const user = documentUser();
      render(<RecipeImportPage />);

      await chooseDocument(user, file);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    });

    describe('a PDF', () => {
      function pdf(name = 'Lemon tart.pdf'): File {
        return new File(
          [
            '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF',
          ],
          name,
          { type: 'application/pdf' },
        );
      }

      async function choosePdfAndImport(
        user: ReturnType<typeof userEvent.setup>,
        file = pdf(),
      ): Promise<void> {
        await chooseDocument(user, file);
        await screen.findByText(/^PDF ·/);
        await user.click(screen.getByRole('button', { name: 'Import' }));
      }

      it('uploads the PDF to Cloudinary with its own credential, then imports it', async () => {
        const fetchSpy = mockCloudinary();
        startMutateAsyncMock.mockResolvedValue({ kind: 'draft', draftId: 50 });
        const user = documentUser();
        render(<RecipeImportPage />);

        await choosePdfAndImport(user);

        await waitFor(() => {
          expect(startMutateAsyncMock).toHaveBeenCalledWith({
            input: {
              kind: 'pdf',
              publicId: 'loftys-larder/imports/Lemon tart',
            },
          });
        });
        expect(pdfCredentialsRefetchMock).toHaveBeenCalledTimes(1);
        expect(credentialsRefetchMock).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] ?? [];
        expect(url).toBe(
          'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
        );
        const body = init?.body as FormData;
        expect(body.get('folder')).toBe('loftys-larder/imports');
        expect(body.get('allowed_formats')).toBe('pdf');
        expect(body.get('signature')).toBe(PDF_CREDENTIALS.signature);
        expect(body.has('eager')).toBe(false);
        expect((body.get('file') as File).name).toBe('Lemon tart.pdf');
        await waitFor(() => {
          expect(navigateMock).toHaveBeenCalledWith({
            to: '/recipes/import/$draftId',
            params: { draftId: '50' },
          });
        });
      });

      it('shows that the PDF is uploading', async () => {
        vi.spyOn(globalThis, 'fetch').mockReturnValue(
          new Promise<Response>(() => undefined),
        );
        const user = documentUser();
        render(<RecipeImportPage />);

        await choosePdfAndImport(user);

        expect(await screen.findByRole('status')).toHaveTextContent(
          'Uploading the PDF…',
        );
        expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
      });

      it('picks one of several recipes from the same PDF without uploading it again', async () => {
        const fetchSpy = mockCloudinary();
        startMutateAsyncMock
          .mockResolvedValueOnce({
            kind: 'several',
            names: ['Lemon Tart', 'Shortcrust Pastry'],
          })
          .mockResolvedValueOnce({ kind: 'draft', draftId: 51 });
        const user = documentUser();
        render(<RecipeImportPage />);

        await choosePdfAndImport(user);
        expect(
          await screen.findByRole('heading', {
            name: 'That PDF has more than one recipe. Which one?',
          }),
        ).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Lemon Tart' }));

        expect(startMutateAsyncMock).toHaveBeenLastCalledWith({
          input: { kind: 'pdf', publicId: 'loftys-larder/imports/Lemon tart' },
          pick: 'Lemon Tart',
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it('tries again without uploading the PDF again, until another is chosen', async () => {
        const fetchSpy = mockCloudinary();
        startMutateAsyncMock.mockRejectedValue(domainError('IMPORT_TRY_AGAIN'));
        const user = documentUser();
        render(<RecipeImportPage />);

        await choosePdfAndImport(user);
        expect(await screen.findByRole('alert')).toHaveTextContent(
          'The import didn’t work. Try again.',
        );
        await user.click(screen.getByRole('button', { name: 'Import' }));
        await waitFor(() => {
          expect(startMutateAsyncMock).toHaveBeenCalledTimes(2);
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await choosePdfAndImport(user, pdf('Other tart.pdf'));
        await waitFor(() => {
          expect(startMutateAsyncMock).toHaveBeenLastCalledWith({
            input: {
              kind: 'pdf',
              publicId: 'loftys-larder/imports/Other tart',
            },
          });
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      });

      it('names the page count of a PDF that is too long', async () => {
        mockCloudinary();
        startMutateAsyncMock.mockRejectedValue(
          domainError('IMPORT_DOCUMENT_TOO_LONG', {
            pageCount: 12,
            maxPages: 8,
          }),
        );
        const user = documentUser();
        render(<RecipeImportPage />);

        await choosePdfAndImport(user);

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'That PDF has 12 pages; the most is 8. Save just the recipe’s pages as a PDF, or screenshot them.',
        );
      });

      it('says when the upload fails, keeping the PDF and starting nothing', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('Server error', { status: 500 }),
        );
        const user = documentUser();
        render(<RecipeImportPage />);

        await choosePdfAndImport(user);

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Couldn’t upload the PDF. Try again.',
        );
        expect(startMutateAsyncMock).not.toHaveBeenCalled();
        expect(screen.getByText('Lemon tart.pdf')).toBeInTheDocument();
      });
    });

    it('removes the file, and disables Import until there is one, and while offline', async () => {
      const user = documentUser();
      render(<RecipeImportPage />);
      await user.click(screen.getByRole('button', { name: 'Document' }));
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

      await user.upload(screen.getByLabelText('Choose a document to import'), [
        new File([RECIPE_TEXT], 'pasta.txt'),
      ]);
      await screen.findByLabelText('From pasta.txt');
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

      act(() => {
        setOnline(false);
        window.dispatchEvent(new Event('offline'));
      });
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

      act(() => {
        setOnline(true);
        window.dispatchEvent(new Event('online'));
      });
      await user.click(
        screen.getByRole('button', { name: 'Remove pasta.txt' }),
      );
      expect(screen.queryByLabelText('From pasta.txt')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    });
  });

  describe('dropping files', () => {
    function dragFiles(
      type: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop',
      files: File[] = [],
    ) {
      fireEvent[type](window, {
        dataTransfer: { types: ['Files'], files, dropEffect: 'none' },
      });
    }

    function drop(files: File[]): void {
      dragFiles('dragEnter', files);
      dragFiles('drop', files);
    }

    function pressed(): string | undefined {
      return (
        within(screen.getByRole('group', { name: 'Import from' }))
          .getAllByRole('button')
          .find((button) => button.getAttribute('aria-pressed') === 'true')
          ?.textContent ?? undefined
      );
    }

    it('shows where to drop while files are dragged over the page', () => {
      render(<RecipeImportPage />);
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();

      dragFiles('dragEnter');
      expect(screen.getByText('Drop to import')).toBeInTheDocument();
      dragFiles('dragLeave');
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
    });

    it('ignores a drag that carries no files', () => {
      render(<RecipeImportPage />);
      fireEvent.dragEnter(window, {
        dataTransfer: { types: ['text/plain'], files: [] },
      });
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
    });

    it('keeps a dropped file from the browser', () => {
      render(<RecipeImportPage />);
      const event = new Event('drop', { cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [] },
      });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('switches to Document mode for a dropped document', async () => {
      render(<RecipeImportPage />);
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Link' }));

      drop([new File([RECIPE_TEXT], 'pasta.md')]);

      expect(await screen.findByLabelText('From pasta.md')).toHaveValue(
        RECIPE_TEXT,
      );
      expect(pressed()).toBe('Document');
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
    });

    it('switches to Photos for dropped images, adding them to the ones picked', async () => {
      const user = userEvent.setup();
      render(<RecipeImportPage />);
      await user.click(screen.getByRole('button', { name: 'Photos' }));
      await user.upload(screen.getByLabelText('Choose images to import'), [
        PAGE_1,
      ]);
      await user.click(screen.getByRole('button', { name: 'Link' }));

      drop([PAGE_2, new File(['x'], 'notes.gif', { type: 'image/gif' })]);

      expect(pressed()).toBe('Photos');
      const chosen = within(
        screen.getByRole('list', { name: 'Chosen images' }),
      ).getAllByRole('listitem');
      expect(
        chosen.map((item) => item.querySelector('p')?.textContent),
      ).toEqual(['page-1.heic', 'page-2.jpg']);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'notes.gif isn’t a JPG, PNG, WebP or HEIC image.',
      );
    });

    it.each([
      ['two documents', [new File(['a'], 'a.md'), new File(['b'], 'b.txt')]],
      ['a document with images', [new File(['a'], 'a.html'), PAGE_1]],
    ])('refuses %s, staying where it was', (_label, files) => {
      render(<RecipeImportPage />);

      drop(files);

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Drop one document, or up to 8 photos.',
      );
      expect(pressed()).toBe('Paste text');
    });

    it('refuses one file it can’t import', () => {
      render(<RecipeImportPage />);

      drop([new File(['x'], 'tart.docx')]);

      expect(screen.getByRole('alert')).toHaveTextContent(
        'That file can’t be imported. Use a PDF, text, Markdown or web page (.html) file.',
      );
      expect(pressed()).toBe('Paste text');
    });

    it('takes no drop while offline', () => {
      render(<RecipeImportPage />);
      act(() => {
        setOnline(false);
        window.dispatchEvent(new Event('offline'));
      });

      dragFiles('dragEnter');
      expect(screen.queryByText('Drop to import')).not.toBeInTheDocument();
      drop([PAGE_1]);

      expect(pressed()).toBe('Paste text');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('takes no drop while an import runs', () => {
      startUseMutationMock.mockReturnValue({
        mutateAsync: startMutateAsyncMock,
        isPending: true,
      });
      render(<RecipeImportPage />);

      drop([PAGE_1]);

      expect(pressed()).toBe('Paste text');
    });
  });

  it('shows no list when nothing is in progress', () => {
    render(<RecipeImportPage />);

    expect(
      screen.queryByRole('region', { name: 'Imports in progress' }),
    ).not.toBeInTheDocument();
  });
});
