### Performance

- A proxied document's markup leaves 300 fewer nodes to the collector per
  150 links. The inject copies the page's parsed markup through its hooks
  before writing it, and the copy read each element's attributes through
  its `attributes` map, for which Blink makes the map and an Attr node of
  every attribute: on an ad frame of 150 links in rows with a class, 300
  nodes per frame, all of it garbage, in the renderer every frame shares in
  same-origin mode. The copy reads attributes by name now (a namespaced
  one, as before, from the map). A frame of that markup makes 2749 nodes,
  the three trees of its markup (914 natively), where it made 3049.
  (markup-copy-nodes suite.)
