### Fixes

- A dialed tab (just call stomp) no longer reads as loaded while its
  document is still arriving. The call page closed the document it wrote
  in the same task as the write, and when the shell's bundle ran inside
  that write (its script already at hand, which a loaded runner made
  common on the content slots) the shell's parse ended and the frame's
  load event fired before the client wrote the page. The host then showed
  Reload, a press on it reloaded the page instead of stopping it, and the
  rest of the page came in. The call page now closes the document a task
  later, only if the client has not written the page by then (toolbar,
  dialing-slots).

### CI

- The toolbar suite's Stop checks no longer race a fixed stream: a
  document's end, a held navigation's answer and the loads that end under
  the pointer are let go by the suite (the stop fixture's `hold=late`, and
  `hold` where a 6 s head stood), its waits are conditions with 20 s
  deadlines, and its fixture keys are its run's own, so its rerun no
  longer reads the first run's requests in the runner's shared fixture.
