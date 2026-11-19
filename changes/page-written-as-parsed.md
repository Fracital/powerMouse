### Performance

- A document's markup is written to the page as the client's parse of it
  goes, a task at a time, where the client copied all of it through the
  hooks and wrote it in one task: the page paints its first part and loads
  its head's stylesheets while the rest is copied, and no task runs for
  seconds. Natively, the browser parses, paints and loads as it goes. The
  parse is made in an inert document. A node the parser is done with is
  copied and written. An element it may still add to is written as its
  start tag, its children as they are done and its end tag once the parser
  is past it. A table or a formatting element is written whole only, as is
  a text before an open table. The head is written once the body starts. A
  later `<html>` or `<body>` tag's attributes go as such a tag, and nothing
  of the body is written while a `<frameset>` could still replace it. The
  copies are written 256 KB at a time, more as the page grows (a quarter
  of what is written, up to 1 MB), or a quarter second after the last
  write, about as often as the browser draws a loading page natively. Written after each pass, a 20 MB page was laid out
  four times as often as natively. Script order, `document.write` landing
  after its script, a MutationObserver seeing a script before it runs and a
  timer's write opening the document are as before. On a 5 MB page,
  first contentful paint went from 1.5 s to 0.2 to 0.6 s, and the longest
  task from 1.1 s to 0.2 s. (html, markup-*, document-write, prewrite,
  frame-cost suites.)
