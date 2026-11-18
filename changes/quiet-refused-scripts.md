### Fixes

- A script the browser refuses as well as the rewriter (one that does not
  parse) goes back as it came without a console warning: nothing of it
  runs natively or proxied, and the page reads the browser's own
  SyntaxError. YouTube's BotGuard evaluates `x='` on every watch and home
  page, so each one logged "Stomp could not rewrite". One the browser
  would run still gets the warning and an end no browser compiles.
  (rewriter-unit suite.)
