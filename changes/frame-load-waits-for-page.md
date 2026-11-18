### Fidelity

- A page's load event waits for its frames' pages, as natively, however
  busy the machine. A proxied document starts as STomp's shell, which
  wrote the page from a timer; when the shell finished parsing before
  that timer ran, the frame counted as loaded with the empty shell in it,
  and the parent's onload found no content there (web-platform-tests'
  big5-decode-errors.html, now and then on a loaded runner). The shell
  now ends with an empty marker element, and the page is written when
  the parser reaches it, before the shell can finish; the timer is kept
  for a shell no network parser reads (frame-onload).
