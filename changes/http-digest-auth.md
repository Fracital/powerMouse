### Fidelity

- HTTP Digest authentication (RFC 7616: MD5, MD5-sess, SHA-256 and
  SHA-256-sess, qop=auth or none) answers a site's challenge as Chrome does,
  where it reached the page as its 401: with XMLHttpRequest's user and
  password or a URL's credentials, in pages and workers, else with what the
  auth cache kept for the realm. What succeeded is sent ahead to later
  requests under the same directory with the next nonce count, a stale
  nonce is answered again with the new one, and a site that offers Digest
  and Basic gets Digest. The auth cache now follows Chrome's measured rules
  for Basic too: the longest kept directory is sent ahead, credentials the
  site refuses (open()'s, or the page's own Authorization header) forget
  the realm's, a cross-origin CORS request ignores open()'s credentials
  (it sends what was kept and answers with the realm's), and
  Clear-Site-Data "cookies" clears what the site's authentication answered
  (http-auth suite, against Chrome 159).

### Security

- Credentials a page gave XMLHttpRequest (open()'s user and password, or
  the URL's) are no longer sent to the origin a redirect leads to. The
  browser follows a redirect in proxy URL space and repeats the inject's
  credentials header on every hop, so the next origin's challenge was
  answered with them: a site could redirect a request with
  `withCredentials` to another origin and read the user's password there.
  They now name the URL they are for, and the worker uses them on the first
  hop only, as natively. `cookies.clear(origin)` also forgets what the
  site's HTTP authentication answered (and `cookies.clear()` every site's),
  in the hub's worker and each slot's (http-auth suite).

### Known limitations

- HTTP authentication answers Basic and Digest only (Digest's `userhash`
  and `auth-int` are not answered): an NTLM or Negotiate challenge reaches
  the page as its 401, where Chrome answers NTLM with the page's
  credentials. Both handshakes are bound to one connection, which a request
  through the transport cannot hold. A challenge the page has no
  credentials for never prompts, and the auth cache lasts as long as the
  service worker does. This replaces the earlier entry that said HTTP
  authentication is Basic only.
