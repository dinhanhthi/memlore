;(function () {
  var ds = 'signature',
    theme = 'dark',
    surface = 'deep',
    radius = 'high'
  try {
    var p = JSON.parse(localStorage.getItem('memlore-ui') || '{}').state || {}
    if (p.designSystem === 'clean') ds = 'clean'
    if (p.designSystem === 'clay') ds = 'clay'
    if (p.surfaceStyle === 'lumen' || p.surfaceStyle === 'soft' || p.surfaceStyle === 'deep')
      surface = p.surfaceStyle
    if (p.designSystem === 'lumen') surface = 'lumen'
    if (p.theme === 'light' || p.theme === 'dark') theme = p.theme
    if (p.cornerRadius === 'medium' || p.cornerRadius === 'high' || p.cornerRadius === 'low')
      radius = p.cornerRadius
  } catch (e) {}
  var light = theme === 'light'
  if (ds === 'signature' && surface === 'lumen') light = false
  var cls = 'ds-' + ds + (light ? '' : ' dark')
  if (!light && ds === 'signature') {
    if (surface === 'lumen') cls += ' surface-lumen'
    else if (surface === 'soft') cls += ' surface-soft'
  }
  if (radius === 'medium') cls += ' rad-medium'
  else if (radius === 'high') cls += ' rad-high'
  var r = document.documentElement
  r.className = cls
  r.style.backgroundColor = light
    ? ds === 'clean'
      ? '#ffffff'
      : ds === 'clay'
        ? '#ebe3d6'
        : '#f4f3f1'
    : ds === 'signature' && surface === 'lumen'
      ? '#05070d'
      : ds === 'clean'
        ? '#252525'
        : ds === 'clay'
          ? '#171513'
          : '#0d0d0d'
})()
