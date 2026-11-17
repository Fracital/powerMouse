### Fixes

- A tab the user closes no longer stays in memory: the controller's joint
  session history kept every tab's history with its window, and the window
  its last document's whole realm, for the host page's life (about 2 MB a
  tab on a small page, tens of megabytes on a real site). The histories are
  held weakly now (tab-churn).
