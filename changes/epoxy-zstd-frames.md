### Fixes

- A zstd response made of more than one frame reaches the page whole, as
  natively: epoxy (and stomp-h3) stopped decoding at the end of the first
  frame and handed on what it had as the whole body. Spotify's search
  answer comes in 64 KiB frames, so a search showed "No results found"
  through STomp. (zstd-frames suite.)
