### Performance

- The wrappers of the stand-in classes' members (XMLHttpRequest, WebSocket,
  Storage), of the elements' URL properties, of a link's URL parts and of
  `location`'s members each call one function shared by their kind,
  instead of a closure of their own, and the WebRTC stand-ins' prototypes
  share one proxy handler. A frame makes about 250 closures fewer.
