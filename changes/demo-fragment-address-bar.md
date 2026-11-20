### Demo and API

- A page the demo's fragment names (a reload, a restored session, the link
  in a new tab) has its address in the address bar from the first paint,
  where the bar showed "Search or enter a web address" until the controller
  could read the fragment. The demo keeps what the bar showed for each
  fragment it wrote (the newest 32, in its own localStorage beside the
  history, and a page forgotten from the history is forgotten there too); a
  fragment it kept nothing for leaves the bar blank, without the
  placeholder, until the page is read.
