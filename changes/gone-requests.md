### Fixes

- A document's requests end with it, as natively. A request still waiting
  for its server's answer when its document went (a link, a reload, a frame
  removed) went on in the service worker and held one of its server's six
  connections until the server answered: Chrome fires no abort on a fetch
  event when its client goes. Leaving a page whose server held four requests
  a minute made the next visit's navigation to that server wait 50 s
  (natively 11 ms). The worker now gives up the requests of a client that is
  gone from its clients list, and a request given up, or aborted by the page
  while it waits for the answer, lets its connection go to the next request
  of that server at once. (gone-requests suite.)
