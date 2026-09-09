/** Page-size options for the Media Gallery grid, shared by the 2-panel
 *  `MediaGalleryView` and the full-page `MediaGalleryFullView`. Default must
 *  match `uiStore.mediaPageSize` (20), and the catalog must stay in sync with
 *  the `validMediaPageSize` rehydrate guard in `src/stores/uiStore.ts`. */
export const PAGE_SIZE_OPTIONS = [12, 20, 40, 60] as const

export const PAGE_SIZE_SELECT_OPTIONS = PAGE_SIZE_OPTIONS.map((n) => ({
  value: String(n),
  label: String(n),
}))
