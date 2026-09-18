import { useEffect, useRef, useState } from 'react'
import { Download, Menu, X } from 'lucide-react'
import { githubUrl } from './links'
import HeadFollowLogo from './HeadFollowLogo'
import { useWideViewport } from './useWideViewport'

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
            aria-label="Memlore home"
            onClick={() => {
              if (!open) return
              setOpen(false)
              document.getElementById('main')?.removeAttribute('inert')
              document.querySelector('footer')?.removeAttribute('inert')
            }}
          >
            <HeadFollowLogo alt="" className="wordmark-head" size={36} />
            Memlore
          </a>
        </div>
        <nav
          id="site-nav"
          aria-label="Main navigation"
          onClick={(event) => {
            const target = event.target
            if (target instanceof Element && target.closest('a')) close()
          }}
        >
          <a href={`${sectionPrefix}#demo`}>Demo</a>
          <a href={`${sectionPrefix}#features`}>Features</a>
          <a href={`${sectionPrefix}#compare`}>Compare</a>
          <a href="/changelog" aria-current={current === 'changelog' ? 'page' : undefined}>
            Changelog
          </a>
          <details ref={docMenuRef} className="doc-menu">
            <summary>Doc</summary>
            <p>
              Documentation is coming soon. For now, explore the{' '}
              <a href={githubUrl} target="_blank" rel="noreferrer">
                GitHub README
              </a>
              .
            </p>
          </details>
        </nav>
        <div className="header-actions">
          <GitHubLink className="header-github" />
          <DownloadLink
            className="download"
            label="Download"
            ariaLabel="Download the beta from GitHub"
          />
          <button
            ref={toggleRef}
            type="button"
            className="nav-toggle"
            aria-expanded={open}
            aria-controls="site-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
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
