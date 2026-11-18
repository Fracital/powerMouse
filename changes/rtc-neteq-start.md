### Fixes

- A proxied call's sound keeps as much delay through jittered packets as
  Chrome's: the worker now stretches its sound a pitch period at a time
  as NetEq's time stretching does (145 samples for a 660 Hz tone, where
  it put in 218), makes up a late packet's time at NetEq's expand lag
  (291 samples for that tone, where it repeated 145), starts a call at
  NetEq's start target of 80 ms, and does not stretch a call's first
  60 ms, where it stretched its first packet. With packets delayed by 0
  to 20 or 0 to 40 ms its packets wait 36 to 42 and 41 to 53 ms, where
  Chrome's wait 30 to 52 and 38 to 53 and the worker's waited 31 to 32
  and 39 to 42.
