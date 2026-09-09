// ESM shim for use-sync-external-store — React 19 ships useSyncExternalStore natively.
// This alias prevents the CJS-only package from emitting require('react') calls
// that break the design-sync IIFE bundle.
export { useSyncExternalStore } from 'react'
