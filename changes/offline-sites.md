### Fixes

- offline.html runs sites in Chrome as the served demo does. Its tabs
  dial (just call stomp): the worker it runs in the page serves the call
  page, which the page gives each frame as its srcdoc, so a site's
  history (pushState and replaceState threw a SecurityError in every
  document), its Navigation API and its own frames work, and Google's
  search box submits its query. Its documents make their routes on
  file:// where they read their origin as "null" (localStorage and
  sessionStorage threw on every call), and reach the worker through a
  port the page leaves on their window, so they open WebSockets. Firefox,
  which reads the page's origin as "null", keeps the written frames.
