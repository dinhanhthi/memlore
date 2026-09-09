import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  getDashboardCards,
  setDashboardCards,
  useDashboardCards,
} from '../../hooks/useDashboardCards'
import { isAiGatedCardId, type DashboardCardId } from '../../lib/dashboardCards'
import { AiIcon } from '../common/AiIcon'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { Tooltip } from '../common/Tooltip'
import { Toggle } from '../settings/Toggle'

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

interface DashboardCustomizeModalProps {
  onClose: () => void
}

export function DashboardCustomizeModal({ onClose }: DashboardCustomizeModalProps) {
  const { t } = useTranslation('dashboard')
  const prefs = useDashboardCards()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = prefs.map((pref) => pref.id)

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    if (typeof active.id !== 'string' || typeof over.id !== 'string') return
    const current = getDashboardCards()
    const oldIndex = current.findIndex((pref) => pref.id === active.id)
    const newIndex = current.findIndex((pref) => pref.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    setDashboardCards(arrayMove(current, oldIndex, newIndex))
  }

  function handleToggle(id: DashboardCardId, enabled: boolean) {
    setDashboardCards(
      getDashboardCards().map((pref) => (pref.id === id ? { ...pref, enabled } : pref)),
    )
  }

  return (
    <Modal onClose={onClose} labelledBy="dashboard-customize-title">
      <Modal.Header id="dashboard-customize-title" description={t('customize_hint')}>
        {t('customize_title')}
      </Modal.Header>
      <Modal.Body>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="m-0 list-none p-0">
              {prefs.map((pref) => (
                <SortableCardRow
                  key={pref.id}
                  id={pref.id}
                  enabled={pref.enabled}
                  label={t(`cards.${pref.id}`)}
                  onToggle={(enabled) => handleToggle(pref.id, enabled)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </Modal.Body>
    </Modal>
  )
}

function SortableCardRow({
  id,
  enabled,
  label,
  onToggle,
}: {
  id: DashboardCardId
  enabled: boolean
  label: string
  onToggle: (enabled: boolean) => void
}) {
  const { t } = useTranslation('dashboard')
  const labelId = `dashboard-customize-${id}`
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id })

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className="flex items-center gap-3 py-2.5"
    >
      <Button
        variant="ghost"
        size="xs"
        icon={<GripVertical className="text-fg-muted size-4" />}
        className="cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label={t('customize_reorder', { card: label })}
      />
      <span id={labelId} className="text-fg min-w-0 flex-1 text-sm">
        {label}
      </span>
      {isAiGatedCardId(id) && (
        <Tooltip content={t('customize_ai_hint')}>
          <span className="text-fg-muted inline-flex shrink-0">
            <AiIcon aria-hidden />
          </span>
        </Tooltip>
      )}
      <Toggle checked={enabled} onChange={onToggle} size="sm" ariaLabelledBy={labelId} />
    </li>
  )
}
