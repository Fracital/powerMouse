### Fidelity

- An empty request says `Content-Length: 0` through epoxy only when its
  method is POST or PUT, as Chrome does: the CORS preflight (an empty
  OPTIONS) said it over HTTP/2, and an empty PATCH over HTTP/2 and
  HTTP/1.1. (epoxy-request-fields suite.)
