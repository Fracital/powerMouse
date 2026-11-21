### Demo and API

- The demo's estro.help bookmark is estrogen now, with its page's
  description and its own PWA icon (estrogen.png, 64 px) on a black tile.
  A profile seeded while it was Estro gets the new title, description,
  icon and colour for each field still at its old value (demo-bookmarks).
- The home page's commit times stay current without a reload: one timer
  updates every row's `<time>` when the soonest label changes, and none
  runs while the page is hidden (demo-bookmarks).
