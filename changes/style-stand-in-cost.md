### Performance

- A big inline style of a document's markup costs its page about 100 ms
  less (CNN's 3.26 MB one). The script that stands in for it while the
  page is written held the style's rewritten text as the page reads it
  back, which the worker's table of rewrites does not name, so the style
  was rewritten again when the script ran (50 ms): it holds the page's own
  text now. The hash that lets that script past a page's Trusted Types
  policy was a loop of `charCodeAt` calls, 25 ms over the style and taken
  twice: it hashes the browser encoder's UTF-8 of it.
