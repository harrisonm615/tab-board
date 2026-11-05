/**
 * needs: a question or approval is open mid-turn. step: a turn ended with
 * Claude waiting on the person to carry on. finished: the tab has run its
 * course (done, or what is left is the person's own); it can close.
 */
export type TabState = 'needs' | 'step' | 'finished' | 'working' | 'waiting' | 'idle' | 'closed'

/** What each session writes to ~/.claude/tab-board/<id>.json. */
export type TabRecord = {
  id: string
  title: string
  cwd: string
  state: TabState
  detail: string
  since: number
  /** When the tab's own process last wrote; absent on a record filled in for a tab not running. */
  beat?: number
  /** Which judge wrote the verdict; an older one is asked again. */
  v?: number
}

/** One line of the board, ready to draw. */
export type TabRow = {
  id: string
  title: string
  project: string
  state: TabState
  detail: string
  /** Why a tab is ready to close: Done, Parked, Quiet 2d or Empty; else empty. */
  why: string
  age: string
  since: number
  isMine: boolean
}

/** One tab where what was searched for was said, ready to draw. */
export type SearchHit = {
  id: string
  title: string
  project: string
  /** VS Code has it open as a tab (or it is running); else a recent chat it can bring back. */
  isOpen: boolean
  isMine: boolean
  /** How many times the words were said in it. */
  hits: number
  /** Who said the line shown, You or Claude; empty when only the title matched. */
  who: string
  snippet: string
  age: string
}

/** The pane's search: idle shows the board, the rest show the search. */
export type TabSearch = {
  query: string
  status: 'idle' | 'searching' | 'done' | 'failed'
  hits: SearchHit[]
  /** Why a search failed. */
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'tab-board': { rows: TabRow[]; search: TabSearch }
  }
}
