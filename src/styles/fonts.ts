// Self-hosted fonts — bundled by Vite at build time so the app renders its
// full typography 100% offline (no runtime Google Fonts CDN request). Each
// import pulls every subset the family ships (e.g. `vietnamese` for Geist,
// Inter, Nunito, Fuzzy Bubbles). Variable packages cover all weights in one
// file; static families import only the weights the UI applies.
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '@fontsource-variable/fraunces/index.css'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/nunito/index.css'
// Clay UI face (`--font-sans` under ds-clay). Variable package ships every
// weight and the latin / latin-ext / vietnamese subsets in one stylesheet.
import '@fontsource-variable/baloo-2/index.css'
import '@fontsource/open-sans/500.css'
import '@fontsource/open-sans/600.css'
import '@fontsource/open-sans/700.css'
import '@fontsource/fuzzy-bubbles/400.css'
import '@fontsource/fuzzy-bubbles/700.css'
