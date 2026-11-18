### Build

- The checks of `navigator.registerProtocolHandler()` and
  `unregisterProtocolHandler()` past their arguments' count and receiver
  (`src/inject/dom/protocolHandlers.ts`) are a deferred part of the
  document bundle, made at a page's first such call; without it the call
  throws (deferred-refusals). A frame no longer makes the set of safelisted
  schemes as it loads.
