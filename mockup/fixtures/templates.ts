import type { Template } from '../../src/types/template'

const now = Math.floor(Date.now() / 1000)

export const templates: Template[] = [
  {
    id: 'template-daily-review-001',
    name: 'Daily Review',
    description: 'A simple template for end-of-day reflection',
    content: null,
    is_predefined: true,
    sort_order: 0,
    created_at: now - 30 * 24 * 60 * 60,
  },
  {
    id: 'template-gratitude-002',
    name: 'Gratitude Journal',
    description: 'Three things to be thankful for today',
    content: null,
    is_predefined: true,
    sort_order: 1,
    created_at: now - 30 * 24 * 60 * 60,
  },
  {
    id: 'template-meeting-003',
    name: 'Meeting Notes',
    description: 'Capture attendees, decisions, and action items',
    content: null,
    is_predefined: false,
    sort_order: 2,
    created_at: now - 14 * 24 * 60 * 60,
  },
  {
    id: 'template-travel-004',
    name: 'Travel Day',
    description: 'Log your journey — transport, places, impressions',
    content: null,
    is_predefined: false,
    sort_order: 3,
    created_at: now - 7 * 24 * 60 * 60,
  },
]
