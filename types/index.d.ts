/** One tool call of the main loop; `endedAt` is absent while it runs. */
export type Step = { id: string; label: string; since: number; endedAt?: number }

/** A plain-Hebrew explanation of what is going on, written every few steps. */
export type Note = { at: number; text: string }

/** A question the user typed into the band, and its answer once it came. */
export type Ask = { at: number; question: string; answer?: string; failed?: true }

/** The running task: from the prompt's turn start to its turn end. */
export type Run = {
  startedAt: number
  /** Every step of the task, oldest first. */
  steps: Step[]
  /** The explanations so far, oldest first. */
  notes: Note[]
  /** When the last tool call finished (or the run started): "thinking" since then. */
  idleSince: number
  /** The questions asked about this task and their answers, oldest first; a closed one is gone. */
  asks: Ask[]
}

/** A long task's one-line summary, drawn in place of the turn's closing line of that duration. */
export type Summary = { durationMs: number; text: string }

/** How much of the account's usage windows is spent, 0-100; absent until a reading. */
export type Limits = { fiveHour?: number; week?: number }

/**
 * The Hebrew translation of one English answer, drawn under the assistant block that ends it.
 * `tail` and `length` describe the answer's skeleton (letters and digits alone) so the block is
 * recognised however the surface drew it.
 */
export type Translation = {
  turnId: string
  tail: string
  length: number
  status: 'pending' | 'done' | 'failed'
  text?: string
}

declare module 'claude-code' {
  interface PluginState {
    'whats-happening': {
      run: Run | null
      now: number
      isOpen: boolean
      /** How often a new explanation is written, in ms; 0 is off. */
      everyMs: number
      /** Whether the interval choices are showing (else only their icon). */
      isPicking: boolean
      /** Whether the question field is showing in place of the explanation. */
      isAsking: boolean
      limits: Limits
      /** The latest summaries, oldest first. */
      summaries: Summary[]
      /** Whether mostly-English answers get a Hebrew translation drawn under them. */
      translateOn: boolean
      /** The latest translations, oldest first. */
      translations: Translation[]
    }
  }
}
