### Performance

- The DOM hooks install with their long loops in closures of their own: a
  loop in the one-shot install that ran long enough had V8 compile the whole
  install (some 12 KB of bytecode each, two of them) to baseline code in
  every compile of the bundle. About 23 KB less heap for each proxied frame
  (frame-cost).
