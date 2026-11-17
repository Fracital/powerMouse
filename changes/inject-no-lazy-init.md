### Performance

- The document and worker bundles and the service worker evaluate their
  modules without esbuild's lazy initializers: one dynamic `import()` in
  `src/server/Cookies.ts` (shared with the inject bundles) had wrapped every
  module in one, called at the start of each module and snapshot.
  `openCookies` takes the public suffix function from its caller instead.
  The document bundle is 2.0 KB smaller.
