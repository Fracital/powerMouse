### Fixes

- A cookieStore change listener hears a document's document.cookie writes
  made together in one task as natively: an event for each write, in the
  order written. Two deletes were reported in the jar's order, a delete
  before the set made ahead of it, and a cookie set and deleted, or set
  twice, in one task as one change or none (cookie-store-order suite,
  compared with native Chrome).
