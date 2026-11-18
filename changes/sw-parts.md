### Performance

- STomp's service worker carries tldts's public suffix trie as data in a
  comment of its own script, parsed the first time it asks tldts anything,
  and evaluates tldts's modules only then. Chrome compiles every function
  of a service worker's script when it installs it and writes all of it
  to the code cache before the install event, and the trie's literals
  were a quarter of the script, built again at every start of the worker,
  for a lookup it asks only while it holds no suffix module. A first
  visit's register() to controller ready went from 136.1 ms to 124.3 ms
  (medians of 24 alternated runs on Chrome 157), and each start of the
  worker runs some 3.5 ms less; the first lookup of a worker that needs
  tldts takes about 3 ms. The worker compiles no string for it.
