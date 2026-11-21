import Module from '../../Module';
import type DocumentClient from '../Client';
import { deferred } from '../deferred';

/**
 * Just call stomp (src/controller/justCallStomp.ts): the document was
 * written into its frame's call page, whose host keeps the tab's session
 * history. Its hooks are a deferred part (../calledHooks.ts), which no
 * other document evaluates: the module is added only to a called document.
 */
export default class CalledModule extends Module<DocumentClient> {
	apply() {
		deferred('calledHooks')(this.client);
	}
}
