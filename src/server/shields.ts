// The per-site shields the controller plumbs to the service worker (the demo's
// content-blocker UI, docs/adblock.md "Per-site shields"). One store per
// server, set as a whole by the controller's `shields` RPC and consulted by
// the request path and the document builder before each privacy layer runs.
//
// A host with no entry of its own is governed by the `'*'` entry of the
// pushed list when the controller sends one: the demo's "goodies on by
// default" (the blocker on, HTTPS upgraded, third-party cookies blocked,
// fingerprint emulation on), keyed under `'*'` so it reaches every host
// without an entry each. With no `'*'` entry the no-entry host is neutral,
// as it always was (the blocker on as the controller configured it, no
// forced HTTPS upgrade, cookies as SameSite allows), so a controller that
// sends neither, every test suite's own and the demo opted out of defaults,
// is unchanged. A host's own entry overrides the default. The master toggle
// (enabled=false) turns every layer off for the host without touching STomp's
// core rewriting.
import {
	FP_DEFAULT_ON,
	FP_DEFAULT_ON_SURFACES,
	FP_SURFACES,
	sameSurfaceSet,
	shieldsDown,
	type FpSurface,
	type SiteShields,
} from '../blocker/types';

export class ShieldsStore {
	#map = new Map<string, SiteShields>();
	/**
	 * The per-session farbling seed, carried to a document (Config.fingerprintSeed)
	 * when a seeded surface is active and mixed there with the document's eTLD+1,
	 * so a site's canvas/webgl/audio noise is deterministic within itself but
	 * unique across sites. The controller owns it and sends it with the shields
	 * (kept in the host origin's storage, so it is stable across reloads, tabs and
	 * this worker restarting); until then this random fallback serves, so a worker
	 * with no controller yet still farbles consistently within its own lifetime.
	 * The page never reads it, only its noise, so it is no fingerprint of its own.
	 */
	#seed: number = (() => {
		try {
			const bytes = new Uint32Array(1);
			crypto.getRandomValues(bytes);
			return bytes[0] >>> 0;
		} catch (error) {
			return (Math.random() * 0x100000000) >>> 0;
		}
	})();
	get seed(): number {
		return this.#seed;
	}
	/**
	 * The baseline a host with no entry of its own is governed by: the `'*'`
	 * entry of the pushed list, when the controller sends one (the demo's
	 * "goodies on by default", keyed under `'*'`). Without it a no-entry host
	 * is neutral, as it always was, so a controller that sends no `'*'` entry
	 * (every test's own, the demo opted out) is unchanged.
	 */
	#default: SiteShields | undefined;

	/**
	 * Replace the whole allowlist (the controller sends it as one list). `seed`
	 * is the controller's persisted farbling seed, when it sent one: a valid
	 * 32-bit integer replaces the fallback, so every document of this worker
	 * farbles with the same per-session seed the controller keeps.
	 */
	set(list: SiteShields[], seed?: number): void {
		if (
			typeof seed === 'number' &&
			Number.isInteger(seed) &&
			seed >= 0 &&
			seed <= 0xffffffff
		)
			this.#seed = seed;
		this.#map = new Map(
			list
				.filter((entry): entry is SiteShields => !!entry && !!entry.host)
				.map((entry) => [entry.host.toLowerCase(), entry]),
		);
		this.#default = this.#map.get('*');
		this.#map.delete('*');
	}

	/**
	 * The entry that governs the host: its own, or the `'*'` default when it
	 * has none (undefined when there is neither, which is the neutral host)
	 */
	get(host: string): SiteShields | undefined {
		return (
			(host ? this.#map.get(host.toLowerCase()) : undefined) ?? this.#default
		);
	}

	/** the master toggle is down for the host: every layer off */
	down(host: string): boolean {
		return shieldsDown(this.get(host));
	}

	/**
	 * Whether the ad/tracker blocker runs for the host: off when shields are
	 * down or the blocker is in "allow all" mode. 'aggressive' and 'standard'
	 * both run it; standard leaves a first-party request to the host's own
	 * filters (`standard`).
	 */
	blocks(host: string): boolean {
		const entry = this.get(host);
		if (!entry) return true; // neutral: the blocker runs as configured
		return entry.enabled && entry.mode !== 'allow';
	}

	/**
	 * Whether the host's blocker is in standard mode, where the lists leave
	 * a first-party request alone and only the host's own filters judge it
	 * (Blocker.decide). A host with no entry is neutral: every request is
	 * judged by every list, as before shields existed.
	 */
	standard(host: string): boolean {
		const entry = this.get(host);
		return !!entry && entry.enabled && entry.mode === 'standard';
	}

	/** whether the host's requests are upgraded to HTTPS (shields-up, not 'off') */
	httpsUpgrade(host: string): boolean {
		const entry = this.get(host);
		if (!entry || shieldsDown(entry)) return false;
		// 'strict' ("only connect with HTTPS") also upgrades; its "block when
		// HTTPS is unavailable" is not distinguished from 'upgrade' yet (FINDINGS)
		return entry.httpsUpgrade === 'upgrade' || entry.httpsUpgrade === 'strict';
	}

	/**
	 * The cookie policy for the host's requests: 'allow' sends cookies as
	 * STomp would anyway (SameSite), 'third-party' drops them on cross-site
	 * requests, 'all' ("block all cookies") sends none. Neutral (no entry) and
	 * shields-down are 'allow'.
	 */
	cookies(host: string): 'all' | 'third-party' | 'allow' {
		const entry = this.get(host);
		if (!entry || shieldsDown(entry)) return 'allow';
		return entry.cookies ?? 'allow';
	}

	/**
	 * Whether the page's own scripts are blocked for the host (the inject
	 * enforces `script-src 'none'` against the page's code, src/csp.ts stage 2;
	 * STomp's own inject is exempt). Off unless an entry turns it on, and off
	 * when shields are down: destructive, so never a default.
	 */
	blockScripts(host: string): boolean {
		const entry = this.get(host);
		if (!entry || shieldsDown(entry)) return false;
		return !!entry.blockScripts;
	}

	/**
	 * The fingerprint surfaces STomp actively protects for the host (the shell
	 * carries these to the inject as `Config.fingerprintOn`, and the
	 * FingerprintModule installs a hook for each). A surface with no per-site
	 * flag takes its default (FP_DEFAULT_ON: `performanceMemory` on, every
	 * farbling/limiting surface off), so a neutral host and the "goodies on"
	 * default both protect `performanceMemory` alone. The master
	 * `blockFingerprinting` off, or shields down, protects nothing.
	 */
	fingerprintOn(host: string): FpSurface[] {
		const entry = this.get(host);
		if (!entry) return [...FP_DEFAULT_ON_SURFACES];
		if (shieldsDown(entry) || entry.blockFingerprinting === false) return [];
		const fp = entry.fingerprint;
		return FP_SURFACES.filter((surface) =>
			fp?.[surface] === undefined ? FP_DEFAULT_ON[surface] : fp[surface],
		);
	}

	/**
	 * The active set to put in a document's config, or undefined when it is the
	 * default (`performanceMemory` alone): the shell then omits `fingerprintOn`
	 * and the inject defaults to it, so a default page's config is unchanged by
	 * this feature and no field rides on every request.
	 */
	fingerprintConfig(host: string): FpSurface[] | undefined {
		const on = this.fingerprintOn(host);
		return sameSurfaceSet(on, FP_DEFAULT_ON_SURFACES) ? undefined : on;
	}

	/** whether STomp protects a given fingerprint surface for the host */
	fingerprintSurface(host: string, surface: FpSurface): boolean {
		return this.fingerprintOn(host).includes(surface);
	}

	/**
	 * Whether STomp's fingerprint protection runs for the host at all (the
	 * master): true unless every surface is off (`blockFingerprinting` off or
	 * shields down). On everywhere by default, since `performanceMemory` is.
	 */
	fingerprint(host: string): boolean {
		return this.fingerprintOn(host).length > 0;
	}
}
