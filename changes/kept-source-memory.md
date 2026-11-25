### Fixes

- A page that evaluates many distinct scripts (eval or new Function in a
  loop, a challenge retried every second, an app that injects scripts) no
  longer keeps the text of each for its life. The inject keeps a script's
  text so that its functions read back as the page wrote them, and it kept
  every one: 10,000 evals of 4,000 characters held 40 MB after a GC, 20,000
  held 80 MB. The table now keeps the newest used 8192 texts and no more
  than 8 Mi UTF-16 units of them, and a text it lets go is still kept for
  as long as something of the page's it belongs to lives: a function whose
  source was read, a function eval or new Function handed the page, the
  script element or the element of the handler attribute it is the text of,
  or the holder its realm keeps for a script the service worker rewrote. A
  function none of those reach, whose text was let go (a direct eval's value
  never read, one evaluated code stored), reads as its rewrite without the
  rewriter's marks, which is the page's own text where the rewriter changed
  nothing in it. Measured by the new function-source-churn suite: 9.2 MB
  after 10,000 and 9.3 MB after 20,000, and every function the page still
  holds reads as natively.
