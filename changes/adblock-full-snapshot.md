### Performance

- The content blocker's engine snapshot holds all eight default lists (3.6
  MB on the wire, 1.1 MB before), so every rule serves from a first visit's
  first request, and the lists are fetched again only once the pages'
  requests have been quiet for 10 s (a minute after the first navigation at
  the most); a stale stored engine's refresh waits the same way. A fresh
  profile downloaded and compiled the eight lists in the middle of its first
  page load before: the bench's article page took 0.65 s less of Chrome's
  CPU (1,110 against 1,760 ms), and a blank tab 158 MB less memory.
