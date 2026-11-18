### Fixes

- A tone a peer's Chrome sends with Opus plays on a proxied page for as
  long as Chrome plays it, 30 to 50 ms, not 120 to 140: the worker read
  the event's duration on the event payload's 8 kHz clock, where Chrome
  counts it, and NetEq reads it, on the audio's.
