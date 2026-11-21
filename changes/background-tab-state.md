### Fixes

- A tab in the background keeps its scroll position, its focused element and
  its selection: its frame is hidden with `visibility: hidden` and made inert
  instead of `display: none`, which emptied the focus and read no scroll
  while the tab was hidden (`demo-vibeos`).
- A tab of the site pool whose load ends before its frame knows its address
  says Ready when its document's report comes, instead of staying on Loaded
  (`site-pool-kept-sites`).
