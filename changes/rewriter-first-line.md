### Performance

- The rewriter no longer reads a classic script's whole first line to place
  its preamble: it looks past the line's start only when the line is an
  HTML close comment. A bundle's first line is often the whole file, and
  reading it took 33 ms of a 6 MB script's rewrite. The parser no longer
  hashes each name it reads either, since nothing uses the hashes. Rewrites
  over the site corpus take 4.3% less time, and some bundles far less: a
  6 MB chunk of discord.com's home page 40%, Outlook's 2.9 MB bundle 21%,
  a 2.9 MB Pinterest chunk 68%. The output is the same.
