import { useRef, useState, type KeyboardEvent } from 'react'
import { Lock } from 'lucide-react'

type StateId = 'locked' | 'unlocked' | 'vault' | 'second'
type Show = 'visible' | 'hidden' | 'gated'

interface LockState {
  id: StateId
  label: string
  caption: string
  features: { search: string; ai: string; export: string }
}

interface Item {
  name: string
  kind: string
  kindId: 'ordinary' | 'second-lock' | 'vault' | 'other-vault'
  show: Record<StateId, Show>
}

// Every string here comes from docs/content/locks.md.
const STATES: LockState[] = [
  {
    id: 'locked',
    label: 'App locked',
    caption: 'Until you unlock, you get the unlock screen. The journal is not loaded.',
    features: { search: 'Does not run', ai: 'Does not run', export: 'Refuses' },
  },
  {
    id: 'unlocked',
    label: 'Unlocked',
    caption:
      "A closed vault's journals and entries do not appear. Second-locked entries drop out of lists and search.",
    features: {
      search: 'Skips vaults and second-locked entries',
      ai: 'Leaves every invisible vault out. Chat skips second-locked text',
      export: 'Includes second-locked entries. A full zip also holds invisible-vault writing',
    },
  },
  {
    id: 'vault',
    label: 'Vault open',
    caption:
      'Each password opens only its vault. Other vaults stay hidden even when one vault is open.',
    features: {
      search: 'Sees only the vault you have open',
      ai: 'Still leaves every invisible vault out. Chat skips second-locked text',
      export: 'Includes second-locked entries. A full zip also holds invisible-vault writing',
    },
  },
  {
    id: 'second',
    label: 'Second lock open',
    caption:
      'One password opens every second-locked item for that sitting. Open the sitting and the writing shows again.',
    features: {
      search: 'Word search can find it again',
      ai: 'Chat does not send second-locked text. Indexing and Memory can, if you turn that on',
      export: 'Includes second-locked entries. A full zip also holds invisible-vault writing',
    },
  },
]

const ITEMS: Item[] = [
  {
    name: 'Journal',
    kind: 'Ordinary',
    kindId: 'ordinary',
    show: { locked: 'hidden', unlocked: 'visible', vault: 'visible', second: 'visible' },
  },
  {
    name: 'Locked entry',
    kind: 'Second lock · one entry',
    kindId: 'second-lock',
    show: { locked: 'hidden', unlocked: 'hidden', vault: 'hidden', second: 'visible' },
  },
  {
    name: 'Locked journal',
    kind: 'Second lock · whole journal',
    kindId: 'second-lock',
    show: { locked: 'hidden', unlocked: 'gated', vault: 'gated', second: 'visible' },
  },
  {
    name: 'Private journal',
    kind: 'Invisible vault',
    kindId: 'vault',
    show: { locked: 'hidden', unlocked: 'hidden', vault: 'visible', second: 'hidden' },
  },
  {
    name: 'Other private journal',
    kind: 'Another vault',
    kindId: 'other-vault',
    show: { locked: 'hidden', unlocked: 'hidden', vault: 'hidden', second: 'hidden' },
  },
]

const FEATURE_LABELS = { search: 'Search', ai: 'AI', export: 'Export' } as const

export function LocksExplorer() {
  const [current, setCurrent] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const state = STATES[current]

  const select = (i: number) => {
    setCurrent(i)
    tabs.current[i]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const last = STATES.length - 1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') select(current === last ? 0 : current + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      select(current === 0 ? last : current - 1)
    else if (e.key === 'Home') select(0)
    else if (e.key === 'End') select(last)
    else return
    e.preventDefault()
  }

  return (
    <figure className="docs-widget docs-widget-locks-explorer">
      <figcaption className="docs-widget-title" id="locks-explorer-title">
        What shows in each lock state
      </figcaption>
      <div
        className="docs-widget-controls"
        role="tablist"
        aria-labelledby="locks-explorer-title"
        onKeyDown={onKeyDown}
      >
        {STATES.map((s, i) => (
          <button
            key={s.id}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`locks-explorer-tab-${s.id}`}
            aria-selected={i === current}
            aria-controls="locks-explorer-panel"
            tabIndex={i === current ? 0 : -1}
            onClick={() => setCurrent(i)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        className="le-panel"
        role="tabpanel"
        id="locks-explorer-panel"
        aria-labelledby={`locks-explorer-tab-${state.id}`}
      >
        {state.id === 'locked' ? (
          <div className="le-unlock">
            <Lock className="le-icon" aria-hidden="true" />
            Unlock screen
          </div>
        ) : null}
        <ul className="le-items">
          {ITEMS.map((item) => {
            const show = item.show[state.id]
            return (
              <li key={item.name} className="le-item" data-show={show} data-kind={item.kindId}>
                <span className="le-name">{item.name}</span>
                <span className="le-kind">
                  {show === 'hidden' ? `Not shown · ${item.kind}` : item.kind}
                </span>
                {show === 'gated' ? (
                  <span className="le-badge">
                    <Lock className="le-icon" aria-hidden="true" />
                    Entries locked
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
        <dl className="le-features">
          {(Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[]).map((key) => (
            <div key={key}>
              <dt>{FEATURE_LABELS[key]}</dt>
              <dd>{state.features[key]}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="docs-widget-caption le-caption" aria-live="polite">
        {state.caption}
      </p>
      {state.id === 'second' ? null : (
        <p className="docs-widget-caption">
          One second-lock password opens every second-locked entry and journal at once, until the
          sitting closes.
        </p>
      )}
    </figure>
  )
}
