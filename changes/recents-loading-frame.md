### Demo and API

- A tab closed while its next page was still loading no longer lives on:
  the page used to arrive anyway in a frame of no tab, unseen behind the
  home screen, and the tab manager showed it full screen over its cards.
  A dialed tab's loading frame now stays out of sight whatever the host's
  styles say, and takes the tab frame's current classes and styles when it
  is swapped in, so a page that arrives while the tab manager is open lands
  on its card.
