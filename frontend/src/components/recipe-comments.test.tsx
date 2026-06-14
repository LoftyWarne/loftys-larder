import type { RecipeComment } from '@loftys-larder/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMutateMock, editMutateMock, deleteMutateMock, invalidateListMock } =
  vi.hoisted(() => ({
    addMutateMock: vi.fn(),
    editMutateMock: vi.fn(),
    deleteMutateMock: vi.fn(),
    invalidateListMock: vi.fn().mockResolvedValue(undefined),
  }));

let listData: { items: RecipeComment[] } | undefined;
let listError: { message: string } | null = null;
let listLoading = false;
let addPending = false;
let editPending = false;
let deletePending = false;

vi.mock('@/lib/auth-client.ts', () => ({
  useSession: vi.fn(),
}));

import { useSession } from '@/lib/auth-client.ts';

const useSessionMock = useSession as unknown as ReturnType<typeof vi.fn>;

vi.mock('@/lib/trpc.ts', () => ({
  trpc: {
    useUtils: () => ({
      recipes: {
        listComments: {
          invalidate: invalidateListMock,
        },
      },
    }),
    recipes: {
      listComments: {
        useQuery: () => ({
          data: listData,
          error: listError,
          isLoading: listLoading,
        }),
      },
      addComment: {
        useMutation: () => ({
          mutate: addMutateMock,
          isPending: addPending,
        }),
      },
      editComment: {
        useMutation: () => ({
          mutate: editMutateMock,
          isPending: editPending,
        }),
      },
      deleteComment: {
        useMutation: () => ({
          mutate: deleteMutateMock,
          isPending: deletePending,
        }),
      },
    },
  },
}));

import { RecipeComments } from './recipe-comments.tsx';

const VIEWER_ID = 'viewer-user';
const OTHER_ID = 'other-user';

function makeComment(overrides: Partial<RecipeComment> = {}): RecipeComment {
  return {
    id: 1,
    recipeId: 7,
    userId: VIEWER_ID,
    authorName: 'Viewer',
    comment: 'a comment',
    createdAt: '2026-06-14T12:00:00.000Z',
    lastUpdatedAt: null,
    ...overrides,
  };
}

function setSession(userId: string | null): void {
  useSessionMock.mockReturnValue(
    userId === null ? { data: null } : { data: { user: { id: userId } } },
  );
}

beforeEach(() => {
  addMutateMock.mockReset();
  editMutateMock.mockReset();
  deleteMutateMock.mockReset();
  invalidateListMock.mockClear();
  useSessionMock.mockReset();
  setSession(VIEWER_ID);
  listData = { items: [] };
  listError = null;
  listLoading = false;
  addPending = false;
  editPending = false;
  deletePending = false;
});

