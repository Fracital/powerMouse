### Security

- An SVG xlink:href written under another prefix (`setAttributeNS` with
  `x:href`, an attribute node, a standalone SVG document's own prefix for
  the xlink namespace) is routed as xlink:href is: an SVG script's source
  loaded and ran unrewritten, an SVG link's `javascript:` URL ran as the
  page wrote it. A SMIL `set` or `animate` of a prefixed href is routed
  too, a value whose target appears later is routed as a file instead of
  left as written (it loaded or navigated past the proxy), and a change of
  the animation's own href routes its values again (adversarial-svg,
  svg-xlink).
- A frame that navigates to a file's route (an animated href that reached
  a link) goes on to the document's own address: the route handed the
  markup on as the site sent it, its scripts running unrewritten on the
  proxy's origin.

### Fidelity

- `href.baseVal` written on an SVG element that has only an xlink:href sets
  the property alone, as Chrome does: the attribute reads back as it was
  and the element loads the new value, routed (it wrote an href attribute
  the element never has). It reads an xlink:href of any prefix, and
  `href.animVal` reads the value an animation sets, as the page wrote it
  (it read the attribute).
