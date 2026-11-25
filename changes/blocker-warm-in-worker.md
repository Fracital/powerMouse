### Performance

- The content blocker's module is run once on a small engine in one of the
  controller's rewrite workers when the controller has compiled it
  (`src/blocker/warm.ts`). V8 compiles a wasm function on its first call
  and shares the code with every thread of the process that compiled the
  same bytes, so the service worker's first engine load and first questions,
  just as the first navigation comes in, compile some 120 functions (2.3
  ms) on its thread where they compiled 939 (22 ms), on a first visit and a
  revisit alike; its load and warm-up went from 57 to 30 ms (Chrome 159). A
  restarted worker already compiled none. Firefox compiles all of a module
  up front and is unchanged.
