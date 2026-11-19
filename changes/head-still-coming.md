### Performance

- A document whose head is still coming commits on its first bytes, as
  natively, and its head is written as it comes. The service worker read a
  document until its body began before it sent the shell, so YouTube's watch
  page (an 800 KB head, most of it one inline script) committed only once
  the whole head was in. The shell now goes out when the head pauses for 20
  ms after the first 1024 bytes, or has not ended 100 ms after them, made of
  the head so far (a head that keeps coming, CNN's 3.2 MB, is read on and
  goes in one piece, as before); the rest of the head follows in the markup
  stream, and a later meta's policies (Content-Security-Policy, Trusted
  Types, upgrade-insecure-requests) are applied as its piece reaches the
  page, before the page writes it. The page writes a head that has not ended
  as it comes, so its scripts run and its links load before the body starts,
  as the parser runs them, and the first two writes that are drawn at once
  are counted from the body's first. A raw text element the markup stream
  found unfinished (a script's text) is cut once its end tag has come, where
  the stream waited for twice as much markup as it had then, which could
  pass the document's end and hold the rest of the page until its last byte.
  YouTube watch, Chrome 157 headless, medians of five: commit 636 to 188 ms
  on reload (natively 174), 524 to 163 on a link (167), 572 to 171 on back
  (102); first paint 1260 to 1041 ms on reload (907) and 1203 to 883 on a
  link (835). (html-stream suite: the document is committed and the head's
  first script ran while the rest of the head is on its way, a later meta's
  policy refuses eval and an untrusted innerHTML as natively, and a head
  whose script trickles in is in, with the body's first heading, while the
  rest is on its way.)
