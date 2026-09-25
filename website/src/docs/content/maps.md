---
title: Maps
description: What a place, a map, and weather send off this device, and how you avoid that.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src/components/map/LeafletMap.tsx, src/components/map/MapKitMap.tsx, src/components/map/LocationsMapView.tsx, src/lib/mapkitLoader.ts, src/hooks/useMapSourceSettings.ts, src-tauri/src/commands/basemap.rs, src-tauri/src/utils/geocoding.rs, src-tauri/src/utils/weather.rs, src/hooks/applyEntryWeather.ts, src/hooks/useGeocodeSearch.ts, src/hooks/useEntryLocationSuggestion.ts, src/components/editor/EntryMetadataSuggestionModal.tsx, src/components/editor/Editor.tsx
---

# Maps

Place names, the map, and weather are separate, and none of them receives the words of an entry.

:::diagram maps

## Places

- A place keeps its name and coordinates with the entry, on this device.
- New entries get a place only if you turn on Auto-add default location.

## The map

- The map stays empty until you pick a source in Settings > Location.
- Offline map: one world file, the same for everyone; no places or coordinates are sent.
- MapTiler (your own key): gets the area on screen while a map is shown.
- Apple Maps, when available: gets the area on screen, pin coordinates, and each pin's short place name.

## Place name lookup

- Typed searches send nothing until a couple of letters.
- Photon (Komoot) is the default; it gets your typed words, or coordinates that need a name.
- Nominatim, Mapbox, MapTiler, or Google Places get the same, only if you choose one.
- Google also gets the place id of the result you pick.
- If photos offer several places, the lookup service is asked for each point before you accept.

## Weather

- Open-Meteo gets the coordinates, plus the date if the entry is not from today.
- It is asked when an entry gets coordinates, on auto-add, or when you refresh weather.
- There is no separate weather switch; leave coordinates off to avoid it.
- A photo with one saved place can add coordinates, which is enough to ask.
