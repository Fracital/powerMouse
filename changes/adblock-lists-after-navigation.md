### Performance

- The content blocker downloads its lists after the first page's document
  has been answered, not at the same moment, and asks for the lists of one
  host over one connection. On a first visit with a cold DNS cache on the
  wisp server, the lists' host lookups held holyWisp's four resolver
  threads and the page's own lookup waited behind them: 8 of 24 first
  loads answered after 50 ms and 2 after 500 ms (15 to 1525 ms), against
  18 to 43 ms with the change. The lists' engine is ready about 300 ms
  later on that first visit, whose pages the engine snapshot the build
  ships filters until then.
