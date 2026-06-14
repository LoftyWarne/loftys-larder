import {
  RECIPE_COMMENT_MAX_LENGTH,
  type RecipeComment,
} from '@loftys-larder/shared';
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useSession } from '@/lib/auth-client.ts';
import { trpc } from '@/lib/trpc.ts';

export interface RecipeCommentsProps {
  recipeId: number;
}

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/London',
});

export function RecipeComments({
  recipeId,
}: RecipeCommentsProps): React.ReactElement {
  const session = useSession();
  const viewerUserId = session.data?.user.id ?? null;
  const utils = trpc.useUtils();

  const query = trpc.recipes.listComments.useQuery({ recipeId });

  const invalidateList = async (): Promise<void> => {
    await utils.recipes.listComments.invalidate({ recipeId });
  };

  const addMutation = trpc.recipes.addComment.useMutation({
    onSettled: invalidateList,
  });
  const editMutation = trpc.recipes.editComment.useMutation({
    onSettled: invalidateList,
  });
  const deleteMutation = trpc.recipes.deleteComment.useMutation({
    onSettled: invalidateList,
  });

  return (
    <section className="space-y-3" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="text-xl font-semibold">
        Comments
      </h2>

      <Composer
        disabled={addMutation.isPending}
        onSubmit={(comment) => {
          addMutation.mutate({ recipeId, comment });
        }}
      />

      {query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading comments…
        </p>
      ) : query.error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load comments: {query.error.message}
        </p>
      ) : query.data && query.data.items.length > 0 ? (
        <ul className="space-y-4">
          {query.data.items.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              isAuthor={
                viewerUserId !== null && comment.userId === viewerUserId
              }
              isEditing={editMutation.isPending}
              isDeleting={deleteMutation.isPending}
              onSaveEdit={(text) => {
                editMutation.mutate({ id: comment.id, comment: text });
              }}
              onConfirmDelete={() => {
                deleteMutation.mutate({ id: comment.id });
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      )}
    </section>
  );
}

interface ComposerProps {
  disabled: boolean;
  onSubmit: (comment: string) => void;
}

function Composer({ disabled, onSubmit }: ComposerProps): React.ReactElement {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const overLimit = text.length > RECIPE_COMMENT_MAX_LENGTH;
  const canSubmit = !disabled && trimmed.length > 0 && !overLimit;

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit(trimmed);
        setText('');
      }}
    >
      <label htmlFor="comment-composer" className="sr-only">
        Add a comment
      </label>
      <textarea
        id="comment-composer"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        disabled={disabled}
        rows={3}
        placeholder="Add a comment…"
        className="w-full rounded-md border border-input bg-background p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <div className="flex items-center justify-between">
        <span
          className={
            overLimit
              ? 'text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {String(text.length)} / {String(RECIPE_COMMENT_MAX_LENGTH)}
        </span>
        <Button type="submit" disabled={!canSubmit} size="sm">
          Post
        </Button>
      </div>
    </form>
  );
}

interface CommentRowProps {
  comment: RecipeComment;
  isAuthor: boolean;
  isEditing: boolean;
  isDeleting: boolean;
  onSaveEdit: (text: string) => void;
  onConfirmDelete: () => void;
}

function CommentRow({
  comment,
  isAuthor,
  isEditing,
  isDeleting,
  onSaveEdit,
  onConfirmDelete,
}: CommentRowProps): React.ReactElement {
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(comment.comment);
  const trimmed = draft.trim();
  const overLimit = draft.length > RECIPE_COMMENT_MAX_LENGTH;
  const canSave =
    !isEditing &&
    trimmed.length > 0 &&
    !overLimit &&
    trimmed !== comment.comment;

  const displayName = comment.authorName ?? '[deleted user]';

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{displayName}</span>
        <span>· {TIMESTAMP_FORMAT.format(new Date(comment.createdAt))}</span>
        {comment.lastUpdatedAt !== null && (
          <span aria-label="edited">· (edited)</span>
        )}
      </div>

      {editOpen ? (
        <div className="space-y-2">
          <label htmlFor={`edit-${String(comment.id)}`} className="sr-only">
            Edit comment
          </label>
          <textarea
            id={`edit-${String(comment.id)}`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            disabled={isEditing}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-2">
            <span
              className={
                overLimit
                  ? 'mr-auto text-xs text-destructive'
                  : 'mr-auto text-xs text-muted-foreground'
              }
            >
              {String(draft.length)} / {String(RECIPE_COMMENT_MAX_LENGTH)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(comment.comment);
                setEditOpen(false);
              }}
              disabled={isEditing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => {
                onSaveEdit(trimmed);
                setEditOpen(false);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm">{comment.comment}</p>
      )}

      {isAuthor && !editOpen && (
        <div className="flex gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(comment.comment);
              setEditOpen(true);
            }}
            disabled={isEditing || isDeleting}
          >
            Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isEditing || isDeleting}
              >
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
                <AlertDialogDescription>
                  This can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    onConfirmDelete();
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </li>
  );
}
