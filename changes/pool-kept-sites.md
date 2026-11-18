### Fixes

- With the site pool on, a site keeps its slot however many other sites
  come after it. The pool kept the 4096 newest assignments and dropped the
  oldest, so a site first seen before 4096 others was given another slot
  on its next visit and found none of what it had stored there (its
  localStorage, IndexedDB, Cache Storage, origin private file system and
  service workers). Every assignment is kept now.
