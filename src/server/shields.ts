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
import { shieldsDown, type SiteShields } from '../blocker/types';

export class ShieldsStore {
	#map = new Map<string, SiteShields>();
	/**
	 * The baseline a host with no entry of its own is governed by: the `'*'`
	 * entry of the pushed list, when the controller sends one (the demo's
	 * "goodies on by default", keyed under `'*'`). Without it a no-entry host
	 * is neutral, as it always was, so a controller that sends no `'*'` entry
	 * (every test's own, the demo opted out) is unchanged.
	 */
	#default: SiteShields | undefined;

	/** replace the whole allowlist (the controller sends it as one list) */
	set(list: SiteShields[]): void {
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
	 * both block; the crate is not asked to tell them apart yet (see FINDINGS).
	 */
	blocks(host: string): boolean {
		const entry = this.get(host);
		if (!entry) return true; // neutral: the blocker runs as configured
		return entry.enabled && entry.mode !== 'allow';
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
	 * Whether STomp's fingerprint emulation runs for the host (the Memory
	 * module's per-site performance.memory, docs/process-model.md): on
	 * everywhere by default, off only where an entry turns `blockFingerprinting`
	 * off or shields are down, so that site reads the renderer's native values.
	 * The shell carries the inverse to the inject as `noFingerprint`.
	 */
	fingerprint(host: string): boolean {
		const entry = this.get(host);
		if (!entry) return true;
		if (shieldsDown(entry)) return false;
		return entry.blockFingerprinting !== false;
	}
}
