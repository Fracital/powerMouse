### Fidelity

- A response header's bytes past 0x7F reach the page as they do natively: a
  raw UTF-8 or Latin-1 value (an X- header, a Content-Disposition filename)
  read through `headers.get()` or `getResponseHeader` is its bytes, a code
  unit each, where Chrome's second UTF-8 encoding of a service worker's
  headers made c3 a9 read as c3 83 c2 a9. The worker notes the bytes in a
  Server-Timing mark of its own (`stomp-bytes`) that the inject reads and the
  page never sees, and gives the browser a Content-Disposition it names the
  download from as natively: a UTF-8 filename as itself, one whose bytes are
  not UTF-8 by the URL, and a navigation's with no filename by the site's URL
  rather than the route's (`header-bytes` suite; `malformed-headers` compares
  its obs-text case as it is now).
