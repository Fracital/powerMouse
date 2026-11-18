### Performance

- A document.cookie or storage write stamps the proxy origin's own
  localStorage (which tells another document's copy of the jar or the store
  that it is stale) only while a document of another realm holds such a
  copy. Each stamp was a storage event in every document STomp runs in:
  apnews.com, npr.org and washingtonpost.com wrote 520 to 920 stamps in
  40 s, nearly all for copies only the writer's realm held, and now write
  10 to 145, most of them the realms' notes that they hold a copy
  (stamp-holders suite, compared with native Chrome).
