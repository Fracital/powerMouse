### Fixes

- A Clear-Site-Data answer naming "storage" (or "\*") drops the site's
  legacy sandboxed file system too, as Chrome does: the site's files of
  `webkitRequestFileSystem` were kept. The service worker asks the windows
  to drop the site's directory and answers once one has. (clear-site-data
  suite.)
