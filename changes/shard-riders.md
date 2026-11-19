### Performance

- Downloads from four servers at once went from about 1,300 to about
  1,600 Mbit/s (1.6 GB as runs of 25 MB requests, over a local holyWisp's
  WebTransport session, Ryzen 9 7950X): the transport's workers no longer
  wait on the transport worker. With the carrier host, each worker is a
  rider of the host's relay of its own (`ride`), its packets going between
  the host and the worker directly, where the transport worker had relayed
  every one; the relay still sees one session. While workers run, the
  transport worker takes no new server (every worker's bodies still go
  through it, and a download there ran slowest of four), so by default up
  to four workers start beside it; they start at once for every busy
  server beyond one a worker, where each waited for the last one to fall
  behind. One server alone stays on the transport worker (about 600), no
  worker starts for a page's images, and a start answers its first request
  in the same 64 ms with the renderers at the same 644 MB as with
  `shards: 1`. An HTTP/1 server whose download holds a connection on a
  thread that cannot keep up has its next connection opened on another
  one. Downloads that each run as one response from the start stay on the
  thread they began on (about 570 at four servers): a response under way
  cannot change threads. A rider and a carrier host that both say
  `batches` send a task's packets in one message.
