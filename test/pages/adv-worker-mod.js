// Module worker for adv-workers.html: import.meta and a static import.
import { depMeta, v } from './adv-worker-depmod.js';

self.onmessage = () =>
	postMessage({
		metaUrl: import.meta.url,
		resolved: import.meta.resolve
			? import.meta.resolve('./adv-worker-depmod.js')
			: 'no resolve',
		sibling: new URL('./adv-worker-depmod.js', import.meta.url).href,
		v,
		depMeta,
		href: self.location.href,
		origin: self.origin,
	});
