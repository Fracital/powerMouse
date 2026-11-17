### Performance

- The handlers of long tasks and long animation frames
  (`src/inject/dom/modules/LongTasks.ts`, `LongFrames.ts`) are deferred
  parts, evaluated when a document's first such entry reaches its page;
  the natives they read are still taken as the bundle runs
  (`src/inject/dom/longEntryNatives.ts`). `injectDocument.js` is 4.4 KB
  smaller. (performance-entries, performance-buffer.)
