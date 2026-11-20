### Fidelity

- A page's resource and navigation timing names the protocol the origin's
  answer really came over in `nextHopProtocol`: `h3` for an answer over
  HTTP/3, `h2`, `http/1.1`, as Chrome names them. It read `h2` for every
  https answer and `http/1.1` for every http one, whatever the transport
  spoke, so a page on an HTTP/3 origin (every Cloudflare zone) saw `h2`
  where Chrome shows `h3`. The worker reads the version the transport
  reports for each answer (epoxy's `httpVersion`, stomp-h3's) and marks it
  (`stomp-protocol`); a transport that does not say keeps the scheme's
  usual one. (http3 suite.)
