### Performance

- A load that restarts the stopped service worker no longer waits for the
  content blocker's code to be compiled again. The proxy's page now keeps a
  compiled copy of the blocker's module, so the restarted worker finds that
  code in the browser's process. Before, it compiled the 944 functions of
  its first navigation again (about 19 ms). Measured on Chrome 157 with the
  worker stopped after 20 loads: the navigation commits 37 to 52 ms after
  the worker starts, where it took 63 to 73 ms. The load takes 88 to 113 ms,
  where it took 114 to 133 ms.
