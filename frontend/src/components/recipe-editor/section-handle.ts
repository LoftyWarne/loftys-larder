// Imperative handle the editor page uses to flush a section from the overall
// "Save & Finish" button. Each section form already validates and saves on its
// own submit; `submit` runs that same path and resolves `true` when the
// section is saved (or had nothing to save) and `false` when validation failed
// or the save was rejected, so the page can gate navigation on every section
// succeeding.
export interface RecipeSectionHandle {
  submit: () => Promise<boolean>;
}
