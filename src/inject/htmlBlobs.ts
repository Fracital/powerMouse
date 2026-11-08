/**
 * The page's text/html blobs, so a navigation to one of them can be served
 * by the worker as an inline document (controlled, its subresources
 * reaching the worker) instead of the uncontrolled blob: document the
 * browser would make. Shared by every client in this bundle's realm: a blob
 * made in one realm may be navigated to from another.
 */

/** blob -> the markup the page put in it (before the shell wrapped it) */
export const htmlBlobs = new WeakMap<Blob, string>();

/** proxy-form blob: URL -> its markup and the URL its document shows */
export const htmlBlobURLs = new Map<string, { markup: string; url: string }>();
