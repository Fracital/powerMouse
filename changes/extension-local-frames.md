### Fixes

- Extensions' content scripts run in about:blank, about:srcdoc, blob: and
  data: frames as Chrome runs them: `match_about_blank` and
  `match_origin_as_fallback` match the frame's creator, with `all_frames`.
  `scripting.executeScript` reaches those frames too, and its `files`
  answer the last file's completion value per frame instead of none.
  (ext-frames suite, against the probe loaded natively.)
- webNavigation gives a nested frame its real `parentFrameId` (it was 0
  however deep the frame was), tells onErrorOccurred for a frame whose
  navigation failed and lists it in `getAllFrames`, and a tab the page
  opens has `openerTabId` and an onCreatedNavigationTarget event. The
  frame ids agree with `sender.frameId` and executeScript's results.
  (ext-frames suite.)
