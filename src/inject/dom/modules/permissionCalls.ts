// The Permissions module's calls a page rarely makes (./Permissions.ts):
// getUserMedia's request, the ids in a device's constraints, a request for
// the position and for notifications. A deferred part of the document
// bundle (../deferredParts.ts): the hooks stay in the bundle, in place
// before the page's first script, and hand over what they took then; this
// runs only once a page asks for a device, an output, the position or
// notifications, so its top level reads no global.
import type {
	MediaVerdict,
	PermissionState,
} from '../../../transport/messages';
import { withStack } from '../../nativeErrors';
import type { LazyMap } from '../../ownCollections';
import { isObject, type DeviceIds } from './Permissions';

type Request = (
	names: string[],
) => Promise<
	| { call: true; settle: (granted: boolean | null) => Promise<void> }
	| { call: false; dismissed: boolean }
>;

/** what the module hands userMediaCall: this document's own, taken before the page ran */
export interface UserMediaRealm {
	global: typeof globalThis;
	/** this document's own MediaDevices (absent outside a secure context) */
	mediaDevices: unknown;
	enumerate: MediaDevices['enumerateDevices'] | undefined;
	kindOf: (() => unknown) | undefined;
	Overconstrained: new (constraint: string, message?: string) => Error;
	isArray: (value: unknown) => value is unknown[];
	request: Request;
	allowed: (name: string) => boolean;
	browserRefuses: (name: string) => boolean;
	direct: (names: string[]) => Promise<boolean>;
	verdict: (constraints: unknown) => Promise<MediaVerdict | null>;
	deviceIds: DeviceIds;
}

/**
 * getUserMedia, asking for the camera and the microphone it names first
 * (PermissionsModule.userMedia says in what order): the hook's body
 */
