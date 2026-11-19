### Fixes

- A transport's workers read the carrier host's relay at the pace their
  bodies are read, as the transport worker does. Each worker's rider of
  the relay says what it took, the host sends at most 4 MiB past that and
  stops reading the relay while a rider is that far behind, so a large
  download through a worker no longer piles up in the worker's epoxy
  faster than the page reads it. Packets that wait for the readers go to
  epoxy before the relay's end, on a worker's rider and on the transport
  worker's own.
