### Fidelity

- A load STomp copies for a page goes out with the Origin header of the load
  it stands for, as Chrome 157 sends it: none on a no-cors image, classic
  script, stylesheet, @import or background of another origin, nor on an
  embed's or an object's resource (each carried the page's origin, as the
  CORS fetch that copies them would), and one on an element's CORS load of
  the page's own origin (a crossorigin image or stylesheet, a font, in
  every proxied document), which had none. A crossorigin video still sends
  none, as natively. A download the proxy saves goes with
  `Sec-Fetch-Mode: navigate`, and an SVG `<use>`'s external document copied
  for an about:blank frame as a same-origin image, refused for another
  origin, as natively (blank-load-metadata).
