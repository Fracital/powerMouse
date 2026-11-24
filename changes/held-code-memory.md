### Fixes

- Firefox no longer holds a copy of every script the inject rewrote (an
  inline script, a handler, eval, a string timer) until 4096 of them pile
  up. Each was kept whole so that a V8 stack frame in it could be placed in
  the page's text, which only V8 can ask for; Firefox and WebKit never could,
  and never let go. A page that runs a large script again and again
  (Cloudflare Turnstile retrying a failed challenge, about once a second on
  a page with several widgets) grew the stomp origin's process by about
  50 MB a second, and froze the tab, on a phone first. Such code is now kept
  only where the engine names a frame's script by its hash, and the held
  outputs are capped at 32 Mi UTF-16 units there too, the oldest dropped
  first. Measured on that page in Firefox 153.7.0esr: the process held
  1.4 GB after 50 seconds, down from 4.3 GB.
