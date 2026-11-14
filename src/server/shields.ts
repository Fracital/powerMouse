// The per-site shields the controller plumbs to the service worker (the demo's
// content-blocker UI, docs/adblock.md "Per-site shields"). One store per
// server, set as a whole by the controller's `shields` RPC and consulted by
// the request path and the document builder before each privacy layer runs.
//
// A host with no entry is neutral: STomp behaves as it would with no shields
// at all (the blocker on as the controller configured it, no forced HTTPS
// upgrade, cookies as SameSite allows), so a controller that never sets
// shields, every test suite's, is unchanged. The demo writes an entry the
// first time a tab lands on a host, which is when its "goodies on" defaults
// take effect. The master toggle (enabled=false) turns every layer off for
// the host without touching STomp's core rewriting.
import { shieldsDown, type SiteShields } from '../blocker/types';

export class ShieldsStore {
	#map = new Map<string, SiteShields>();

	/** replace the whole allowlist (the controller sends it as one list) */
	set(list: SiteShields[]): void {
		this.#map = new Map(
			list
				.filter((entry): entry is SiteShields => !!entry && !!entry.host)
				.map((entry) => [entry.host.toLowerCase(), entry]),
		);
	}

	get(host: string): SiteShields | undefined {
		return host ? this.#map.get(host.toLowerCase()) : undefined;
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

	/** framework flag: block the page's own scripts (enforcement is phase 2) */
	blockScripts(host: string): boolean {
		const entry = this.get(host);
		if (!entry || shieldsDown(entry)) return false;
		return !!entry.blockScripts;
	}
}
