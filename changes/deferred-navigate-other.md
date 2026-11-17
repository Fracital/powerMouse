### Build

- A document's navigation of a window other than its own (an opener, a
  frame, a named window: Chrome's refusals, framebusting and the initiator
  checks) is a deferred part of the document bundle
  (`src/inject/dom/navigateOther.ts`), made at its first such navigation.
  Without the part the navigation throws and navigates nothing
  (deferred-refusals).
