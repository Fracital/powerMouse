### Performance

- Downloads from several servers at once spread their TLS across cores
  once one core cannot keep up. The transport worker ran epoxy, and with it
  every TLS connection's crypto, HTTP/2 and Wisp multiplexing, on one
  thread: through a local holyWisp a download over TLS held at about 590
  Mbit/s on a Ryzen 9 7950X however many servers it came from, that worker
  at 96 % of a core. Now the transport worker runs epoxy itself as shard 1
  and starts more shards, workers of its own script, only when it falls
  behind (its tasks run more than 6 ms late while packets arrive) with
  more servers sending bodies than shards running
  (`TransportDescriptor.shards`, at most half the cores the browser
  reports and 4 by default; `1` runs the transport alone as before, and
  `{ max, start }` starts some from the start). A server's image or two
  starts none: ordinary browsing runs on the one thread it always did, at
  no cost in memory or first-request time, and a worker that carried
  nothing for 30 s closes. Each origin (and network partition) runs on one
  shard at a time, so its connections, its TLS sessions and the
  connections opened to it are the ones one epoxy would have; it moves to
  a new shard only between requests, with nothing of it in flight, at most
  once every 5 s. The socket pool, the fields sent, ranged resumes and the
  order requests go in stay in the transport worker, ahead of every shard.
  The Wisp connection stays one: it is split into a lane per shard, each
  lane's epoxy shaking hands with the relay's one greeting and its streams
  renumbered into the connection's, so the relay sees one session or
  WebSocket (the carrier host's, when it holds one), one handshake and one
  stream id space. On that machine, over the relay's WebTransport session,
  1.6 GB as runs of 25 MB requests from four servers at once went from
  about 630 to about 1,300 Mbit/s (eight servers: 620 to 1,340), shard 1
  starting three workers within the first second or two and the downloads
  moving to them; one server alone stays at one core's worth (about 615).
  Downloads that each run as one long response from the start stay on the
  thread they began on (about 630 at four and at eight servers), since a
  TLS connection cannot change threads mid-body; `{ max: 4, start: 4 }`
  spreads them from the first request (about 900 to 1,400 at four and at
  eight). With no download, a start answers its first request in the same
  63 ms and the renderers hold the same 642 MB as with `shards: 1` (the
  first cut's three workers from the start cost 16 ms and about 150 MB).
