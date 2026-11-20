### Performance

- A frame whose document has no Content-Security-Policy answers the
  inject's policy questions without looking for a policy. Each script and
  handler attribute of the markup asks one. A frame with one handler
  attribute had come to cost about 6 KB more heap than the same frame
  without it, and costs about 4 KB more again (frame-cost, Chrome 157).
