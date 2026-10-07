import {
  HealthScoringContext,
  useHealthScoringQueue,
} from '@/hooks/use-health-scoring.ts';

export function HealthScoringProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const scoring = useHealthScoringQueue();
  return (
    <HealthScoringContext.Provider value={scoring}>
      {children}
    </HealthScoringContext.Provider>
  );
}
