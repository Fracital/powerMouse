### Build

- Whether a sandboxed document may navigate another window, and the
  SecurityError it gets when it may not, are a deferred part of the
  document bundle (`src/inject/dom/navigateOther.ts`), made at its first
  such navigation; an unsandboxed document, and a navigation of a window
  of its own, need none. Without the part the navigation throws, and a
  link to the top navigates nothing (deferred-refusals).
