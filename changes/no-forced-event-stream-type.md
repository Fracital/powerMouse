### Fixes

- A response keeps the Content-Type its server sent when the request
  accepts `text/event-stream`. The service worker served every such
  response as `text/event-stream`, so an `EventSource` whose endpoint
  answered something else (an error page, JSON) opened, parsed the body as
  events and reconnected every few seconds for good, where Chrome fails the
  connection at once (`error`, `readyState` CLOSED); and a `fetch` that
  asks for an event stream and reads the answer's type to tell a stream
  from a JSON error (the usual shape of a chat client's request) was told
  every error was a stream. (wpt-eventsource-format: the MIME type cases.)
