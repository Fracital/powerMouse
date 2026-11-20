### Performance

- The HTTP cache keeps a listing of what its store holds (the time each
  entry was written and its size), made by one walk of the store and kept
  by every write and delete after it. An eviction drops the oldest entries
  by it, where each one walked the store and read every entry's headers
  again (a full store holds thousands, once per 10 MB written), and a
  request for a URL the store does not hold is a miss without asking it.
  Six loads of a local page of 200 images of 60 KB (past the 50 MB
  budget): 4110 to 2798 ms of the service worker's time and 1099 to 746 ms
  a load, Chrome 157. (cache-walks suite: past the budget the oldest
  resource is evicted and the newest kept.)
