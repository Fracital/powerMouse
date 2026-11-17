### Performance

- The collections the inject's hooks keep state in (about 140 WeakMaps,
  WeakSets, Maps and Sets of every frame, one for the instances of each
  interface a hook watches) are made on their first write
  (`LazyWeakMap`, `LazyWeakSet`, `LazyMap`, `LazySet` in
  src/inject/ownCollections.ts): a page fills few of them. Each is asked
  through the natives taken as the bundle loaded, and made from the
  constructor taken then, so a page that replaced `WeakMap.prototype.get`
  or the `Map` global changes nothing they answer. frame-cost prints the
  script time each frame took.
