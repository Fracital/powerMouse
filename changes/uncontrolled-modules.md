### Fixes

- Module scripts with static imports run in a document no service worker
  controls (an about:blank frame or popup, an about:blank a page navigated
  a frame to, markup a page writes into one), as natively: relative,
  path-absolute and absolute imports, an import map's bare specifiers, JSON
  modules, a cycle, and dynamic imports from a module or a classic script.
  Before, every import failed, and a module whose import is missing ran
  instead of firing `error`. In Firefox a cycle still fails there.
- In Safari, an about:blank frame's loads are copied as in Chrome. Safari
  hands such a frame its parent's service worker, and a module it loaded
  from there failed.
