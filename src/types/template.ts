export interface Template {
  id: string
  name: string
  description: string | null
  content: number[] | null
  is_predefined: boolean
  sort_order: number
  created_at: number
}
