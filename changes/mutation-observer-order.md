### Fixes

- A page's mutation observers are notified in the order they were made, as
  natively, when their records passed through the hooks (attribute
  writes): each was notified from a microtask of its own, in the order the
  records were taken, so an observer made later could run first.
  (wpt-dom-insertion suite: MutationObserver-callback-order.)
