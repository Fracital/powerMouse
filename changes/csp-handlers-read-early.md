### Fixes

- A handler's property read before any policy of the page's governed code
  (`el.onclick` before a meta a script inserts) now compiles it, so it runs
  whatever policy comes, as in Chrome; the getters are hooked per name as
  the first attribute of that name comes, about 2 KB in a frame that has
  a handler attribute. (csp-meta-scripts)
- A javascript: URL of statements that the starting document's policy
  refuses no longer leaves its `let`, `const` or `class` declared and
  uninitialized in the window. (csp-meta-scripts)
- A javascript: URL that runs before its check's own task (a frame's, a
  form's) fires its violation events and reports before its code, as in
  Chrome.
- A violation in a new window a link opened prints in that window's
  console, not the opener's.
