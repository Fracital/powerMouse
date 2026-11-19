### Security

- A frame or popup that a page reached before its first document loaded
  no longer runs that document in the parent's realm when it is of
  another site. Through the proxy every site shares one real origin, so
  Chrome keeps the frame's initial about:blank window for the document,
  and the proxy had installed the parent's own hooks there, so the other
  site's document could reach objects of the parent's realm (errors its
  hooks threw, promises they returned). The window is now left as Chrome
  made it, the page holding only its usual stand-in, and the document
  sets itself up in it as in any new window. A document that still finds
  another origin's setup in its window moves to a new one before any of
  it runs.