export function userMediaCall({
	global,
	mediaDevices,
	enumerate,
	kindOf,
	Overconstrained,
	isArray,
	request,
	allowed,
	browserRefuses,
	direct,
	verdict,
	deviceIds,
}: UserMediaRealm) {
	const KIND: Record<string, string> = {
		camera: 'videoinput',
		microphone: 'audioinput',
	};
	// whether the browser has no device for one of `names`: its list
	// names every kind it has, whatever the policy and the permission
	const missing = async (that: unknown, names: string[]) => {
		if (!enumerate || !kindOf) return false;
		try {
			const kinds = new Set<string>();
			for (const device of (await Reflect.apply(
				enumerate,
				that,
				[],
			)) as MediaDeviceInfo[])
				kinds.add(Reflect.apply(kindOf, device, []) as string);
			return names.some((name) => !kinds.has(KIND[name]));
		} catch (error) {
			// no list: the browser's own call says what is wrong
			return false;
		}
	};
	// the constraints as plain data a message carries, read as the browser
	// reads them (inherited members too); undefined when they hold
	// anything else
	const plainOf = (value: unknown): unknown => {
		const copy = (from: unknown, depth: number): unknown => {
			if (from === null || typeof from !== 'object') {
				if (
					typeof from === 'function' ||
					typeof from === 'symbol' ||
					typeof from === 'bigint'
				)
					throw new RangeError('not plain');
				return from;
			}
			if (depth > 8) throw new RangeError('not plain');
			if (isArray(from)) {
				const list: unknown[] = [];
				for (let i = 0; i < from.length; i++)
					list[i] = copy(from[i], depth + 1);
				return list;
			}
			const out: Record<string, unknown> = {};
			for (const key in from)
				out[key] = copy((from as Record<string, unknown>)[key], depth + 1);
			return out;
		};
		try {
			return copy(value, 0);
		} catch (error) {
			return undefined;
		}
	};
	return async (target: Function, that: unknown, args: unknown[]) => {
		// (a receiver that is not this document's MediaDevices is
		// the browser's to refuse, before anything is awaited)
		if (that !== mediaDevices) return await Reflect.apply(target, that, args);
		// the ids the page names are its site's: the browser's own go in
		const constraints = (await deviceIds.incoming(args[0])) as
			MediaStreamConstraints | undefined;
		if (args.length) args[0] = constraints;
		// the kinds asked for, as the browser reads the members: null
		// and any object are a set of constraints (measured: `audio:
		// null` opens the microphone), anything else a boolean
		const asks = (member: unknown) =>
			member === null || isObject(member) || !!member;
		const names: string[] = [];
		if (isObject(constraints)) {
			if (asks(constraints.video)) names.push('camera');
			if (asks(constraints.audio)) names.push('microphone');
		}
		// the browser rejects a request for nothing with its own TypeError
		if (!names.length) return Reflect.apply(target, that, args);
		// kinds the browser's own policy refuses this document (the
		// host's Permissions-Policy, the allow of a frame above):
		// its call can neither prompt nor open a device, and answers
		// as it does natively under that policy, in its order and
		// with its line in this document's console
		if (names.every(browserRefuses)) return Reflect.apply(target, that, args);
		const refused = (dismissed = false) =>
			withStack(
				new global.DOMException(
					dismissed ? 'Permission dismissed' : 'Permission denied',
					'NotAllowedError',
				),
			);
		// what the browser answers before its policy and its permission
		// (in a frame of the controller's document: `elsewhere`)
		const checks = async () => {
			const plain = plainOf(constraints);
			// kinds with no constraints on them (true, null): no set
			// of them is malformed and none can fail a device, so only
			// a missing device ends the request before the policy.
			// The controller is not asked, and its console gets no
			// line
			const bare =
				plain !== undefined &&
				!isObject((plain as MediaStreamConstraints).audio) &&
				!isObject((plain as MediaStreamConstraints).video);
			const here =
				plain === undefined || bare ? null : deviceIds.elsewhere(plain);
			const first = here ? await verdict(plain) : null;
			if (first?.name === 'TypeError')
				throw new global.TypeError(first.message);
			if (first?.name === 'OverconstrainedError')
				throw new Overconstrained(here!(first.constraint ?? ''), first.message);
			if (
				first?.name === 'NotFoundError' ||
				// no verdict (none needed, a host without the check,
				// constraints no message carries): the devices at least
				(first?.name !== 'NotAllowedError' && (await missing(that, names)))
			)
				throw withStack(
					new global.DOMException(
						'Requested device not found',
						'NotFoundError',
					),
				);
		};
		// a request that goes straight to the browser's call gets the
		// browser's order from it; one this module answers, or the
		// host is asked about, gets those checks first
		const straight = await direct(names);
		if (!straight) {
			await checks();
			if (!names.every(allowed)) throw refused();
		}
		const answer = await request(names);
		if (!answer.call) {
			// refused after all (the site was answered meanwhile)
			if (straight) await checks();
			throw refused(answer.dismissed);
		}
		try {
			const stream = await Reflect.apply(target, that, args);
			void answer.settle(true);
			// what its tracks say of their device is read at once
			await deviceIds.learn();
			return stream;
		} catch (error) {
			// the site's states are what the refusal made them by the
			// time the page hears of it, as the browser's are
			await answer.settle(
				(error as DOMException)?.name === 'NotAllowedError' ? false : null,
			);
			throw error;
		}
	};
}

type IdKey = 'deviceId' | 'groupId';

/** what the module hands deviceConstraints: its device ids' state (PermissionsModule.devices) */
export interface DeviceState {
	global: typeof globalThis;
	isArray: (value: unknown) => value is unknown[];
	/** the ids that name the same device everywhere */
	LITERAL: Set<string>;
	shownOf: Record<IdKey, Map<string, string>>;
	realOf: Record<IdKey, Map<string, string>>;
	/** what the page named that is no id of its site, by what the browser was told */
	written: LazyMap<string, string>;
	toShown: (key: IdKey, real: unknown) => unknown;
	/** the browser's ids of each kind, and of each group's members by kind, as last read */
	inputs: () => Record<string, Set<string>>;
	groups: () => Map<string, Record<string, string[]>>;
	learn: () => Promise<void>;
	refresh: () => Promise<void>;
	mayRead: (name: string) => boolean;
	speakers: () => boolean;
	elementSinkId: Function | undefined;
	contextSinkId: Function | undefined;
}

