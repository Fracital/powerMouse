// Where a bundle has the per-site legacy file system (./legacyFileSystem.ts):
// the document bundle's is a deferred part (./dom/deferred.ts), evaluated
// with a realm's first webkitRequestFileSystem or
// webkitResolveLocalFileSystemURL call, and the worker bundle's is its own.
// Each bundle's entry says which (dom/document.ts, worker/entry.ts).
import type {
	dropLegacyFileSystem,
	partitionLegacyFileSystem,
} from './legacyFileSystem';

export const legacyFileSystemParts: {
	partition?: () => typeof partitionLegacyFileSystem;
	/** (the document bundle's alone: Clear-Site-Data asks windows) */
	drop?: () => typeof dropLegacyFileSystem;
} = {};
