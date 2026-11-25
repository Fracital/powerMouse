### Performance

- A proxied `localStorage.getItem` takes less than half the time it did:
  the Storage stand-in asks the document for its storage key on every
  call, and the document made it by building its URL again (a parse of the
  address), most of the call's time. The key now comes from the origin the
  document keeps with its memo of that URL, which a navigation, a
  `history.pushState` or a new document replaces as before. A getItem that
  finds its key went from 3.5 to 1.5 us in Firefox 153 (0.1 natively) and
  from 1.9 to 1.0 us in Chrome 159; one that finds none from 7.7 to 2.4 us
  and from 4.7 to 1.6 us. krunk.io reads its settings from localStorage in
  every frame.
