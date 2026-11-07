import Client from '../Client';
import Module from '../Module';
import ProxyModule from './Proxy';

/**
 * `console.clear()` is a no-op: a page clearing the console would wipe the
 * rewriter's warnings and the host's own messages from the one console they
 * all share. Everything else about the console is left alone.
 */
export default class ConsoleModule extends Module<Client> {
	apply() {
		const proxyModule = this.client.getModule(ProxyModule)!;
		const console = this.client.global.console;
		if (!console || typeof console.clear !== 'function') return;
		console.clear = proxyModule.wrapFunction(console.clear, () => undefined);
	}
}
