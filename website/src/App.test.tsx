import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

function renderAt(pathname: string) {
  window.history.pushState({}, '', pathname)
  return render(<App />)
}

afterEach(() => {
  vi.restoreAllMocks()
  window.history.pushState({}, '', '/')
})

describe('website app', () => {
  it('renders the landing page feature story and calls to action', () => {
    renderAt('/')

    expect(
      screen.getByRole('heading', { name: /keeps your inner life local/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download for macOS/i })).toBeInTheDocument()
    expect(screen.getByText(/Rich journaling/i)).toBeInTheDocument()
    expect(screen.getByText(/No tracking, no server, no recovery backdoor/i)).toBeInTheDocument()
  })

  it('renders the docs page with navigation and doc sections', () => {
    renderAt('/docs')

    expect(
      screen.getByRole('heading', { name: /Learn Memlore from the privacy model outward/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sync' })).toHaveAttribute('href', '#sync')
    expect(screen.getByRole('heading', { name: 'AI Privacy' })).toBeInTheDocument()
    expect(screen.getByText(/All AI features are off by default/i)).toBeInTheDocument()
  })

  it('renders the download page and disables non-macOS platforms', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    )
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')

    renderAt('/download')

    expect(screen.getByTestId('platform-recommendation')).toHaveTextContent(
      /Windows is on the roadmap/i,
    )
    expect(screen.getByRole('link', { name: /Download for macOS/i })).toHaveAttribute(
      'href',
      'https://github.com/dinhanhthi/memlore/releases',
    )
    expect(screen.getAllByRole('button', { name: 'Coming soon' })).toHaveLength(4)
    expect(screen.getByText(/Recommended for this device/i)).toBeInTheDocument()
  })
})
