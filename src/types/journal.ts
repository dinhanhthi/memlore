export interface Journal {
  id: string
  name: string
  color: string | null
  created_at: number
  updated_at: number
  sort_order: number
  is_deleted: boolean
  is_locked: boolean
  is_invisible: boolean
  /** Owning invisible vault when invisible; null when visible. Multi-vault
   * ownership — filter rewrite lands later; column is projected now. */
  vault_id: string | null
  is_initial_placeholder: boolean
}

export interface Tag {
  id: string
  name: string
  color: string | null
}
