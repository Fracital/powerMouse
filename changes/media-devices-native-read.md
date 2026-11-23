### Performance

- A proxied document no longer lists the media devices as it starts: the
  inject reads the document's `navigator.mediaDevices` through the native
  getter, not its own hook, whose first read enumerates the devices for the
  page. Chrome had started its audio and video capture services for every
  document, and a blank tab took 42 MB more memory (333 against 291 MB).
