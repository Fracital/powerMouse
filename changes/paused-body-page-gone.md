### Fixes

- A page that reloads or closes while a response body it was reading is
  paused now closes that body's stream at the relay at once. Through the
  carrier host the transport worker went with its page without a word (a
  MessagePort fires no close in Chrome 159), and the host went on reading
  the stream for no one until its rider's queue was full: on a relay
  without stream credit the origin wrote 68 MB more over 4.3 s before the
  stream was reset. The page now tells the host as it unloads for good, on
  a port of its own (`pagehide`, not one into the back/forward cache): the
  stream closes 9 to 32 ms after the reload and the origin writes 0.2 MB
  more, on the relay's WebSocket and its WebTransport session alike.
  (paused-body-memory's reload rounds.)
- Whether a relay connection has stream credit is decided per connection.
  It was one flag for the transport worker, set by the INFOs that went
  by, so a transport switched (`setTransport()`) from a relay with credit
  to one in Wisp v1, which sends no INFO, kept the old connection's credit,
  and a paused body on it was all in epoxy's wasm memory again (380 MB of a
  384 MB body). Now the newest connection whose opening is over decides,
  and a connection still opening leaves the one before it to judge its own
  bodies: the switched body is reset at 64 MB as on any relay without
  credit, and the worker grows by 6 MB. A body bounded for a relay without
  credit that the page cancels while a read waits no longer leaves that
  read waiting for good. (paused-body-memory's `switch-v1-chunked`.)

### Known limitations

- A paused response body on a relay without stream credit, over the
  relay's WebTransport session, holds up the other streams of the
  connection for 1 to 4.5 s (measured on loopback). The relay sends the
  paused stream as fast as the session takes it until the body is reset,
  and what it queued for that stream still goes out after the reset, ahead
  of the other streams. Over the WebSocket the other streams waited 50 ms
  at most. Stream credit (holyWisp's `stream-credit`) avoids it. Paused
  HTTP/2 and HTTP/3 bodies were measured too: their own windows hold the
  origin 10 to 14 MB ahead of the reader on either relay and either
  carrier, and the transport worker grows by 22 MB at most.
  (paused-body-memory.)
