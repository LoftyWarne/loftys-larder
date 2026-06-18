import { Button } from '@/components/ui/button.tsx';

export interface PairSwitchButtonProps {
  // Whether the current (active) recipe is a batch version — used to frame
  // the destination in the label ("Switch to full" vs "Switch to batch").
  currentIsBatchVersion: boolean;
  pairedRecipeName: string;
  disabled?: boolean;
  onClick: () => void;
}

export function PairSwitchButton({
  currentIsBatchVersion,
  pairedRecipeName,
  disabled,
  onClick,
}: PairSwitchButtonProps): React.ReactElement {
  const label = currentIsBatchVersion
    ? 'Switch to full version'
    : 'Switch to batch version';
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      data-testid="pair-switch-button"
      aria-label={`${label} (${pairedRecipeName})`}
      className="self-start"
    >
      {label}
    </Button>
  );
}
