### Fidelity

- A document whose server pauses after a piece of its markup shows that
  piece at once, as natively. The client wrote the parse's last node only
  once more markup followed it, since the parser might still add to it, so
  a piece that ended with a lone element (`<h1>early</h1>`), an element in
  a div, a void element or the text after the last tag stayed off the page
  until the next piece came, seconds later on a slow server. Now a comment,
  a void element and an element whose end tag ended the piece are written
  whole, and a text is written as it stands, what the parser adds to it
  after. (html-stream suite.)
