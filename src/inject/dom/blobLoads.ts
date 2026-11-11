// The blob: URLs (the proxy's form) the inject gave elements of documents no
// service worker controls, each with the page's URL it stands for: readbacks
// of what the browser loaded (currentSrc) show the page's URL. Shared by
// every realm of the bundle.
export const blobLoads = new Map<string, string>();
/**
 * The copies of loads the worker marked as another origin's whatever their
 * URL says (OPAQUE_MARKER: redirected through another origin): a canvas
 * that draws one is tainted
 */
export const opaqueCopies = new Set<string>();
