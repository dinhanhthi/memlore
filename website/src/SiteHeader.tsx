import { useEffect, useRef, useState } from 'react'
import { Download, Menu, X } from 'lucide-react'
import { changelog, githubUrl, legal, nav } from './content'
import { latestStableVersion } from './changelog/changelogData'
import HeadFollowLogo from './HeadFollowLogo'

const COMPACT_QUERY = '(max-width: 68rem)'

export function useWideViewport() {
  const [wide, setWide] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return !window.matchMedia(COMPACT_QUERY).matches
  })
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY)
    const update = () => setWide(!mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return wide
}

export function DownloadLink({
  className,
  label,
  ariaLabel,
}: {
  className: string
  label: string
  ariaLabel: string
}) {
  return (
    <a
      className={className}
      href={githubUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      data-variant="primary"
    >
      <span className="download-glow" aria-hidden="true">
        <span className="download-glow-h" />
        <span className="download-glow-v" />
      </span>
      <Download className="size-4" />
      <span className="download-label">{label}</span>
    </a>
  )
}

function GitHubMark() {
  return (
    <svg className="github-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.24 9.24 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
      />
    </svg>
  )
}

function GitHubLink({ className }: { className: string }) {
  return (
    <a className={`github-link ${className}`} href={githubUrl} target="_blank" rel="noreferrer">
      <GitHubMark />
      <span className="github-label">{nav.github}</span>
    </a>
  )
}

export function SiteHeader({
  homeHref,
  sectionPrefix = '',
  current,
}: {
  homeHref: string
  sectionPrefix?: string
  current?: 'changelog'
}) {
  const wide = useWideViewport()
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const docMenuRef = useRef<HTMLDetailsElement>(null)
  if (wide && open) setOpen(false)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const menu = docMenuRef.current
      if (!menu?.open) return
      if (event.target instanceof Node && menu.contains(event.target)) return
      menu.open = false
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      toggleRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const main = document.getElementById('main')
    const footer = document.querySelector('footer')
    main?.setAttribute('inert', '')
    footer?.setAttribute('inert', '')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      main?.removeAttribute('inert')
      footer?.removeAttribute('inert')
    }
  }, [open])
  const close = () => setOpen(false)
  return (
    <>
      {open ? <div className="nav-backdrop" aria-hidden="true" onClick={close} /> : null}
      <header className="site-header" data-nav-open={open ? 'true' : undefined}>
        <div className="header-brand">
          <a
            className="wordmark"
            href={homeHref}
            aria-label={nav.homeAria}
            onClick={() => {
              if (!open) return
              setOpen(false)
              document.getElementById('main')?.removeAttribute('inert')
              document.querySelector('footer')?.removeAttribute('inert')
            }}
          >
            <HeadFollowLogo alt="" className="wordmark-head" size={36} />
            {nav.wordmark}
          </a>
          {/* Version comes from changelogData, never tauri.conf.json: the config
              carries whatever was last bumped, including a prerelease. */}
          <a
            className="version-badge"
            href="changelog.html"
            aria-label={`${changelog.badgeLabel} ${latestStableVersion} — ${legal.changelogLink}`}
          >
            v{latestStableVersion}
          </a>
        </div>
        <nav
          id="site-nav"
          aria-label={nav.mainAria}
          onClick={(event) => {
            const target = event.target
            if (target instanceof Element && target.closest('a')) close()
          }}
        >
          <a href={`${sectionPrefix}#demo`}>{nav.demo}</a>
          <a href={`${sectionPrefix}#features`}>{nav.features}</a>
          <a href={`${sectionPrefix}#compare`}>{nav.compare}</a>
          <a href="changelog.html" aria-current={current === 'changelog' ? 'page' : undefined}>
            {nav.changelog}
          </a>
          <details ref={docMenuRef} className="doc-menu">
            <summary>{nav.doc}</summary>
            <p>
              {nav.docDisclosure}{' '}
              <a href={githubUrl} target="_blank" rel="noreferrer">
                {nav.docReadme}
              </a>
              .
            </p>
          </details>
        </nav>
        <div className="header-actions">
          <GitHubLink className="header-github" />
          <DownloadLink className="download" label={nav.download} ariaLabel={nav.downloadAria} />
          <button
            ref={toggleRef}
            type="button"
            className="nav-toggle"
            aria-expanded={open}
            aria-controls="site-nav"
            aria-label={open ? nav.closeMenu : nav.menu}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <X className="size-5" aria-hidden="true" />
            ) : (
              <Menu className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </header>
    </>
  )
}
