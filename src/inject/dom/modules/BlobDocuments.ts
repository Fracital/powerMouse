import { setXMLShell } from '../../../rewriteHTML';
import Module from '../../Module';
import DocumentClient from '../Client';
import { deferred } from '../deferred';

/**
 * A document, a script or a stylesheet the page builds itself in a Blob
 * (`new Blob([html], { type: 'text/html' })`, a slice, a Response's) holds
 * bytes nothing fetched, so the service worker never sees them. The Blob
 * stays as the page made it (its size and its bytes read back as natively);
 * a load of its blob: URL is routed where it runs (src/inject/modules/
 * ObjectURL.ts): the worker reads the Blob and rewrites it like a fetched
 * one. A data: XML document gets the XML shell here.
 */
export default class BlobDocumentsModule extends Module<DocumentClient> {
	/**
	 * The realm's own Blob, for the client's own blobs (an XMLHttpRequest's
	 * blob response), which hold bytes the page received
	 */
	nativeBlob!: typeof Blob;
	apply() {
		this.nativeBlob = this.client.global.Blob;
		// a data: XML document gets the XML shell, a deferred part
		setXMLShell((data, url, config, mime) =>
			deferred('modifyXML')(data, url, config, mime),
		);
	}
}
