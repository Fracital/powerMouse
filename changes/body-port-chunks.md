### Performance

- A response body crosses from the transport's worker to the service worker
  as the transport made it: the chunks that arrive within one task go out
  together with their buffers transferred, where they were joined into a
  buffer of the worker's own first. That was one more copy of every body
  left to the worker's garbage collector, in the renderer the proxied
  frames share in same-origin mode (11 MB of ArrayBuffers for a 12 MB body,
  2 MB now; about 190 KB per load of a 190 KB script, which an idle worker
  never collects). (large-body suite.)

### Fidelity

- A stream a page's service worker answers with keeps its chunks. The proxy
  handed a body's only chunk of a task on by transferring its buffer, so a
  chunk the worker kept read as empty (`byteLength` 0) once the page had
  the response; natively the browser reads a copy. Bodies a page's worker
  makes or passes on are copied now, as the browser copies them, and only
  the proxy's own bodies are transferred. (service-worker-fetch suite.)
