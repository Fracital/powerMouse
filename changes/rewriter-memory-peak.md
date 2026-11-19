### Performance

- A large script's rewrite needs less memory. The rewriter now lets go of
  the parsed script before it writes the output, which takes the parse's
  room, and it writes the copy of the script's text that a page reads back
  straight into the output rather than building it apart first. Rewriting
  the twelve largest scripts of the site corpus on a fresh instance, as a
  service worker does for each script too large to keep one for, ends with
  18% less memory (discord.com's 12.7 MB bundle 161 MB rather than 200)
  and takes 7% less time. The output is the same.
