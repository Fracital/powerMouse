import Module from '../../Module';
import DocumentClient from '../Client';

/**
 * A document, a script or a stylesheet the page builds itself in a Blob
 * (`new Blob([html], { type: 'text/html' })`, a slice, a Response's) holds
 * bytes nothing fetched, so the service worker never sees them. The Blob
 * stays as the page made it (its size and its bytes read back as natively);
 * a load of its blob: URL is routed where it runs (src/inject/modules/
 * ObjectURL.ts): the worker reads the Blob and rewrites it like a fetched
 * one.
 */
export default class BlobDocumentsModule extends Module<DocumentClient> {
	/**
	 * The realm's own Blob, for the client's own blobs (an XMLHttpRequest's
	 * blob response), which hold bytes the page received
	 */
	nativeBlob!: typeof Blob;
	apply() {
		this.nativeBlob = this.client.global.Blob;
	}
}
