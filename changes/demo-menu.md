### Demo and API

- The demo has a menu: a button beside the address box (outside it), and
  one beside New tab in the tab manager, which hides the bar, open a
  popover built on the Shields panel's with Fullscreen and About.
  Fullscreen puts the demo's own page in fullscreen and out of it, its
  label and icon saying which, also after Escape or the browser left it;
  where the page cannot be made fullscreen (an iPhone's Safari) the menu
  leaves it out. About opens a dialog with the version, the build id, the
  commit and the build date the server serves, and what the console badges
  say (mode, transport, controller) with the server's Node and uptime. The
  arrows, Home and End move through the menu, Escape, a click outside and
  every item close it, and the dialog keeps the focus (everything behind it
  is inert, Tab goes round its controls) until Escape, its Close button or
  its backdrop closes it. On a phone the bar's buttons are narrower, so the
  address box keeps its 120px at 320px wide. (demo-menu suite.)
- The Shields panel fades in and closes at once: it faded out for 0.16 s,
  and its parts, under the page's universal transition, for 0.2 s, still
  drawn over the page after it was closed. When the focus was in it,
  closing it gives the focus back to its button.
- `/api/status` answers the build being served (`build`: the contents of
  `dist/build.json`).

### Build

- `dist/build.json` says what the build is: the version, the build id, and
  the last commit that changed the build's inputs with that commit's date
  (`SOURCE_DATE_EPOCH` when it is set), never the time of the build, so the
  build stays reproducible and a commit of only the tests, docs, demo or CI
  keeps the file as it is.
