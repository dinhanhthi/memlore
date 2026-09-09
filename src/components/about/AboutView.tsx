import { openUrl } from '@tauri-apps/plugin-opener'
import { useRef } from 'react'
import { Code2, ExternalLink, Globe, Mail } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { RestoredScroll } from '../common/RestoredScroll'
import { useLogoDirection, logoSrc, ALL_LOGO_DIRECTIONS } from '../../hooks/useLogoDirection'
import { useUiStore } from '../../stores/uiStore'
import { SettingsSection } from '../settings/SettingsSection'
import { IconCustom } from '../common/IconCustom'

const AUTHOR_WEBSITE_URL = 'https://dinhanhthi.com'
const AUTHOR_EMAIL = 'me@dinhanhthi.com'
const REPO_URL = 'https://github.com/dinhanhthi/memlore'

function ExternalLinkRow({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    void openUrl(href)
  }
  return (
    <a
      href={href}
      onClick={handleClick}
      className={cn(
        'group text-accent inline-flex items-center gap-2 text-sm',
        'underline-offset-2 hover:underline',
        'outline-none',
      )}
    >
      <span className="text-fg-muted">{icon}</span>
      <span>{label}</span>
      <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
    </a>
  )
}

export function AboutView() {
  const { t } = useTranslation('settings')
  const isClay = useUiStore((s) => s.designSystem) === 'clay'
  const principleKeys = ['local_first', 'private', 'ai_optional', 'yours']

  return (
    <RestoredScroll
      view="about"
      className={cn(
        'flex-1 overflow-y-auto p-6 outline-none',
        isClay
          ? 'xj-main-panel bg-selected-tab h-full rounded-2xl shadow-(--shadow-panel)'
          : 'bg-panel-3 dark:bg-transparent',
      )}
    >
      <div className="max-w-200">
        <div className="mb-6">
          <AboutLogo />
          <h1 className="font-title text-fg text-3xl font-extrabold">
            {t('about_section.heading_title')}
          </h1>
          <p className="text-fg-muted mt-1 text-sm">{t('about_section.heading_description')}</p>
        </div>

        <div className="mb-7 space-y-3">
          <p className="text-fg-secondary text-sm leading-relaxed">
            {t('about_section.description')}
          </p>
        </div>

        <SettingsSection title={t('about_section.principles_title')}>
          <ul className="text-fg-secondary space-y-1.5 text-sm">
            {principleKeys.map((key) => (
              <li key={key} className="flex gap-2">
                <span className="bg-accent mt-2 h-1 w-1 shrink-0 rounded-full" />
                <span>{t(`about_section.principles.${key}`)}</span>
              </li>
            ))}
          </ul>
        </SettingsSection>

        <SettingsSection title={t('about_section.author_title')}>
          <div className="flex flex-row gap-4">
            <p className="text-fg text-sm font-medium">{t('about_section.author_name')}</p>
            <ExternalLinkRow
              href={AUTHOR_WEBSITE_URL}
              icon={<Globe className="size-3.5" strokeWidth={1.75} />}
              label={t('about_section.author_website')}
            />
            <ExternalLinkRow
              href={`mailto:${AUTHOR_EMAIL}`}
              icon={<Mail className="size-3.5" strokeWidth={1.75} />}
              label={t('about_section.author_email')}
            />
          </div>
        </SettingsSection>

        <SettingsSection title={t('about_section.repo_title')}>
          <div className="flex flex-col gap-2">
            <p className="text-fg-secondary text-sm leading-relaxed">
              {t('about_section.license')}
            </p>
            <ExternalLinkRow
              href={REPO_URL}
              icon={<Code2 className="size-3.5" strokeWidth={1.75} />}
              label={t('about_section.repo_label')}
            />
          </div>
        </SettingsSection>
      </div>
    </RestoredScroll>
  )
}

/** About-page logo that follows the cursor when the setting is enabled. */
function AboutLogo() {
  const ref = useRef<HTMLSpanElement>(null)
  const direction = useLogoDirection(ref)

  if (direction == null) {
    return (
      <span ref={ref}>
        <IconCustom name="XjLogo" size={80} />
      </span>
    )
  }

  return (
    <span ref={ref} className="relative inline-flex size-20">
      {ALL_LOGO_DIRECTIONS.map((d) => (
        <img
          key={d}
          src={logoSrc(d)}
          width={80}
          height={80}
          className={cn('absolute inset-0 block', d !== direction && 'invisible')}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      ))}
    </span>
  )
}
