### Fixes

- A frame the page removes or navigates no longer stays in memory: WebRTC's
  tables, shared by a frame and its parent, held an entry made by each
  frame's own realm, which kept the frame's whole realm (about 1.1 MB with
  the inject) for the page's life, and ad-heavy pages ran the renderer out
  of memory. The entries are made by the tables' realm now (frame-churn).
