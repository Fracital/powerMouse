### Performance

- A document that hears the service worker's note of a change of its
  site's cookies drops its own copy of document.cookie and leaves the
  site's stamp in the proxy origin's localStorage alone: every other
  document the change is for hears the note too, and a stamp written by
  each one that heard it was a storage event in every document of the
  proxy origin (apnews.com wrote 4,967 stamps in 36 s, about 170,000 events
  on the page's thread; now 273, from the page's own writes).
  (change-notes suite.)
