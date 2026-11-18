### Fidelity

- The fields a page sets on its own fetch or XMLHttpRequest go out where
  Chrome puts them: an Accept, an Accept-Language, a Cache-Control or a
  Pragma the page wrote sits among its other fields in Blink's header map
  order, where the browser's own defaults of those names come later.
  STomp put a page's Accept after the map, its Accept-Language with the
  network stack's fields and its Cache-Control and Pragma first, so
  walmart's and bestbuy's graphql calls (which write all of them) went out
  in an order Chrome never sends. With HTTP/3 on, the base transport also
  gets the worker's Accept-Encoding in Chrome's place instead of inserting
  its own before Accept-Language. field-order compares five more requests
  with native Chrome's.
