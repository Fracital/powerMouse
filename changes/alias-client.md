### Build

- A module's hook installer reads `this.client` once, at its top, as it
  reads the client's global: `injectDocument.js` is 9.2 KB smaller (500.7
  to 491.5 KB), and a proxied frame's heap smaller with it (the bundle's
  text and compiled code are each frame's). (frame-cost.)
