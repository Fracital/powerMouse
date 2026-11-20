### Fixes

- A body the page reads slower than the wire arrives whole when the origin
  closes its idle connection meanwhile, as natively. Wisp has no flow
  control toward the client, so an HTTP/1.1 origin wrote the whole body at
  once and closed its keep-alive connection when its idle timer ran out
  (node's after 5 s), and epoxy dropped what the stream had received but
  the page had not read yet: the read failed (IncompleteBody) a few seconds
  after the origin was done. A stream's close is now read after the data
  that came before it (deploy/epoxy patch epoxy-tls 0082). (slow-body-close
  suite.)
