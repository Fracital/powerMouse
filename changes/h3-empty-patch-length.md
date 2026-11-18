### Fidelity

- A bodyless PATCH over HTTP/3 goes out without `Content-Length: 0`, as
  Chrome sends it: Chrome says zero only for a bodyless POST or PUT.
