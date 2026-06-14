export function formatAverageRating(average: number | null): string | null {
  if (average === null) return null;
  return average.toFixed(1);
}
