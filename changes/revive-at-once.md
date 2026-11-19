### Performance

- A load after Chrome stopped the idle service worker (it does after about
  30 seconds, so nearly every revisit) is about 100 ms faster: the
  restarted worker asks its controllers to shake hands again as soon as its
  script has run, where it waited 100 ms first, and the load that woke it
  waited for that handshake. Measured on the bench's article fixture with
  Chrome 157 (the worker stopped through DevTools, then a load in the same
  tab): 196 to 228 ms before, 95 to 98 ms after.
