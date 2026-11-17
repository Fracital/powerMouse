### CI

- The frame-names suite compares browsing context names natively and
  through the proxy: `window.open('', name)` and `window.open(url, name)`,
  links aimed by name, from the page, from its cross-site child and from
  another tab of another site. A document's named iframe of another site
  (`document.kid`) still gives the frame's own window, which the page can
  read; the suite keeps it as a known open case.
