// A Radix Dialog opened by an interaction (rather than mounted `open` at the
// initial render) schedules React state updates from three places that all fire
// in the gaps between userEvent's simulated sub-events — on requestAnimationFrame,
// on document event listeners, and on microtasks — where no `act()` scope is
// active: react-hook-form's `useForm` mount, Radix's FocusScope / Presence /
// DismissableLayer, and the combobox's blur (focus moving into the dialog
// re-fires its create action). React 19 flags each as "An update to … was not
// wrapped in act(…)". The updates are benign — the assertions still pass — but
// they cannot be awaited away, because they land mid-interaction.
//
// Silence only that one message for the duration of `run`, then restore
// `console.error`. Scoping it to the dialog interaction keeps genuine act
// violations elsewhere visible.
export async function suppressActNoise<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) {
      return;
    }
    original(...args);
  };
  try {
    return await run();
  } finally {
    console.error = original;
  }
}
