### Fixes

- A proxied page's autofocus element has the focus as the page appears, as
  natively, so the keys a user types next go into Bing's search box. Chrome
  runs autofocus for the tab's top document only, the demo's: the address
  bar there has the focus, so it dropped the page's candidates, and in
  isolation mode it refused them as a cross-origin subframe's. The proxied
  top now flushes its own candidates as Chrome does for a top. (focus
  suite.)
