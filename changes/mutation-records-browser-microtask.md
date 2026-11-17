### Fixes

- A MutationObserver whose records were on the browser's queue when a
  hooked write took them (an attribute the page set natively, then an
  `src` it set through the hooks) is notified in the browser's own
  mutation observer microtask, before a promise the page queued after the
  first record, as natively. The inject handed them back from a microtask
  of its own, queued after that promise.
