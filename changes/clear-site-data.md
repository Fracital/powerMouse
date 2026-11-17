### Fidelity

- `Clear-Site-Data` acts on `"cookies"`, `"storage"` and `"*"` as Chrome
  does, for the site that sent it only: its cookies (its registrable
  domain's, in the partition the response came in), its localStorage,
  sessionStorage, IndexedDB, Cache Storage, origin private file system and
  service workers. Only `"cache"` was acted on before. (clear-site-data
  suite.)
