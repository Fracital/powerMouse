### Fixes

- The tab manager's zoom out shows the tab's address bar and menu bar
  shrinking with its page, as the zoom back in does. Opened from a tab, the
  card's copy of the bar faded in with the manager's controls, from 0 to 1
  over 250 ms, while the card shrank on a curve that does most of its
  travel early: the copy was at 0.3 opacity or less for the first two
  thirds of the shrink, so the live bar vanished and the copy seemed to
  appear in place. It is now solid from the first frame. Opened from the
  home screen, where no tab is on screen, each card's page no longer
  zooms out of a full-screen box under a bar copy that stayed put (or
  zoomed too, faded, when a card had last been opened): the cards appear
  in their slots and fade in, bar and page together. (switcher-geometry
  suite.)
