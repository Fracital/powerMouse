### Fixes

- A javascript: URL a form submits, a frame's `src` a script sets or a new
  window's first URL is judged as its navigation starts by the policies of
  the document that started it, at that code, as Chrome judges it; it was
  judged only by the window it ran in. A frame's `src` set to a javascript:
  URL through its property ran the code twice; it runs once. A second
  javascript: navigation of the same window, started before the first
  ran, is no longer let through unjudged. (csp-meta-scripts, wpt-csp)
- A javascript: URL of statements that declares a `let` or a `const` runs
  when Chrome runs it, not a task later. (csp-meta-scripts)
- Under `require-trusted-types-for 'script'`, a javascript: URL's code goes
  to the page's default policy as it runs (`Location href`), as in Chrome,
  and the code it returns runs; with no policy, or null, the navigation is
  refused with Chrome's console message. A clicked link's never reached
  the policy. (csp-meta-scripts)
