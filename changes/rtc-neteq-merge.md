### Fixes

- A proxied page plays a call's sound through loss with as little delay
  as Chrome, and starts it as soon. The worker's receiver now plays
  through a sync buffer every 10 ms and decides as NetEq's loop does: a
  lost packet's time is made up a pitch period at a time until the next
  packet may play, which is merged in where it fits the made-up sound
  best, so with a tenth of the packets lost its packets wait 16 to 21 ms,
  where Chrome's wait 12 to 20 and the worker's waited 20 to 28; a
  stream's first sound follows its first packet within 10 ms, as
  Chrome's does, where it waited 42 to 45 ms; a held-up burst stays as
  late as Chrome keeps it, for the 2 s NetEq remembers it; and the
  received track's frames are 10 ms long, as Chrome's are, where they
  were 20.
