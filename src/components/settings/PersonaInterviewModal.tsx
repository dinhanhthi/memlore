import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { RadioOptionPillGroup } from '../common/RadioOptionPill'

const ANSWER_MAX_CHARS = 300

type PersonaInterviewAnswers = Record<string, string>
type ChoiceQuestionKey = 'journal_goal' | 'voice_preference' | 'length_preference'

interface PersonaInterviewModalProps {
  answersJson: string
  onClose: () => void
  onSave: (answers: PersonaInterviewAnswers) => Promise<void>
}

const TEXT_QUESTIONS = [
  'preferred_name',
  'languages',
  'three_words',
  'life_priorities',
  'avoid_topics',
] as const

const CHOICE_QUESTIONS: Array<{
  key: ChoiceQuestionKey
  options: readonly string[]
}> = [
  { key: 'journal_goal', options: ['venting', 'memories', 'tracking', 'reflection'] },
  { key: 'voice_preference', options: ['keep_voice', 'polish'] },
  { key: 'length_preference', options: ['brief', 'medium', 'detailed'] },
]

function parseAnswers(answersJson: string): PersonaInterviewAnswers {
  try {
    const parsed: unknown = JSON.parse(answersJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    )
  } catch {
    return {}
  }
}

export function PersonaInterviewModal({
  answersJson,
  onClose,
  onSave,
}: PersonaInterviewModalProps) {
  const { t } = useTranslation('ai')
  const initialAnswers = useMemo(() => parseAnswers(answersJson), [answersJson])
  const [answers, setAnswers] = useState<PersonaInterviewAnswers>(initialAnswers)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setAnswer(key: string, value: string) {
    setAnswers((current) => ({ ...current, [key]: value }))
  }

  async function save() {
    setSaving(true)
    try {
      await onSave(answers)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={() => !saving && onClose()} maxWidth={640} className="bg-elevated">
      <Modal.Header description={t('user_memory.persona.interview.description')}>
        {t('user_memory.persona.interview.title')}
      </Modal.Header>
      <Modal.Body className="space-y-3">
        <InterviewTextQuestion
          questionKey="preferred_name"
          answer={answers.preferred_name ?? ''}
          onChange={setAnswer}
        />
        {CHOICE_QUESTIONS.slice(0, 2).map(({ key, options }) => (
          <InterviewChoiceQuestion
            key={key}
            questionKey={key}
            options={options}
            answer={answers[key] ?? ''}
            onChange={setAnswer}
          />
        ))}
        {TEXT_QUESTIONS.slice(1)
          .slice(0, 3)
          .map((key) => (
            <InterviewTextQuestion
              key={key}
              questionKey={key}
              answer={answers[key] ?? ''}
              onChange={setAnswer}
            />
          ))}
        <InterviewTextQuestion
          questionKey="avoid_topics"
          answer={answers.avoid_topics ?? ''}
          onChange={setAnswer}
        />
        <InterviewChoiceQuestion
          questionKey="length_preference"
          options={CHOICE_QUESTIONS[2].options}
          answer={answers.length_preference ?? ''}
          onChange={setAnswer}
        />
        {error && (
          <p className="text-danger-text text-sm" role="alert">
            {error}
          </p>
        )}
        <p className="border-border-default text-fg-muted border-t pt-4 text-xs leading-relaxed">
          {t('user_memory.persona.interview.privacy')}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
          {t('user_memory.persona.interview.cancel')}
        </Button>
        <Button variant="secondary" size="sm" loading={saving} onClick={() => void save()}>
          {t('user_memory.persona.interview.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

interface InterviewQuestionProps {
  questionKey: string
  answer: string
  onChange: (key: string, value: string) => void
}

function InterviewTextQuestion({ questionKey, answer, onChange }: InterviewQuestionProps) {
  const { t } = useTranslation('ai')
  const label = t(`user_memory.persona.interview.questions.${questionKey}.label`)
  return (
    <label className="border-border-card bg-surface-hi block space-y-1.5 rounded-xl border px-4 py-3">
      <span className="text-fg text-sm font-medium">{label}</span>
      <span className="text-fg-muted block text-xs">
        {t(`user_memory.persona.interview.questions.${questionKey}.help`)}
      </span>
      <textarea
        value={answer}
        rows={2}
        onChange={(event) =>
          onChange(questionKey, Array.from(event.target.value).slice(0, ANSWER_MAX_CHARS).join(''))
        }
        className="border-border-default bg-elevated text-fg w-full resize-y rounded-lg border px-3 py-2 text-sm outline-none"
      />
      <span className="text-fg-muted block text-right text-xs">
        {t('user_memory.persona.interview.character_count', {
          count: Array.from(answer).length,
          max: ANSWER_MAX_CHARS,
        })}
      </span>
    </label>
  )
}

interface InterviewChoiceQuestionProps extends InterviewQuestionProps {
  questionKey: ChoiceQuestionKey
  options: readonly string[]
}

function InterviewChoiceQuestion({
  questionKey,
  options,
  answer,
  onChange,
}: InterviewChoiceQuestionProps) {
  const { t } = useTranslation('ai')
  const label = t(`user_memory.persona.interview.questions.${questionKey}.label`)
  return (
    <div className="border-border-card bg-surface-hi space-y-2 rounded-xl border px-4 py-3">
      <p className="text-fg text-sm font-medium">{label}</p>
      <p className="text-fg-muted text-xs">
        {t(`user_memory.persona.interview.questions.${questionKey}.help`)}
      </p>
      <RadioOptionPillGroup
        value={answer}
        onChange={(next) => onChange(questionKey, next)}
        ariaLabel={label}
        options={options.map((option) => ({
          value: option,
          label: t(`user_memory.persona.interview.options.${option}`),
        }))}
      />
    </div>
  )
}
