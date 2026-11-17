### Transport

- A large body the page stops reading, or reads slower than the wire, no
  longer piles up in the transport worker. Wisp has no flow control towards
  the client, so epoxy received a body at the wire's speed whatever the
  reader took and kept it in the transport worker's wasm memory, which
  never shrinks: a page that paused after 8 MB of a 1 GB download had all
  of it there within 70 s (968 MB), and a 300 MB video a media element had
  read 25 MB of took 270 MB, for the life of the tab. A body that can be
  resumed (a GET with a length, byte ranges, a strong validator and no
  content coding) is now read as it arrives into a queue of at most 16 MB
  the reader has not taken; when that is full the body is let go at the
  origin, and the rest is asked for with Range and If-Range once the reader
  has caught up; anything but a 206 of exactly the rest, of the same
  version, fails the body as a broken connection would. A reader that keeps
  up with the wire is never asked for again. Other bodies are received as
  before. (paused-bodies suite.)
