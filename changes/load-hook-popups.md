### Demo and API

- The demo's load hook (the Stop button's) no longer posts its word to a
  popup's own page: a popup a proxied page opened is the browser's top,
  with no tab of the demo to tell, and its page took the word as a message
  of its own (`popup-openers`). The hook runs only where its top is another
  window, as the token hook does.
