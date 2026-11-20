### Performance

- Back and Forward in a tab of the demo after another tab added entries
  show the document from the HTTP cache too, as natively. The controller
  takes such a step with `location.replace` (the browser's traversal would
  move the other tab), which the worker saw as a new navigation: CNN was
  fetched and rewritten again (responseStart 104 ms vs 40 from the cache).
  The controller now tells its worker before it takes the step, and the
  load takes the kept document as a traversal does (http-cache suite,
  history rows).
