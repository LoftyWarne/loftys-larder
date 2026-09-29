import { highlightStep } from '@/lib/step-highlights.ts';

interface StepInstructionProps {
  text: string;
  ingredientNames: readonly string[];
  unitNames: readonly string[];
}

export function StepInstruction({
  text,
  ingredientNames,
  unitNames,
}: StepInstructionProps): React.ReactElement {
  const segments = highlightStep(text, { ingredientNames, unitNames });
  return (
    <>
      {segments.map((segment, index) =>
        segment.bold ? (
          <strong key={index} className="font-semibold">
            {segment.text}
          </strong>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
