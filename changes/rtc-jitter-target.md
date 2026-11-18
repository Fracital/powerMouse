### Fixes

- A proxied page plays a call's sound as soon after it comes as Chrome
  does. The worker's jitter buffer aims at the delay Chrome's NetEq aims
  at (20 ms for a steady stream, a packet more where lost packets are
  rebuilt from the next one's FEC copy or where the arrivals vary), set
  as NetEq's delay manager sets it, where it held every Opus stream 60 ms;
  its frames wait about the middle of the range NetEq keeps its buffer
  in, and a frame lost when nothing was held is made up once, not twice.
