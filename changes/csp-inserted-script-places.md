### Fidelity

- A CSP violation of an inline script that the page's code inserts
  (through the DOM or by document.write) names the inserting call, as
  Chrome's does: sourceFile, lineNumber and columnNumber, in a script file
  its place in the file's own text. A document reports a placed violation
  once, as Chrome does: the same code refused again at the same place fires
  its event and makes no second report. csp-meta-scripts compares the
  places of scripts a script file inserts with native.
