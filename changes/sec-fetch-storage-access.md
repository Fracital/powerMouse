### Fidelity

- A credentialed request whose site for cookies is another site than its
  top's carries `Sec-Fetch-Storage-Access`, as Chrome 133 and later send
  it: `active` with cookies allowed, `none` where the shields withhold the
  request's cookies. It was missing on every proxied request (Google's
  sign-in page sends it on its gstatic loads and its CheckConnection
  frame). (fetch-storage-access suite.)
