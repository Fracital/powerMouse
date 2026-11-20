### Performance

- A reloaded page's localStorage and sessionStorage writes take no
  synchronous round trip again, and a store written before it is read is
  read whole in one. A realm leaves the stamps' lists when its document goes
  (pagehide), but the page's own pagehide listeners run after STomp's and
  read the store, which put the realm back on the list for good: every
  reload of YouTube added one, so the next document saw another realm
  holding a copy and sent each write through the synchronous bridge. A realm
  that left now stays off the lists, and keeps no copy, until its document
  shows again (pageshow, from the back/forward cache). And a document whose
  first operation on a store is a write (YouTube's availability check, a
  setItem and a removeItem of one key) never took the store's keys and small
  values, since its copy was not empty: every read of another key was a
  round trip of its own. YouTube watch reload: 135 bridge round trips in the
  first seven seconds to 17 (the cookie writes and reads left), about 150 to
  15 ms of the page's thread spent waiting for them. (stamp-holders suite:
  after a reload one realm is on each list and the reloaded page's thirty
  writes take no round trip; storage-first-read suite: a frame that writes
  before it reads takes at most three round trips for sixty reads.)
