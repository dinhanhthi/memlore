import { cn } from '../../lib/cn'

interface EntryCoverBackdropProps {
  src: string
  isSelected: boolean
  idleBg: string
}

/**
 * Sunken, diagonal photo card behind the row content. The photo itself is a
 * rotated, rounded card larger than its container — it overflows the row's
 * bounds and gets clipped by the row's own `overflow-hidden`, which is what
 * gives it the "tucked under the fold" look instead of a flat full-bleed
 * image. Its own mask (fading toward the text side) is static — independent
 * of hover/selected. One wash sits on top, painted from `--entry-card-fill`
 * (an interpolating @property on the row). Idle/hover/selected share that
 * color with the row background, so the junction never flashes a hard edge
 * while two opacity layers crossfade.
 *
 * Pass `ENTRY_CARD_IDLE_BG` (`var(--entry-card-idle-bg)` — selected-tab
 * in Signature, panel-2 in Clean dark). Hover wash uses
 * `--entry-card-hover-bg` (a mix of selected-tab in Signature; surface-hi
 * in Clean dark). The row fill must use the same hover token.
 *
 * The mask below is in this rotated card's own local box (`w-[88%] h-[130%]
 * right-[-18%]`), a different coordinate frame from the color washes'
 * `inset-0` on the outer `w-[58%]` container — the two percentages are not
 * directly comparable, unlike the previous flat-image version. Re-tune each
 * independently and verify visually; don't assume aligning the numbers keeps
 * them aligned.
 */
export function EntryCoverBackdrop({ src, isSelected, idleBg }: EntryCoverBackdropProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 z-0 w-[58%] overflow-visible"
    >
      <div
        className={cn(
          'absolute top-1/2 right-[-18%] h-[130%] w-[88%] -translate-y-1/2',
          'origin-center rotate-11 rounded-[14px]',
          // The floating drop shadow is a `filter`, not `box-shadow`: this
          // element is masked (see below), and mask-repeat tiles the mask
          // over any box-shadow painted outside the border box, producing a
          // hard-edged, un-faded shadow band right where the mask is
          // supposed to fade to transparent. `drop-shadow` derives the
          // shadow from the already-masked, already-rotated alpha silhouette
          // instead, so it fades out exactly where the card does. The inset
          // rim stays a real box-shadow — inset shadows never paint outside
          // the border box, so they're unaffected by the mask.
          'shadow-[inset_0_0_0_1px_var(--shadow-card-rim)] drop-shadow-(--elev-3)',
          'transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
          isSelected && 'scale-[1.02] rotate-9',
        )}
        style={{
          WebkitMaskImage: 'linear-gradient(to left, #000 0%, #000 42%, transparent 92%)',
          maskImage: 'linear-gradient(to left, #000 0%, #000 42%, transparent 92%)',
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          className="size-full object-cover opacity-[0.72] saturate-[0.92]"
        />
        {/* Multiply-darken by a fixed 24%, not a shift toward the app's own
            background color — matching against `--color-app` looks right in
            dark mode (a near-black app bg) but nearly no-ops in light mode
            (a near-white one), since a multiply blend's strength scales with
            how dark the blended color is. A flat black tint darkens by the
            same amount in both themes. 24% reproduces this file's previous
            dark-mode look almost exactly (verified: blending 25% of
            `--color-app`'s dark value against the photo darkens it ~23.7%). */}
        <div className="absolute inset-0 bg-black/24 mix-blend-multiply" />
      </div>

      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(to right, var(--entry-card-fill, ${idleBg}) 0%, var(--entry-card-fill, ${idleBg}) 22%, color-mix(in oklab, var(--entry-card-fill, ${idleBg}) 70%, transparent) 48%, transparent 76%)`,
        }}
      />
    </div>
  )
}
