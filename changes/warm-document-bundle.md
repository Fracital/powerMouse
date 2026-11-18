### Performance

- The controller fetches the document bundle (`injectDocument.js`) once it
  is up, so the first proxied document finds it in the HTTP cache instead
  of downloading all 510 KB between its first byte and its first script:
  that document painted 200 to 370 ms sooner after its first byte over a
  40 ms, 20 Mbit/s link. A host that serves the bundle no-cache still has
  each document revalidate it. (bundle-warm.)