describe('RecipeComments', () => {
  it('renders the empty state when there are no comments', () => {
    listData = { items: [] };
    render(<RecipeComments recipeId={7} />);
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });

  it('renders comments newest-first in the order returned by the server', () => {
    listData = {
      items: [
        makeComment({
          id: 3,
          comment: 'third',
          createdAt: '2026-06-14T12:00:00.000Z',
        }),
        makeComment({
          id: 2,
          comment: 'second',
          userId: OTHER_ID,
          authorName: 'Other',
          createdAt: '2026-06-14T11:00:00.000Z',
        }),
        makeComment({
          id: 1,
          comment: 'first',
          createdAt: '2026-06-14T10:00:00.000Z',
        }),
      ],
    };
    render(<RecipeComments recipeId={7} />);
    const items = screen.getAllByRole('listitem');
    expect(
      items.map(
        (el) => within(el).getByText(/^(first|second|third)$/).textContent,
      ),
    ).toEqual(['third', 'second', 'first']);
  });

  it('shows [deleted user] when authorName is null', () => {
    listData = {
      items: [
        makeComment({ userId: null, authorName: null, comment: 'orphan' }),
      ],
    };
    render(<RecipeComments recipeId={7} />);
    expect(screen.getByText('[deleted user]')).toBeInTheDocument();
  });

  it('shows "(edited)" only when lastUpdatedAt is non-null', () => {
    listData = {
      items: [
        makeComment({
          id: 1,
          comment: 'never edited',
          lastUpdatedAt: null,
        }),
        makeComment({
          id: 2,
          comment: 'has been edited',
          lastUpdatedAt: '2026-06-14T13:00:00.000Z',
        }),
      ],
    };
    render(<RecipeComments recipeId={7} />);
    const editedHints = screen.getAllByLabelText('edited');
    expect(editedHints).toHaveLength(1);
  });

  it('composer submits trimmed text via addComment.mutate', async () => {
    const user = userEvent.setup();
    render(<RecipeComments recipeId={7} />);
    await user.type(screen.getByLabelText(/add a comment/i), '  hello world  ');
    await user.click(screen.getByRole('button', { name: /post/i }));
    expect(addMutateMock).toHaveBeenCalledWith({
      recipeId: 7,
      comment: 'hello world',
    });
  });

  it('Post button is disabled when text is empty or whitespace-only', async () => {
    const user = userEvent.setup();
    render(<RecipeComments recipeId={7} />);
    const post = screen.getByRole('button', { name: /post/i });
    expect(post).toBeDisabled();
    await user.type(screen.getByLabelText(/add a comment/i), '   ');
    expect(post).toBeDisabled();
  });

  it('Post button is disabled when text exceeds the max length', async () => {
    const user = userEvent.setup();
    render(<RecipeComments recipeId={7} />);
    await user.type(screen.getByLabelText(/add a comment/i), 'a'.repeat(2001));
    expect(screen.getByRole('button', { name: /post/i })).toBeDisabled();
  });

  it('renders Edit + Delete only on the viewer-authored comments', () => {
    listData = {
      items: [
        makeComment({ id: 1, comment: 'mine', userId: VIEWER_ID }),
        makeComment({
          id: 2,
          comment: 'theirs',
          userId: OTHER_ID,
          authorName: 'Other',
        }),
      ],
    };
    render(<RecipeComments recipeId={7} />);
    const rows = screen.getAllByRole('listitem');
    const mine = rows[0];
    const theirs = rows[1];
    if (!mine || !theirs) throw new Error('expected two rows');
    expect(
      within(mine).getByRole('button', { name: /edit/i }),
    ).toBeInTheDocument();
    expect(
      within(mine).getByRole('button', { name: /delete/i }),
    ).toBeInTheDocument();
    expect(within(theirs).queryByRole('button', { name: /edit/i })).toBeNull();
    expect(
      within(theirs).queryByRole('button', { name: /delete/i }),
    ).toBeNull();
  });

  it('edit flow swaps in a textarea and saves the updated text via editComment.mutate', async () => {
    const user = userEvent.setup();
    listData = {
      items: [makeComment({ id: 9, comment: 'before' })],
    };
    render(<RecipeComments recipeId={7} />);
    await user.click(screen.getByRole('button', { name: /edit/i }));
    const editArea = screen.getByLabelText(/edit comment/i);
    await user.clear(editArea);
    await user.type(editArea, 'after');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(editMutateMock).toHaveBeenCalledWith({ id: 9, comment: 'after' });
  });

  it('delete confirmation: clicking Delete in the dialog calls deleteComment.mutate', async () => {
    const user = userEvent.setup();
    listData = {
      items: [makeComment({ id: 9, comment: 'to delete' })],
    };
    render(<RecipeComments recipeId={7} />);
    await user.click(screen.getByRole('button', { name: /delete/i }));
    // AlertDialog "Delete" action button is rendered into a portal.
    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);
    expect(deleteMutateMock).toHaveBeenCalledWith({ id: 9 });
  });

  it('delete confirmation: Cancel does NOT call deleteComment.mutate', async () => {
    const user = userEvent.setup();
    listData = {
      items: [makeComment({ id: 9, comment: 'keep' })],
    };
    render(<RecipeComments recipeId={7} />);
    await user.click(screen.getByRole('button', { name: /delete/i }));
    const cancel = await screen.findByRole('button', { name: /cancel/i });
    await user.click(cancel);
    expect(deleteMutateMock).not.toHaveBeenCalled();
  });

  it('comment body is React-escaped (no element injection from HTML-ish text)', () => {
    listData = {
      items: [
        makeComment({
          id: 9,
          comment: '<script>alert(1)</script>',
        }),
      ],
    };
    const { container } = render(<RecipeComments recipeId={7} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
  });

  it('no Edit / Delete affordances render when there is no session yet', () => {
    setSession(null);
    listData = {
      items: [makeComment({ id: 1, comment: 'mine', userId: VIEWER_ID })],
    };
    render(<RecipeComments recipeId={7} />);
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});
