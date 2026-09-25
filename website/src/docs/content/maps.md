---
title: Maps
description: What a place, a map, and weather send off this device, and how you avoid that.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src/components/map/LeafletMap.tsx, src/components/map/MapKitMap.tsx, src/components/map/LocationsMapView.tsx, src/lib/mapkitLoader.ts, src/hooks/useMapSourceSettings.ts, src-tauri/src/commands/basemap.rs, src-tauri/src/utils/geocoding.rs, src-tauri/src/utils/weather.rs, src/hooks/applyEntryWeather.ts, src/hooks/useGeocodeSearch.ts, src/hooks/useEntryLocationSuggestion.ts, src/components/editor/EntryMetadataSuggestionModal.tsx, src/components/editor/Editor.tsx
---

# Maps

You can write with no place at all. A place name, the map, and the weather are separate, and none of them sends the words of the entry. The wider picture is on [How privacy works](/docs/how-privacy-works).

## A place on the entry

When you add a place, Memlore keeps the name and the coordinates with that entry, on this device. A place you already saved is kept the same way. Picking it again does not look the name up. Changing the lookup service later does not send those saved places out again.

A new entry gets a place by itself only if you turn on Auto-add default location. That uses coordinates you already saved.

## The map

The map stays empty until you pick a source in Settings, on the Location page. Until then, nobody is asked for map pictures.

- Offline map. You download one world map. The file is the same for everyone, and the download does not include your places or your coordinates. After that, the map is read on this device. Opening a place does not send a map request anywhere.
- MapTiler. You supply your own key, and it stays on this device. While a map is on screen, MapTiler is asked for the squares of that area. MapTiler can tell which part of the world you are viewing. A small preview centered on a place shows that area. MapTiler does not receive the entry, and it is not given a list of every pin.
- Apple Maps. When this choice is available, Memlore loads Apple's map (MapKit). Apple is given the area on screen, the coordinates of your pins, and the short place name on each pin. Apple does not receive the entry.

## Place names

Suggestions start when you type at least a couple of letters. The request is those words. A shorter or empty search sends nothing.

The default service is Photon, from Komoot. You pick another one in Settings, on the Location page.

- Photon receives the words you typed. When a point needs a name, it receives the coordinates instead.
- OpenStreetMap (Nominatim) is used only if you choose it. A search sends the words you typed. A point sends the coordinates. Requests are spaced about one second apart.
- Mapbox, MapTiler, and Google Places use a key you provide. A search sends the words. A point sends the coordinates. With Google, choosing a result also sends that result's place id, so the coordinates can come back.

The Check button sends the test word "London", not a place from your journal.

A photo can also carry a place. If the entry has no place yet and the photos share one point, Memlore can save those coordinates without asking a name service. If the photos have several different points, Memlore shows a choice and asks your lookup service for a name for each point when that choice appears, before you accept it. If the entry already has a place, a photo does not replace it.

## Weather

Weather comes from Open-Meteo. There is no weather switch of its own. When an entry is given coordinates, Memlore asks Open-Meteo for the weather on that entry's date. The same ask happens if you click the weather icon to refresh, and if Auto-add default location puts a place on a new entry.

The request is the coordinates. If the entry is not from today, that date is included too. Open-Meteo does not receive the entry. The short weather line is saved on the entry, so opening it later does not ask again.

A photo with one saved place can be what adds the coordinates, when the entry does not have a place yet. That is enough to ask Open-Meteo. You avoid weather by not storing coordinates, by leaving Auto-add default location off, and by not refreshing the weather icon.

## What this means for you

Map services, place lookup, and Open-Meteo only learn a place query, a point, or the area of a map you opened. They do not learn what you wrote.

- Leave the map source unset, and no map pictures are requested. The offline map is the choice that stays on this device after the download.
- Leave the search box unused, and Photon is not asked. OpenStreetMap is not used unless you select it. The exception is a photo that offers several places: those points go to the lookup service when the choice is shown.
- Leave coordinates off the entry, and Open-Meteo is not asked. A single place inside a photo can add coordinates for you if the entry has none yet.

More on what never leaves the device is in [How privacy works](/docs/how-privacy-works).
