### Fidelity

- A name's HTTPS DNS record is asked at its first request, and once
  stomp-h3 has loaded, the first request to a name whose record names h3
  goes over HTTP/3, as Chrome's does, where it went over HTTP/2 until a
  response's Alt-Svc had been seen. Through the demo with Chrome 157,
  Cloudflare's `/cdn-cgi/trace` reported `http=http/3` for the first
  request to www.cloudflare.com after a visit to example.com, against
  `http/2` before. HTTP/3 asks the DoH server epoxy's `ech_dns` names
  (`http3.dns` still overrides it, an empty string asks none), and with an
  epoxy build that answers HTTPS records itself (its `httpsAnswer`) it
  reads epoxy's own ECH lookup instead, one question per name for both, as
  Chrome's; an older build is asked over DoH. The first request waits for
  the record up to 300 ms and for the QUIC handshake up to `wait` (300 ms),
  then goes over the base transport, as Chrome's first request races QUIC
  against TCP. Answers are kept per network partition. Nothing of it runs
  when the transport starts: stomp-h3 loads when the first record or
  Alt-Svc names h3, and until then a first request does not wait for its
  record, so the first page opened at Ready costs what it did (175 against
  175.5 ms). (http3-fallback suite, with a stand-in DoH server and a
  stand-in base that answers records itself.)
