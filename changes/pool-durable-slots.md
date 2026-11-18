### Fixes

- With the site pool on, a site keeps its slot when the operator changes
  the slot list, as long as the list still has that slot, and when the
  host origin's localStorage is full. Before, a changed list was another
  pool with no assignments, and only the last four lists' were kept, so
  every site moved to another slot; and a site first seen with
  localStorage full had its slot only in that page. Either way the site
  found none of what it had stored (its localStorage, IndexedDB, Cache
  Storage, origin private file system and service workers). The
  assignments are kept in the host origin's IndexedDB now, by slot
  origin, one record a site, and the first page reads in what an earlier
  build kept. A navigation reads its site's record and no longer copies
  every assignment: at 100,000 sites, about 0.3 ms where it took 33 to
  92 ms.
