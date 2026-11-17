### Security

- `navigator.storageBuckets` is partitioned per site: the browser keyed every
  proxied site's buckets together under the proxy origin, so a frame of
  another site listed, opened and deleted the buckets of the site that framed
  it. A bucket's real name now starts with a digest of the context's storage
  key (computed with nothing a page can replace), and open(), keys(),
  delete() and a bucket's `name` answer with the page's own names, refusing
  invalid ones with Chrome's errors; a sandboxed opaque document is refused
  the API with Chrome's SecurityError (storage-buckets, adversarial-buckets).
