// The natives around the hooks: property descriptors, Reflect, Proxy
// receivers, prototype getters on the live objects, own-key enumeration and
// the fingerprints a hooked native leaves (test/pages/adv-protos.html).
import { runGroup } from '../adversarial.mjs';

await runGroup('protos', {
	'Reflect.get(window, top)': 'eval-reflect-get-leak',
	'gOPD(window, top)': 'eval-gopd-leak',
	'gOPD(window, location)': 'eval-gopd-leak',
	'gOPD(window, eval).value === eval': 'eval-indirect-identity-all-views',
	'toString.call(location)': 'location-brand',
	'location instanceof Location': 'location-brand',
	'location.constructor === Location': 'location-brand',
	'getOwnPropertyNames(location)': 'location-own-property-names',
	'eval.name/length': 'eval-indirect-function-shape',
	'eval has no prototype': 'eval-indirect-function-shape',
	'getOwnPropertyNames(eval)': 'eval-indirect-function-shape',
	'window.eval === (0,eval)': 'eval-indirect-identity-stable',
	'window.eval === eval(eval)': 'eval-indirect-identity-all-views',
	'String(eval)': 'eval-indirect-tostring-preserves-name',
	'toString eval': 'eval-indirect-tostring-native',
	'toString Function.prototype.toString': 'eval-function-tostring-no-leak',
	'plain object location/top/parent/eval':
		'unsafeprops-read-write-plain-object',
	'proxy get trap sees real keys': 'unsafeprops-proxy-get-trap-key',
	'proxy set trap sees real keys': 'unsafeprops-proxy-set-trap-key',
	'null-prototype object keys': 'unsafeprops-null-prototype',
	'delete o.location': 'unsafeprops-delete',
	'frozen strict assign throws': 'unsafeprops-frozen-strict-assign',
	'super.location skips own property': 'unsafeprops-super',
	'accessor invoked once': 'unsafeprops-accessor-invocation-count',
	'DOMRect.top': 'unsafeprops-host-objects',
});
