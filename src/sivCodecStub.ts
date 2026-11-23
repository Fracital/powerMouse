// Build-time stand-in for ./sivCodec.ts in the light inject bundles
// (injectDocument, injectWorker in build.js), as ./cryptoStub.ts is for
// crypto-js. The service worker never hands those bundles to a document or
// a worker of the siv codec (src/routeURL.ts cryptoInject), so the class is
// never made there; it is a class all the same, so that `instanceof` (the
// config's codecType) answers false rather than throwing, and the codec's
// code costs no frame of the common deployment anything (frame-cost). Made
// all the same, it throws cryptoStub's error.
import GenericCodec from './Codecs';
import unavailable from './cryptoStub';

export class SIVCodec extends GenericCodec {
	constructor(key: string) {
		super(key);
		unavailable();
	}
}
