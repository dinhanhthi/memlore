---
title: Customization
description: How you change the look of the app, and which of those choices stay on this device.
updated: 2026-09-25
sources: website/src/legal/privacy.md, src/lib/designSystem.ts, src/lib/themeConfig.ts, src/stores/uiStore.ts, src/hooks/useTheme.ts, src/hooks/useThemeCustomization.ts, src/components/onboarding/steps/ThemeStep.tsx, src/lib/themeColors.ts, src/styles/fonts.ts, src-tauri/src/commands/fonts.rs, src-tauri/src/db/queries.rs
---

# Customization

You can change how Memlore looks without changing a word of your journal. Think of the three looks as three outfits for the same notebook. The pages stay yours. Only the clothes change.

## Three looks

In Settings, under Appearance, you pick one look. Settings calls these design systems. Each one has a light mode and a dark mode.

- **Signature** is the expressive Memlore look.
- **Clean** is a plain, high-contrast look. On Clean you can also make corners sharper or rounder.
- **Clay** is the look the app starts on, in dark, until you choose something else.

Menus and buttons follow the look you picked. The text you write inside an entry is a separate choice.

## Light, dark, and the dark canvas

You can set light or dark on Signature, Clean, and Clay. That choice stays on this device.

Signature's dark mode has three canvases. They restyle the dark picture only. There is no light Soft, and there is no light Lumen.

- **Deep** is the usual dark charcoal, and it is the one you start with.
- **Soft** lifts those dark layers a little.
- **Lumen** is a different dark night look. Lumen cannot be light. If you had chosen light before, Memlore remembers it and uses it again when you leave Lumen for Deep or Soft.

Clean and Clay do not use Deep, Soft, or Lumen. A canvas you saved under Signature does not restyle them.

## The font you write with

You can swap the font of the text you write in an entry. Until you change it, that font is Nunito. You can switch to Geist, Inter, Open Sans, or Fuzzy Bubbles.

Those faces already live inside the app. Using them does not download anything, and it does not contact the internet.

A font from Google Fonts is the one case that does. The first time you open that picker and the list is not already saved on this device, Memlore asks Google for the list. You can refresh the list later, and that asks Google again. When you apply a font, Memlore downloads that font file from Google and keeps the file on this device. After that, Memlore uses the saved file. It does not download it on every launch. If you clear the saved fonts, the file is deleted. That custom font is gone until you download it again.

## What is copied to another device

The look, light or dark, the dark canvas, corner roundness, and interface size stay on this device. They are not sent to your other computers. You pick them again on each one.

A few related choices are saved with your other settings. If you turn sync on, they are sealed on this device and then copied, so the cloud holds them but cannot read them.

- Your accent color.
- A built-in writing font, plus the size and contrast you set for it.
- Where the sidebar and the list sit.

The Google Font file is not part of that copy. The name can be saved with your settings, but another device that does not have the file does not download it for you. It falls back to the built-in writing font instead.

## What this means for you

- You can use Signature, Clean, or Clay, each in light or dark. Signature's dark mode also offers Deep, Soft, and Lumen.
- Memlore **cannot** show Soft or Lumen as a light look, and it **cannot** apply those canvases to Clean or Clay.
- Changing the look does not upload your journal.
- Memlore **cannot** carry the look, the light or dark choice, or the dark canvas to a device where you have not chosen them.
- Accent color, a built-in writing font, and the sidebar layout do travel when sync is on. They travel sealed with your other settings.
- Built-in fonts never call Google. A Google Font does. Google receives the request for that list or that file. There is no Memlore server in between, and Memlore **cannot** hide that request while it runs.
- Memlore **cannot** show a Google Font on a device that never downloaded the file. That device uses a built-in font instead.

How the writing surface works is in [Editor](/docs/editor). How copied settings travel is in [Sync](/docs/sync). What else can leave the device is in [How privacy works](/docs/how-privacy-works).
