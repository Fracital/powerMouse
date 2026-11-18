### Fixes

- A custom property's url() reads back as the page wrote it, in a computed
  style, a rule's style and an element's, as natively: a custom property
  keeps its tokens as written. A computed one read back as the absolute,
  quoted URL (`url("https://...")`) and a rule's as a quoted one, so
  lichess.org, which cuts `url(` and `)` off its `---white-king` and loads
  the rest, asked for `/"https://lichess.org/assets/...` for every chess
  piece. (custom-property-urls suite.)
