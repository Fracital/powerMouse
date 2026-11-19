### Fidelity

- A proxied page's `outerWidth`, `outerHeight`, `screenX`, `screenY`,
  `screenLeft` and `screenTop` are a top-level window's whose viewport is
  the host's frame: the viewport plus the browser's own UI around the
  host's page, at the browser window's position moved by where the frame
  is in the host's viewport. They were the browser window's own, which
  counted the host's UI around the frame as browser UI (the demo's two
  48 px bars made `outerHeight - innerHeight` about 200 in a normal
  window), and Discord, which takes more than 160 for its devtools docked,
  took its token out of storage and logged the user out on every load. The
  host's controller measures its page and frames on every resize and keeps
  the result where the frames' documents read it (the host's page, the
  controller frame, each slot's agent: `src/controller/geometry.ts`); a
  frame of the page reads its top's, as natively (`src/inject/dom/hostGeometry.ts`,
  window-geometry, isolation).
