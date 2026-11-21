### Demo and API

- The home page's Latest commits update live: the server's one poller asks
  GitHub's commits API for the default branch about once a minute while a
  page is open (conditionally, within `x-ratelimit-remaining` and its reset,
  `retry-after` honoured, backing off on errors, the last answer kept on
  disk), merges in the checkout's git log, which stays the answer when
  GitHub is out of reach, and pushes each change over
  `/api/commits/stream` (Server-Sent Events, unbuffered through the
  fronts). A visible page subscribes, updates its rows in place with the
  new commits on top, falls back to asking `/api/commits` when the stream
  fails, and shows a commit pushed but not deployed yet with a hollow dot.
  `/api/commits` keeps its shape, with `deployed` per commit and `live`
  added. Without `GITHUB_TOKEN` every 304 counts against the 60 requests
  an hour (measured), so the poller spreads what is left of the hour.
  `STOMP_GITHUB_API` points the poller at a fake for tests (`off` in every
  suite's server); demo-bookmarks checks it against one.
