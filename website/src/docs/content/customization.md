---
title: Customization
description: How you change the look of the app, and which of those choices stay on this device.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src/lib/designSystem.ts, src/lib/themeConfig.ts, src/stores/uiStore.ts, src/hooks/useTheme.ts, src/hooks/useThemeCustomization.ts, src/components/onboarding/steps/ThemeStep.tsx, src/lib/themeColors.ts, src/styles/fonts.ts, src-tauri/src/commands/fonts.rs, src-tauri/src/db/queries.rs
---

# Customization

Changing how Memlore looks never changes or uploads your journal.

:::diagram customization

## Three design systems

- Pick Signature, Clean, or Clay in Settings, under Appearance.
- Each one has a light mode and a dark mode.
- Clay in dark is where the app starts.
- Clean also lets you make corners sharper or rounder.

## Signature's dark canvases

- Signature's dark mode has three canvases: Deep (the default), Soft, and Lumen.
- They restyle dark only; there is no light Soft or light Lumen.
- Clean and Clay do not use them.

## Writing font

- Built-in fonts (Nunito, Geist, Inter, Open Sans, Fuzzy Bubbles) send nothing anywhere.
- The Google Fonts picker asks Google for the list if it is not saved here.
- Applying a Google Font downloads that file from Google and keeps it on this device.
- Google sees each request directly, with no Memlore server in between.

## What syncs

- Stays on this device: the look, light or dark, the canvas, corners, and interface size.
- Copied with sync on, sealed first: accent color, built-in font with size and contrast, sidebar and list layout.
- The Google Font file is not copied; another device uses a built-in font instead.
