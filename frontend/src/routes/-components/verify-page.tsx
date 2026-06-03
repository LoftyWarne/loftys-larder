import { redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { Button } from '@/components/ui/button.tsx';

export const verifySearchSchema = z.object({
  error: z.string().optional(),
});

export type VerifySearch = z.infer<typeof verifySearchSchema>;

export function verifyBeforeLoad({ search }: { search: VerifySearch }): void {
  if (!search.error) {
    throw redirect({ to: '/' });
  }
}

interface FailureCopy {
  heading: string;
  body: string;
}

export function copyForError(code: string): FailureCopy {
  switch (code) {
    case 'EXPIRED_TOKEN':
      return {
        heading: 'This link has expired',
        body: 'Sign-in links are valid for 10 minutes. Request a new one to continue.',
      };
    case 'INVALID_TOKEN':
      return {
        heading: 'This link is no longer valid',
        body: 'The link may have already been used or was modified. Request a new one to sign in.',
      };
    default:
      return {
        heading: 'We could not sign you in',
        body: 'Something went wrong completing your sign-in. Please request a new link.',
      };
  }
}

export function VerifyView({
  error,
}: {
  error: string | undefined;
}): React.ReactElement {
  const copy = copyForError(error ?? '');

  return (
    <section className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold">{copy.heading}</h1>
      <p role="alert">{copy.body}</p>
      <Button asChild>
        <a href="/sign-in">Back to sign in</a>
      </Button>
    </section>
  );
}
