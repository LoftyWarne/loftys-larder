import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button.tsx';

// While the Plan Proposal is being made, and if it fails.
export interface ProposalStatusProps {
  error: string | null;
  offline?: boolean;
  onRetry: () => void;
  onBack: () => void;
}

export function ProposalStatus({
  error,
  offline = false,
  onRetry,
  onBack,
}: ProposalStatusProps): React.ReactElement {
  if (error === null) {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-3 rounded-lg border p-8 text-center"
      >
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p className="font-medium">Planning your meals…</p>
        <p className="text-sm text-muted-foreground">
          This can take up to a minute.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
      {offline && (
        <p className="text-sm text-muted-foreground">
          You’re offline. Planning with AI needs a connection.
        </p>
      )}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onRetry} disabled={offline}>
          Try again
        </Button>
      </div>
    </div>
  );
}
