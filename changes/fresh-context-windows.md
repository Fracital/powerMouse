### Fixes

- A frame that goes from one site to another no longer keeps every
  document it showed: the windows of its earlier browsing contexts are held
  weakly, for the realms that still hold one (frame-churn).
