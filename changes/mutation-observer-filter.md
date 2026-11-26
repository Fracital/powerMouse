### Performance

- A document's tree changing no longer sends the host its title and icon,
  or looks for autofocus elements, unless the change can affect them. The
  Navigate module's observer ran both on every mutation: a timer, a read of
  the title and the icon links, two JSON strings and a message to the host,
  then a querySelectorAll of the whole document. krunk.io's HUD rewrites
  text nodes in every frame, so all of that ran in every frame. Now a
  record schedules the host's update only when it touches a title, link,
  base, head or html element (or a text node in one), an href or rel
  attribute, or the document itself. Autofocus runs only for an added
  element that has or holds `[autofocus]`. A record the observer cannot
  read counts as touching everything, as every record did before, and so
  do records of another realm than the document's (a new window whose
  client its opener's bundle made): a node read through them would get
  that realm's wrapper, which none of the window's hooks see. In
  Chrome 159 the observer's share of 8 s of play went from 11 to 12 ms to
  about 1 ms. The focus and navigate-events suites cover autofocus and the
  host's title and icon, speculation-rules a new window's own hooks.
