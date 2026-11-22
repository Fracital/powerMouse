### Demo and API

- Preserve the original history entry and its top-level address token when a
  classic frame reports its Back or Forward destination before the navigation
  method resolves. The entry being left and the destination index are saved
  before the asynchronous step, so callbacks cannot overwrite a neighboring
  history entry. Distinct Back/Forward entries that happen to share the
  exact same URL now clear their traversal marker after a completed step,
  instead of overwriting the entry with the next unrelated navigation. A
  deterministic browser regression covers both event orders and this case.
