// Pure helpers: turning a tool call into a short Hebrew phrase, and formatting time.

/** Time on one activity after which the band warns. */
export const STUCK_MS = 5 * 60 * 1000

/** Tasks at least this long get a summary line under the answer. */
export const SUMMARY_MS = 60 * 1000

const fileName = (p: unknown): string =>
  typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : ''

const withFile = (verb: string, p: unknown): string => {
  const name = fileName(p)
  return name ? `${verb} ${name}` : verb
}

/** How much of a command the band shows beside "running". */
const COMMAND_CHARS = 40

/**
 * The command as typed, squeezed to one line and cut short, after "running": the band shows
 * what runs and reads nothing into it. What the command is for is the explanations' job.
 */
const commandLabel = (command: unknown, isBackground: unknown): string => {
  const verb = isBackground === true ? 'מריץ ברקע' : 'מריץ'
  const text = typeof command === 'string' ? command.replace(/\s+/g, ' ').trim() : ''
  if (!text) return isBackground === true ? 'מפעיל משימה ברקע' : 'מריץ פקודה'
  return `${verb}: ${text.length > COMMAND_CHARS ? `${text.slice(0, COMMAND_CHARS)}…` : text}`
}

/** A short Hebrew phrase for what a tool call is doing. */
export function describe(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return commandLabel(input.command, input.run_in_background)
    case 'Read':
      return withFile('קורא את', input.file_path)
    case 'Edit':
    case 'NotebookEdit':
      return withFile('עורך את', input.file_path ?? input.notebook_path)
    case 'Write':
      return withFile('כותב את', input.file_path)
    case 'Grep':
    case 'Glob':
      return 'מחפש בקבצים'
    case 'Agent':
    case 'Task':
      return 'סוכן עובד על משימה'
    case 'WebSearch':
      return 'מחפש ברשת'
    case 'WebFetch':
      return 'קורא דף אינטרנט'
    case 'AskUserQuestion':
      return 'מחכה לתשובה שלך'
    case 'Skill':
      return 'טוען הנחיות עבודה'
    case 'Monitor':
      return 'עוקב אחרי משימה'
    case 'TodoWrite':
      return 'מעדכן רשימת משימות'
    case 'Artifact':
      return 'מכין עמוד לתצוגה'
  }
  const server = mcpServer(tool)
  if (server) return `עובד עם ${server}`
  if (tool.startsWith('mcp__')) return 'משתמש בכלי חיצוני'
  return 'משתמש בכלי'
}

/**
 * The server an MCP tool belongs to, from its name (`mcp__<server>__<tool>`), in a readable
 * form: a `claude-in-chrome` prefix becomes `chrome`, a `claude_ai_` or `plugin-` prefix is
 * dropped, underscores become spaces. Empty for a name that is not an MCP tool's.
 */
export function mcpServer(tool: string): string {
  const m = /^mcp__(.+?)__/.exec(tool)
  if (!m?.[1]) return ''
  return m[1]
    .replace(/^claude-in-/, '')
    .replace(/^claude_ai_/, '')
    .replace(/^plugin-/, '')
    .replace(/_/g, ' ')
    .trim()
}

const cut = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** What a tool call actually did, in English, for the model that writes the explanations. */
export function detail(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `ran a command${input.description ? ` (its stated purpose: ${cut(input.description, 150)})` : ''}: ${cut(input.command, 300)}`
    case 'Read':
      return `read the file ${cut(input.file_path, 200)}`
    case 'Edit':
      return `edited ${cut(input.file_path, 200)}: replaced "${cut(input.old_string, 250)}" with "${cut(input.new_string, 250)}"`
    case 'Write':
      return `wrote the whole file ${cut(input.file_path, 200)}, beginning: "${cut(input.content, 250)}"`
    case 'Grep':
      return `searched the code for "${cut(input.pattern, 120)}"${input.path ? ` in ${cut(input.path, 150)}` : ''}`
    case 'Glob':
      return `listed files matching ${cut(input.pattern, 120)}`
    case 'Agent':
    case 'Task':
      return `sent a helper agent: ${cut(input.description, 120)}. Its brief: ${cut(input.prompt, 300)}`
    case 'WebSearch':
      return `searched the web for "${cut(input.query, 150)}"`
    case 'WebFetch':
      return `opened the web page ${cut(input.url, 200)}`
  }
  return `used the tool ${tool} with ${cut(input, 300)}`
}

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The last `n` characters of a text, whitespace squeezed. */
const tail = (text: string, n: number): string => {
  const s = squeeze(text)
  return s.length > n ? `…${s.slice(-n)}` : s
}

/**
 * What a tool call came back with, in English, for the model that writes the explanations
 * and answers questions: a short excerpt chosen per tool, or nothing where the result says
 * no more than "it worked" (a file read or edited).
 */
export function outcome(tool: string, text: string | undefined, isError: boolean): string {
  if (typeof text !== 'string' || !squeeze(text)) return isError ? ' (it failed)' : ''
  if (isError) return ` (it failed: ${cut(squeeze(text), 300)})`
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `; it printed: ${tail(text, 400)}`
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return ''
    case 'Grep':
    case 'Glob':
      return `; it found: ${cut(squeeze(text), 300)}`
    case 'Agent':
    case 'Task':
      return `; the helper reported: ${tail(text, 500)}`
  }
  return `; it came back with: ${cut(squeeze(text), 300)}`
}

/** 0:07, 3:12, 1:04:09 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Whole minutes in Hebrew, for the stuck warning. */
export function minutes(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m === 1 ? 'דקה' : `${m} דקות`
}

/** Removes Hebrew points and cantillation marks (niqqud) from text. */
export const stripNiqqud = (text: string): string => text.replace(/[֑-ׇ]/g, '')