/**
 * The ids in what a page hands the browser and reads back of a track or an
 * output (PermissionsModule.devices): a track's constraints, settings and
 * capabilities, setSinkId, an AudioContext's sinkId and getUserMedia's
 * constraints, which only a page that uses a device or an output asks for
 */
export function deviceConstraints({
	global,
	isArray,
	LITERAL,
	shownOf,
	realOf,
	written,
	toShown,
	inputs: inputsOf,
	groups: groupsOf,
	learn,
	refresh,
	mayRead,
	speakers,
	elementSinkId,
	contextSinkId,
}: DeviceState) {
	// an id that is not this site's stays what it is, and names nothing:
	// the browser's own id, which a page was never shown, must not either
	const toReal = (key: IdKey, shown: unknown): unknown => {
		if (typeof shown !== 'string' || LITERAL.has(shown)) return shown;
		const real = realOf[key].get(shown);
		if (real !== undefined) return real;
		const told = shownOf[key].has(shown) ? `${shown.slice(1)}0` : shown;
		written.set(told, shown);
		return told;
	};

	// a constraint's ids, one way or the other: a string, a list, or
	// { exact, ideal } of either. A changed object is a new one over the
	// page's (its other members are read from the page's as they were)
	const over = (value: object, changes: Record<string, unknown>) => {
		const out = Object.create(value) as Record<string, unknown>;
		for (const name in changes)
			Reflect.defineProperty(out, name, {
				value: changes[name],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		return out;
	};
	type Turn = (key: IdKey, id: unknown) => unknown;
	const constrained = (key: IdKey, value: unknown, turn: Turn): unknown => {
		if (isArray(value)) {
			const out: unknown[] = [];
			for (let i = 0; i < value.length; i++) out[i] = turn(key, value[i]);
			return out;
		}
		if (value === null || typeof value !== 'object') return turn(key, value);
		const changes: Record<string, unknown> = {};
		for (const name of ['exact', 'ideal'])
			if (name in value)
				changes[name] = constrained(
					key,
					(value as Record<string, unknown>)[name],
					turn,
				);
		return over(value, changes);
	};
	const names = (set: unknown): boolean =>
		set !== null &&
		typeof set === 'object' &&
		('deviceId' in set ||
			'groupId' in set ||
			'advanced' in set ||
			'mandatory' in set ||
			'optional' in set);
	/** a track's constraints (or one of its `advanced` sets) with its ids turned */
	const track = (set: unknown, turn: Turn): unknown => {
		if (!names(set)) return set;
		const from = set as Record<string, unknown>;
		const changes: Record<string, unknown> = {};
		for (const key of ['deviceId', 'groupId'] as IdKey[])
			if (key in from) changes[key] = constrained(key, from[key], turn);
		// Chrome's older spelling: mandatory: { sourceId }, optional: [{ sourceId }]
		const source = (entry: unknown) =>
			entry !== null && typeof entry === 'object' && 'sourceId' in entry
				? over(entry, {
						sourceId: turn(
							'deviceId',
							(entry as Record<string, unknown>).sourceId,
						),
					})
				: entry;
		if ('mandatory' in from) changes.mandatory = source(from.mandatory);
		for (const list of ['advanced', 'optional'])
			if (list in from) {
				const entries = from[list];
				if (isArray(entries)) {
					const out: unknown[] = [];
					for (let i = 0; i < entries.length; i++)
						out[i] =
							list === 'advanced'
								? track(entries[i], turn)
								: source(entries[i]);
					changes[list] = out;
				} else changes[list] = entries;
			}
		return over(from, changes);
	};
	/** the same, written into the browser's own answer */
	const shownIn = (value: Record<string, unknown> | undefined) => {
		if (value === null || typeof value !== 'object') return value;
		for (const key of ['deviceId', 'groupId'] as IdKey[])
			if (key in value) {
				const ids = value[key];
				if (isArray(ids))
					for (let i = 0; i < ids.length; i++) ids[i] = toShown(key, ids[i]);
				else if (ids !== null && typeof ids === 'object') {
					for (const name of ['exact', 'ideal'])
						if (name in ids)
							(ids as Record<string, unknown>)[name] = isArray(
								(ids as Record<string, unknown>)[name],
							)
								? ((ids as Record<string, unknown>)[name] as unknown[]).map(
										(id) => toShown(key, id),
									)
								: toShown(key, (ids as Record<string, unknown>)[name]);
				} else value[key] = toShown(key, ids);
			}
		if (isArray(value.advanced))
			for (const set of value.advanced as Record<string, unknown>[])
				shownIn(set);
		return value;
	};

	// an output is named by its id too. Chrome lets a site choose one only
	// where it may use the microphone: an element's setSinkId is refused
	// (SecurityError) for any id but the default's, and an AudioContext
	// finds no device but '' (measured, with the messages)
	const sink = async (
		context: boolean,
		native: Function,
		that: unknown,
		args: unknown[],
	) => {
		// (a receiver that is no context or element is the browser's
		// to refuse, before the policy is looked at: its own getter
		// tells)
		const brand = context ? contextSinkId : elementSinkId;
		if (brand)
			try {
				Reflect.apply(brand, that, []);
			} catch (error) {
				return await Reflect.apply(native, that, args);
			}
		const id: unknown = args[0];
		// the policy comes first, whatever is asked for
		if (context && args.length && !speakers())
			throw withStack(
				new global.DOMException(
					'Permissions-Policy disallows speaker selection.',
					'NotAllowedError',
				),
			);
		if (typeof id === 'string' && (context ? id !== '' : !LITERAL.has(id))) {
			const missing = () =>
				withStack(
					new global.DOMException(
						context
							? `AudioContext.setSinkId(): failed: the device ${id} is not found.`
							: 'Requested device not found',
						'NotFoundError',
					),
				);
			await refresh();
			if (!mayRead('microphone'))
				throw context
					? missing()
					: withStack(
							new global.DOMException(
								'No permission to use requested device',
								'SecurityError',
							),
						);
			if (!LITERAL.has(id)) {
				// an id that is not this site's names no device, whatever
				// the browser would say of it
				await learn();
				const real = realOf.deviceId.get(id);
				if (real === undefined) throw missing();
				args[0] = real;
			}
		}
		return Reflect.apply(native, that, args);
	};
	// the ids a constraint requires, as the browser reads them: text
	const exactOf = (value: unknown): string[] | null => {
		if (value === null || typeof value !== 'object' || isArray(value))
			return null;
		const exact = (value as Record<string, unknown>).exact;
		if (exact === undefined || exact === null) return null;
		const out: string[] = [];
		if (isArray(exact))
			for (let i = 0; i < exact.length; i++) out[i] = `${exact[i]}`;
		else out[0] = `${exact}`;
		return out.length ? out : null;
	};
	const KINDS = [
		['audio', 'audioinput'],
		['video', 'videoinput'],
	];
	// names no device anywhere: only ever said to the other document
	const NO_DEVICE = 'no device of that group';
	const elsewhere = (plain: unknown) => {
		// the kinds whose deviceId now stands for a groupId
		const stands: string[] = [];
		const known = (kind: string, id: string) =>
			inputsOf()[kind]?.has(id) || LITERAL.has(id);
		const sets = (
			plain !== null && typeof plain === 'object' ? plain : {}
		) as Record<string, Record<string, unknown> | null | undefined>;
		for (const [member, kind] of KINDS) {
			const set = sets[member];
			if (set === null || typeof set !== 'object') continue;
			// an advanced set fails no request
			if (isArray(set.advanced))
				for (const entry of set.advanced)
					if (entry !== null && typeof entry === 'object')
						delete (entry as Record<string, unknown>).groupId;
			const required = exactOf(set.groupId);
			delete set.groupId;
			if (!required) continue;
			const own = exactOf(set.deviceId);
			// a deviceId that names no device fails first, as it is
			if (own && !own.some((id) => known(kind, id))) continue;
			const ids: string[] = [];
			for (const group of required)
				for (const id of groupsOf().get(group)?.[kind] ?? [])
					if (!own || own.includes(id)) ids.push(id);
			set.deviceId = { exact: ids.length ? ids : [NO_DEVICE] };
			stands.push(member);
		}
		return (constraint: string) => {
			if (constraint !== 'deviceId' || !stands.length) return constraint;
			// the browser settles audio before video
			for (const [member, kind] of KINDS) {
				const required = exactOf(sets[member]?.deviceId);
				if (required && !required.some((id) => known(kind, id)))
					return stands.includes(member) ? 'groupId' : constraint;
			}
			return constraint;
		};
	};

	return {
		over,
		names,
		track,
		toReal,
		shownIn,
		sink,
		elsewhere,
		/** getUserMedia's constraints with the site's ids turned into the browser's */
		incoming: async (constraints: unknown) => {
			if (!isObject(constraints)) return constraints;
			const { audio, video } = constraints as Record<string, unknown>;
			if (names(audio) || names(video)) await learn();
			return over(constraints, {
				audio: track(audio, toReal),
				video: track(video, toReal),
			});
		},
	};
}

export type DeviceConstraints = ReturnType<typeof deviceConstraints>;

/** what the module hands positionCall, taken when the page first read navigator.geolocation */
export interface PositionRealm {
	global: typeof globalThis;
	ErrorType: Function;
	request: Request;
	allowed: (name: string) => boolean;
}

/**
 * getCurrentPosition and watchPosition, asked first (PermissionsModule.
 * geolocation): `start` is the browser's own call with the callbacks given
 */
export function positionCall({
	global,
	ErrorType,
	request,
	allowed,
}: PositionRealm) {
	// what the browser hands an error callback: code 1 with its message
	const denial = (message: string) =>
		Object.create(ErrorType.prototype, {
			code: { value: 1 },
			message: { value: message },
		});
	const POLICY =
		'Geolocation has been disabled in this document by permissions policy.';
	const DENIED = 'User denied Geolocation';
	return (
		that: Geolocation,
		args: unknown[],
		start: (success: unknown, failure: unknown) => void,
	) => {
		const [success, failure] = args as [
			((position: GeolocationPosition) => void) | undefined,
			((error: GeolocationPositionError) => void) | null | undefined,
		];
		const fail = (message: string) => {
			if (typeof failure === 'function')
				global.setTimeout(() => failure(denial(message)), 0);
		};
		if (!allowed('geolocation')) return fail(POLICY);
		void request(['geolocation']).then((answer) => {
			if (!answer.call) return fail(DENIED);
			let settled = false;
			const settle = (granted: boolean | null) => {
				if (settled) return;
				settled = true;
				void answer.settle(granted);
			};
			start(
				(position: GeolocationPosition) => {
					settle(true);
					if (typeof success === 'function') success(position);
				},
				(error: GeolocationPositionError) => {
					settle(error?.code === 1 ? false : null);
					if (typeof failure === 'function') failure(error);
				},
			);
		});
		void that;
	};
}

/** what the module hands notificationCall */
export interface NotificationRealm {
	request: Request;
	allowed: (name: string) => boolean;
	siteState: (name: string) => PermissionState;
	toNotification: (state: PermissionState) => NotificationPermission;
}

/** Notification.requestPermission, asked first: the hook's body */
export function notificationCall({
	request,
	allowed,
	siteState,
	toNotification,
}: NotificationRealm) {
	return (target: Function, that: unknown, args: unknown[]) => {
		const callback = args[0];
		const decided = (async (): Promise<NotificationPermission> => {
			if (!allowed('notifications')) return 'denied';
			const answer = await request(['notifications']);
			if (!answer.call)
				return answer.dismissed
					? 'default'
					: toNotification(siteState('notifications'));
			const result = (await Reflect.apply(
				target,
				that,
				[],
			)) as NotificationPermission;
			await answer.settle(
				result === 'granted' ? true : result === 'denied' ? false : null,
			);
			return result;
		})();
		return decided.then((result) => {
			if (typeof callback === 'function') callback(result);
			return result;
		});
	};
}
