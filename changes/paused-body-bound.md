### Transport

- A response body whose reader stops no longer fills the transport
  worker's wasm memory on a relay without stream credit. Plain Wisp sends
  a stream whatever its reader takes, and epoxy kept what came in an
  unbounded queue in wasm memory, which never shrinks: a tab that read 1 MB
  of a 384 MB chunked body and paused grew that memory by 384 MB for the
  life of the tab (the browser's PSS by 431 MB, natively 13 MB). An
  HTTP/1 body that nothing else holds back (no stream credit on the
  connection, no HTTP/2 or HTTP/3 window, not resumable by range) is now
  read as it comes into a queue the collector gives back
  (`src/transport/boundedBody.ts`), and once 64 MiB wait for its reader it
  is reset as a connection under memory pressure is: its stream closes at
  the relay and the origin's connection with it, and the reader's stream
  fails with a network error. A pause of a few seconds on an origin that
  sends at a home connection's pace still gets the whole body
  (`paused-bodies`). A relay with stream credit (Wisp 0xE2) still holds
  the stream back itself and the body arrives whole; a carrier the
  transport opens itself (`carrierHost: false`) now watches its INFOs for
  it too. The `paused-body-memory` suite measures each path (with and
  without credit, chunked and ranged, through the carrier host and not, a
  slow reader, a cancel, a reload and a relay cut while paused) against
  the same read natively.
