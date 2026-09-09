import { useEffect } from 'react'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { buildPinIcon, buildClusterIcon } from './markerIcons'
import type { MapPin } from '../../types/map'

/**
 * Imperatively mounts `L.markerClusterGroup` on a raw Leaflet map. Pins
 * collapse into a count-badged marker at zoom-out and expand to per-pin
 * markers when the user zooms in. Co-located pins (identical lat/lng) stay
 * clustered at all zoom levels — matching the requested "one image per
 * location, even when fully zoomed in" behaviour.
 *
 * `map` is `null` until the parent has created `L.map()`; the effect no-ops
 * until then. Re-running whenever `pins` changes keeps the cluster group in
 * sync with the source data without re-creating the map.
 */
export function useMarkerCluster(
  map: L.Map | null,
  pins: MapPin[],
  onPinClick: (pin: MapPin) => void,
) {
  useEffect(() => {
    if (!map) return

    // `disableClusteringAtZoom` is *not* set: even at max zoom we still want
    // co-located pins to share one marker (so the same physical place never
    // splits into two overlapping markers). `maxClusterRadius` set tight so
    // distinct nearby spots stay distinct once the user zooms in close.
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: false,
      maxClusterRadius: (zoom: number) => (zoom >= 15 ? 1 : 60),
      iconCreateFunction: (c) => {
        // Use the first child's thumbnail as the cluster's hero image so
        // the cluster icon visually previews what's inside.
        const markers = c.getAllChildMarkers() as L.Marker[]
        const hero = markers
          .map((m) => (m.options as { xjThumbnailPath?: string | null }).xjThumbnailPath ?? null)
          .find((t): t is string => Boolean(t))
        return buildClusterIcon(c.getChildCount(), hero ?? null)
      },
    })

    for (const pin of pins) {
      const marker = L.marker([pin.latitude, pin.longitude], {
        icon: buildPinIcon(pin),
        // Stashed on the marker so iconCreateFunction can recover a
        // representative thumbnail without re-keying off pin id.
        ...({ xjThumbnailPath: pin.thumbnailPath } as L.MarkerOptions),
      })
      marker.on('click', () => onPinClick(pin))
      // Accessibility: a screen reader on the marker reads the entry label
      // when present, otherwise a generic kind-tagged hint.
      const altText = pin.label ?? (pin.kind === 'photo' ? 'Photo location' : 'Entry location')
      marker.options.alt = altText
      cluster.addLayer(marker)
    }

    map.addLayer(cluster)
    return () => {
      map.removeLayer(cluster)
    }
  }, [map, pins, onPinClick])
}
