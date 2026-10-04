export interface ReaderNotesProps {
  notes: readonly string[];
}

// What the reader flagged about the input, e.g. a method that seems to carry
// on elsewhere. Shown at the top of Import Review and never saved (DEC-108).
export function ReaderNotes({
  notes,
}: ReaderNotesProps): React.ReactElement | null {
  if (notes.length === 0) return null;
  return (
    <section
      aria-labelledby="import-notes-heading"
      className="rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900"
    >
      <h2 id="import-notes-heading" className="font-semibold">
        Notes from the import
      </h2>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}
