### Fixes

- The first click on an installed extension works. The controller's
  extensions hub answers clicks, menus and popups from its own list, which
  it reads from the service worker once the controller is up, while the
  host's list (the puzzle piece's rows, `extensions.list()`) is the
  worker's: a call that came before the hub's first list, or while it read
  the list again after a change, failed with "No enabled extension with id
  ... is installed". In a tab open during a deploy (its page older than the
  worker) the hub never read the list at all until the old worker restarted,
  so the toolbar had no buttons and every row of the list failed that way.
  The hub now waits for its first list and any list in flight before it
  looks an extension up, reads the list again before an install, enable,
  removal, update or reload answers, and starts with a stale worker too.
  (demo-extensions suite.)

### Demo and API

- An extension's popup opens as the Shields panel does: it stays hidden
  until its document has said its size, then fades in with the panel's
  animation at that size, and closes at once. It used to show at 25 px and
  grow into its size over 0.2 s (the page's universal transition on its
  frame), with the fade half over by then. A later size change is taken at
  once. (demo-extensions suite.)
