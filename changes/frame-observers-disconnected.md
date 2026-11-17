### Fixes

- A frame of another site than the top no longer stays in memory after it
  is removed or navigated: the observers it keeps on its frame elements (to
  hold its animation frames while hidden, as Chrome does) are disconnected
  when its document is left. Blink kept each with the frame's realm, about
  1.1 MB per ad or embed frame the page ever had (frame-churn).
