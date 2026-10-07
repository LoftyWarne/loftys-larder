import {
  healthScoreCandidateSchema,
  healthScoreResultSchema,
  type HealthScoreResult,
} from '../../../../shared/src/index.ts';
import { stripMarkdown } from '../model-features/plain-text.ts';

// The one gate every scorer's output passes before it's written, whichever
// adapter produced it (DEC-112). Model output is untrusted: markdown is
// stripped first (DEC-49), then the score's range and the texts' lengths are
// checked. Text that's too long is refused rather than cut, and a refusal
// here means "try again". An empty Suggestion is no Suggestion.
export function normaliseHealthScore(
  candidate: unknown,
): HealthScoreResult | null {
  const parsed = healthScoreCandidateSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const suggestion =
    parsed.data.suggestion === null
      ? ''
      : stripMarkdown(parsed.data.suggestion);
  const result = healthScoreResultSchema.safeParse({
    score: parsed.data.score,
    summary: stripMarkdown(parsed.data.summary),
    suggestion: suggestion === '' ? null : suggestion,
  });
  return result.success ? result.data : null;
}
