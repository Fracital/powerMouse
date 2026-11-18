### Fidelity

- Over HTTP/2 a request's Cookie goes out through epoxy as one field per
  cookie, as Chrome's HPACK encoder sends it; it went out as one joined
  field. HTTP/1.1 keeps one line, as natively. (epoxy-request-fields
  suite.)
