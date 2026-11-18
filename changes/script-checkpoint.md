### Fidelity

- A MutationObserver sees each inline script of the page's markup before it
  runs, and reads its text as the page wrote it, as with the network's
  parser, which performs a microtask checkpoint before it runs a script it
  inserted: the markup was written in one `document.write`, whose scripts
  ran back to back, so an observer heard of a script only after it ran (and
  one behind a parser-blocking script read the rewrite, with the proxy's
  `sourceURL`), and a script's promise reactions ran after the next
  scripts. The markup is now written in pieces that end before each
  `</script`, each from a microtask; there, as where the network's parser has
  no insertion point, a page's `document.write()` or `open()` opens the
  document, and while the pieces are written a script's `close()` ends
  nothing (WPT's document-write/mutation-observer.html now passes all four
  cases). uBlock Origin's `replace-node-text` and
  `remove-node-text` rules work through it (YouTube's quick fix among
  them). (script-checkpoint and adblock-youtube suites.)
