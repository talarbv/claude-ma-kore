import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Ask, Limits, Run, Summary, Translation } from '../types'
import type { Run as TextRun } from './translate'
import { SUMMARY_MS, STUCK_MS, clock, describe, detail, minutes, mirrorBrackets, outcome, stripNiqqud, wrapLines } from './labels'
import {
  FAILED_TEXT,
  MAX_ANSWER_CHARS,
  PENDING_TEXT,
  TAIL_CHARS,
  TRANSLATE_RULES,
  TRANSLATE_TIMEOUT_MS,
  hebrewBlocks,
  wrapRuns,
  isAnswerEnd,
  looksTranslated,
  needsTranslation,
  skeleton,
  tokensFor,
  translationPrompt,
} from './translate'

const run = atom({ plugin: 'whats-happening', key: 'run' } as const, null)
const now = atom({ plugin: 'whats-happening', key: 'now' } as const, 0)
const isOpen = atom({ plugin: 'whats-happening', key: 'isOpen' } as const, false)
const everyMs = atom({ plugin: 'whats-happening', key: 'everyMs' } as const, 30_000)
const isPicking = atom({ plugin: 'whats-happening', key: 'isPicking' } as const, false)
const isAsking = atom({ plugin: 'whats-happening', key: 'isAsking' } as const, false)
const limits = atom({ plugin: 'whats-happening', key: 'limits' } as const, {} as Limits)
const summaries = atom({ plugin: 'whats-happening', key: 'summaries' } as const, [] as Summary[])
const translateOn = atom({ plugin: 'whats-happening', key: 'translateOn' } as const, true)
const translations = atom({ plugin: 'whats-happening', key: 'translations' } as const, [] as Translation[])

/** A turn's closing line and its summary match when their durations are this close. */
const SAME_TURN_MS = 1500

/** How long an explanation, an answer or a summary may take before Haiku is given up on. */
const HAIKU_TIMEOUT_MS = 20_000

/** The translation switch, kept across sessions in `$.store`. */
const TRANSLATE_KEY = 'translateOn'

/** The first explanation comes after this many steps; later ones on the chosen interval. */
const FIRST_NOTE_STEPS = 2

/** The interval picker's choices; 0 turns the explanations off. Kept across sessions in `$.store`. */
/** How many questions and answers the band keeps for one task; older ones drop off. */
const MAX_ASKS = 3

const EVERY_OPTIONS = [
  { ms: 15_000, label: '15ש׳' },
  { ms: 30_000, label: '30ש׳' },
  { ms: 60_000, label: 'דקה' },
  { ms: 120_000, label: '2ד׳' },
  { ms: 300_000, label: '5ד׳' },
  { ms: 0, label: 'כבוי' },
] as const
const EVERY_KEY = 'everyMs'

function toLimits(windows: readonly { kind: string; percentUsed: number }[]): Limits {
  const pick = (kind: string) => windows.find(w => w.kind === kind)?.percentUsed
  return { fiveHour: pick('five_hour'), week: pick('seven_day') }
}

async function refreshLimits($: EngineInterface): Promise<void> {
  try {
    const { rateLimits } = await $.session.usage()
    if (rateLimits.length > 0) await update($, limits, () => toLimits(rateLimits))
  } catch {
    // No reading yet (or off a subscription): the column just stays empty.
  }
}

const percent = (n: number | undefined) => (n === undefined ? '–' : `${Math.round(n)}%`)

const NOTE_RULES = [
  'You watch an AI coding assistant work and answer the user\'s question "what is going on right now?".',
  'Write 1-2 short sentences in simple Hebrew for a non-programmer: what the assistant is trying to achieve at this moment and why, in terms of the user\'s goal.',
  'Explain the purpose and the meaning, not the mechanics: never just restate "edited file X" or "ran a command". Say what the change or check is for, and what was found if it is known.',
  'If it is progressing toward the goal, say where it stands. If it hit a problem, say so plainly.',
  'Never use niqqud. No code, no commands, no file paths; a file or tool name only when it really helps.',
  'Do not repeat the previous explanation; say what is new. At most 35 words. Output the explanation only.',
].join('\n')

const SUMMARY_RULES = [
  'You write one status line in simple Hebrew for a non-programmer.',
  'Never use niqqud. No code, no file paths, no English unless a name has no Hebrew form.',
  'Format exactly: נעשה: <what was done> · נשאר: <what is left, or כלום>',
  'At most 25 words. Output the line only.',
].join('\n')

const ANSWER_RULES = [
  'You watch an AI coding assistant work. The user, a non-programmer, asks a question about what it is doing right now.',
  'Answer in simple Hebrew, 1-3 short sentences, at most 60 words, from the record of what happened. Explain purpose and meaning, not mechanics.',
  'If the record does not tell, say plainly that it is not visible yet; never invent. Do not give advice unless asked.',
  'Never use niqqud. No code, no commands, no file paths; a file or tool name only when it really helps. Output the answer only.',
].join('\n')

type Trace = { kind: 'step' | 'said'; text: string }

/** The module's own bookkeeping for one task; a hot reload starts it over. */
const live = {
  ticker: undefined as Timer | undefined,
  ask: '',
  seq: 0,
  // What happened this task, for the explanations: tool calls and the assistant's own words.
  trace: [] as Trace[],
  tracedAtLastNote: 0,
  stepsAtLastNote: 0,
  lastNoteAt: 0,
  explaining: undefined as AbortController | undefined,
  answering: undefined as AbortController | undefined,
}

const traceLines = (items: Trace[]): string =>
  items.map(t => (t.kind === 'step' ? `- ${t.text}` : `- the assistant said: ${t.text}`)).join('\n')

function shouldExplain(r: Run, t: number, every: number): boolean {
  if (live.explaining || every <= 0) return false
  const newSteps = r.steps.length - live.stepsAtLastNote
  if (r.notes.length === 0 && live.stepsAtLastNote === 0) return newSteps >= FIRST_NOTE_STEPS
  return newSteps >= 1 && t - live.lastNoteAt >= every
}

async function explain($: EngineInterface, r: Run, at: number): Promise<void> {
  const fresh = live.trace.slice(live.tracedAtLastNote).slice(-30)
  live.tracedAtLastNote = live.trace.length
  live.stepsAtLastNote = r.steps.length
  live.lastNoteAt = at
  const previous = r.notes.slice(-3).map(n => `- ${n.text}`).join('\n') || '(none yet)'
  const happened = traceLines(fresh)

  const controller = new AbortController()
  live.explaining = controller
  try {
    const reply = await $.model.complete(
      {
        model: 'haiku',
        system: NOTE_RULES,
        prompt: `The user's request:\n${live.ask.slice(0, 2000)}\n\nPrevious explanations:\n${previous}\n\nWhat happened since then:\n${happened}\n\nTime into the task: ${clock(at - r.startedAt)}`,
        maxTokens: 200,
        timeoutMs: HAIKU_TIMEOUT_MS,
      },
      { signal: controller.signal },
    )
    if (!reply.isAnswered || controller.signal.aborted) return
    const text = stripNiqqud(reply.text).replace(/\s+/g, ' ').trim()
    if (text) await update($, run, cur => cur && { ...cur, notes: [...cur.notes, { at, text }] })
  } catch {
    // An explanation that fails is skipped; the next one tries again.
  } finally {
    if (live.explaining === controller) live.explaining = undefined
  }
}

/** Answers a question typed into the band from the whole task so far; the answer lands in the run. */
async function answer($: EngineInterface, r: Run, question: string, at: number): Promise<void> {
  live.answering?.abort()
  const controller = new AbortController()
  live.answering = controller
  const ask: Ask = { at, question }
  await update($, run, cur => cur && { ...cur, asks: [...(cur.asks ?? []), ask].slice(-MAX_ASKS) })
  const running = r.steps.filter(s => s.endedAt === undefined).map(s => `- ${s.label}`).join('\n')
  const notes = r.notes.slice(-4).map(n => `- ${n.text}`).join('\n') || '(none yet)'
  const settle = (patch: Partial<Ask>) =>
    update($, run, cur => cur && { ...cur, asks: (cur.asks ?? []).map(a => (a.at === at ? { ...a, ...patch } : a)) })
  try {
    const reply = await $.model.complete(
      {
        model: 'haiku',
        system: ANSWER_RULES,
        prompt: `The user's request:\n${live.ask.slice(0, 2000)}\n\nWhat happened so far (latest last):\n${traceLines(live.trace.slice(-40)) || '(nothing yet)'}\n\nRunning right now:\n${running || '(nothing; thinking)'}\n\nExplanations already given:\n${notes}\n\nTime into the task: ${clock(at - r.startedAt)}\n\nThe user now asks:\n${question.slice(0, 500)}`,
        maxTokens: 300,
        timeoutMs: HAIKU_TIMEOUT_MS,
      },
      { signal: controller.signal },
    )
    if (controller.signal.aborted) return
    const text = reply.isAnswered ? stripNiqqud(reply.text).replace(/\s+/g, ' ').trim() : ''
    await settle(text ? { answer: text } : { failed: true })
  } catch {
    if (!controller.signal.aborted) await settle({ failed: true })
  } finally {
    if (live.answering === controller) live.answering = undefined
  }
}

/** Writes the one-line summary of a long task; drawn in place of the turn's closing line. */
async function summarize($: EngineInterface, finished: Run | null, answer: string, durationMs: number): Promise<void> {
  const notes = finished?.notes.map(n => `- ${n.text}`).join('\n') ?? ''
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system: SUMMARY_RULES,
      prompt: `What the user asked:\n${live.ask.slice(0, 2000)}\n\nProgress notes during the work:\n${notes || '(none)'}\n\nClaude's final answer:\n${answer.slice(-6000)}`,
      maxTokens: 200,
      timeoutMs: HAIKU_TIMEOUT_MS,
    })
    if (!reply.isAnswered) return
    const line = stripNiqqud(reply.text).replace(/\s+/g, ' ').trim()
    if (line) await update($, summaries, list => [...list, { durationMs, text: line }].slice(-20))
  } catch {
    // No summary this time; the closing line stays the engine's.
  }
}

/** Marks an answer as awaiting its translation, so its last block draws the pending line at once. */
async function expectTranslation($: EngineInterface, turnId: string, answer: string): Promise<void> {
  const whole = skeleton(answer)
  const entry: Translation = { turnId, tail: whole.slice(-TAIL_CHARS), length: whole.length, status: 'pending' }
  await update($, translations, list => [...list.filter(t => t.turnId !== turnId), entry].slice(-10))
}

/** Translates a mostly-English answer into Hebrew; drawn under the block that ends the answer. */
async function translate($: EngineInterface, turnId: string, answer: string): Promise<void> {
  const settle = (patch: Partial<Translation>) =>
    update($, translations, list => list.map(t => (t.turnId === turnId ? { ...t, ...patch } : t)))
  try {
    const source = answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) : answer
    // A reply that left English in, stopped early or remarked on the task is not shown: one
    // more try with the task restated and a larger cap, then the failed line.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const cap = tokensFor(source, attempt)
      const reply = await $.model.complete({
        model: 'haiku',
        system: TRANSLATE_RULES,
        prompt: translationPrompt(source, attempt > 1),
        maxTokens: cap,
        timeoutMs: TRANSLATE_TIMEOUT_MS,
      })
      if (!reply.isAnswered) break
      const text = stripNiqqud(reply.text).trim()
      const isCut = reply.usage.output_tokens >= cap
      if (text && !isCut && looksTranslated(text)) {
        await settle({ status: 'done', text })
        return
      }
    }
    await settle({ status: 'failed' })
  } catch {
    await settle({ status: 'failed' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const saved = Number(await $.store.get(EVERY_KEY))
    if (EVERY_OPTIONS.some(o => o.ms === saved)) await update($, everyMs, () => saved)
    const translateSaved = await $.store.get(TRANSLATE_KEY)
    if (typeof translateSaved === 'boolean') await update($, translateOn, () => translateSaved)
    await $.command.register({
      name: 'translate',
      description: 'תרגום לעברית של תשובות באנגלית: הדלקה, כיבוי או מצב (on / off)',
      argumentHint: 'on|off',
      immediate: true,
    })
    await refreshLimits($)
    return result
  })

  on('command.run', { command: 'translate' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, translateOn)
    const wanted = arg === 'on' ? true : arg === 'off' ? false : arg === '' ? !current : undefined
    if (wanted === undefined) return { text: 'שימוש: /translate, /translate on או /translate off' }
    await update($, translateOn, () => wanted)
    await $.store.set(TRANSLATE_KEY, wanted).catch(() => undefined)
    return {
      text: wanted
        ? 'תרגום לעברית פועל: תשובות שרובן באנגלית יקבלו תרגום מתחתן.'
        : 'תרגום לעברית כבוי.',
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await update($, limits, () => toLimits(e.rateLimits))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    live.ask = e.text || live.ask
    live.trace = []
    live.tracedAtLastNote = 0
    live.stepsAtLastNote = 0
    live.lastNoteAt = t
    live.explaining?.abort()
    live.answering?.abort()
    await update($, now, () => t)
    await update($, isAsking, () => false)
    await update($, run, (): Run => ({ startedAt: t, steps: [], notes: [], idleSince: t, asks: [] }))
    await refreshLimits($)
    live.ticker?.cancel()
    live.ticker = $.clock.every(1000, async () => {
      const tick = await $.clock.now()
      await update($, now, () => tick)
      const r = await read($, run)
      if (r && shouldExplain(r, tick, await read($, everyMs))) void explain($, r, tick)
    })
    return next(e)
  })

  on('session.append', { door: 'response' }, (_$, e, next) => {
    if (e.agentId === undefined) {
      for (const block of e.message.content) {
        const text =
          block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined
        if (typeof text === 'string' && text.trim()) {
          live.trace.push({ kind: 'said', text: text.trim().slice(0, 600) })
        }
      }
    }
    return next(e)
  }).catch((_$, e, next) => {
    // Collecting words for the explanations must never stop a row being kept.
    if (next.called) throw new Error('whats-happening: session.append failed after keeping the row')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const id = e.tool_use_id ?? `call-${++live.seq}`
    const input = e as unknown as Record<string, unknown>
    const label = describe(e.tool, input)
    const step: Trace = { kind: 'step', text: detail(e.tool, input) }
    live.trace.push(step)
    const since = await $.clock.now()
    await update($, run, r => r && { ...r, steps: [...r.steps, { id, label, since }] })
    try {
      const result = await next(e)
      if (result.deny !== undefined) step.text += ' (it was refused)'
      else step.text += outcome(e.tool, result.text, result.isError === true)
      return result
    } finally {
      const done = await $.clock.now()
      await update($, run, r =>
        r && {
          ...r,
          steps: r.steps.map(s => (s.id === id ? { ...s, endedAt: done } : s)),
          idleSince: done,
        },
      )
    }
  }).catch(($, e, next) =>
    // The band is only a display: if its bookkeeping fails, the tool still runs.
    next.called ? { deny: `${$.plugin.name}: the status band failed around this call.` } : next(e),
  )

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    live.ticker?.cancel()
    live.ticker = undefined
    live.explaining?.abort()
    live.answering?.abort()
    const finished = await read($, run)
    await update($, run, () => null)

    if (e.reason !== 'answer' || e.answer.trim() === '') return result
    const { answer, durationMs, turnId } = e
    const isLong = durationMs >= SUMMARY_MS
    const wantsHebrew = (await read($, translateOn)) && needsTranslation(answer)
    if (!isLong && !wantsHebrew) return result
    if (wantsHebrew) await expectTranslation($, turnId, answer)

    // Both are drawn from `$.state`, not returned as the result's text (the engine prefixes
    // that text with the name of every plugin hooking it): the summary in place of the turn's
    // closing line, the translation under the answer's last block. Neither waits for Haiku: the
    // closing line draws at once, and a timer of its own does the work, so the hook's dispatch
    // is not what the model calls hang on.
    $.clock.after(1, () => {
      if (isLong) void summarize($, finished, answer, durationMs)
      if (wantsHebrew) void translate($, turnId, answer)
    })
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const list = await read($, translations)
    const english = e.props.text
    const t = list.find(one => isAnswerEnd(english, one.tail, one.length))
    if (!t) return next(e)
    // The English as the engine draws it, a rule, then the Hebrew drawn here block by block.
    // With the screen's width known, each paragraph or list item is wrapped here and every
    // line is drawn as its own right-aligned row (a box's alignment holds for bold and italic
    // text, where the engine's own flush-right for `dir` does not); without it, one Text.
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const drawnEnglish = await next(e)
    const columns = e.viewport?.columns
    const width = columns ? Math.max(20, columns - 8) : 0
    const styled = (key: string, rs: TextRun[]) =>
      rs.map((r, i) =>
        r.bold || r.italic || r.code ? (
          <Text key={`${key}-${i}`} dir="rtl" bold={r.bold} italic={r.italic} color={r.code ? 'claude' : undefined}>
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )
    // A block is a column (its rows stretch to the full width, so flush right is the
    // message's right edge) directly inside the outer column; no wrapper box.
    const block = (key: string, rs: TextRun[], dim?: true, marker?: string, gap = 0) =>
      width > 0 ? (
        <Box key={key} flexDirection="column" alignItems="flex-end" marginTop={gap}>
          {wrapRuns(rs, width - (marker ? marker.length + 1 : 0)).map((l, i) => (
            <Text key={`${key}-${i}`} dir="rtl" dimColor={dim}>
              {marker && i === 0 ? <Text color="claude">{marker} </Text> : null}
              {styled(`${key}-${i}`, l)}
            </Text>
          ))}
        </Box>
      ) : (
        <Box key={key} marginTop={gap}>
          <Text wrap="wrap" dir="rtl" dimColor={dim}>
            {marker ? <Text color="claude">{marker} </Text> : null}
            {styled(key, rs)}
          </Text>
        </Box>
      )
    const hebrew =
      t.status === 'done' && t.text ? (
        hebrewBlocks(t.text).map((b, i) =>
          b.kind === 'markdown' ? (
            <Box key={`b${i}`} marginTop={i === 0 ? 0 : 1}>
              <Markdown text={b.text} />
            </Box>
          ) : b.kind === 'item' ? (
            block(`b${i}`, b.runs, undefined, b.marker)
          ) : (
            block(`b${i}`, b.bold ? b.runs.map(r => ({ ...r, bold: true as const })) : b.runs, b.dim, undefined, i === 0 ? 0 : 1)
          ),
        )
      ) : (
        block('state', [{ text: t.status === 'failed' ? FAILED_TEXT : PENDING_TEXT }], true)
      )
    return (
      <Box flexDirection="column">
        {drawnEnglish}
        <Box marginTop={1} marginBottom={1} justifyContent="flex-end">
          <Text dimColor>{'─'.repeat(Math.max(10, (columns ?? 60) - 4))}</Text>
        </Box>
        {hebrew}
      </Box>
    )
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const list = await read($, summaries)
    const summary = list.find(s => Math.abs(s.durationMs - e.props.durationMs) <= SAME_TURN_MS)
    if (!summary) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text wrap="wrap">
        <Text color="claude">● </Text>
        <Text dimColor>בקצרה: </Text>
        {summary.text}
      </Text>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    if (!e.props.isWorking || e.props.hasSurvey || r === null) return next(e)
    // The band is drawn on the terminal and desktop only; mobile has no Input element.
    if (e.surface === 'mobile') return next(e)

    const t = Math.max(await read($, now), r.startedAt)
    const open = await read($, isOpen)
    const picking = await read($, isPicking)
    const asking = await read($, isAsking)
    const translating = await read($, translateOn)
    const every = await read($, everyMs)
    const used = await read($, limits)
    const running = r.steps.filter(s => s.endedAt === undefined)
    const latest = running[running.length - 1]
    const oldest = running[0]
    const activity = latest
      ? running.length > 1 ? `${latest.label} (ועוד ${running.length - 1})` : latest.label
      : 'חושב'
    const age = t - (oldest ? oldest.since : r.idleSince)
    const isStuck = age >= STUCK_MS
    const lastNote = r.notes[r.notes.length - 1]
    const earlier = r.notes.slice(0, -1).reverse()
    const isHigh = (n: number | undefined) => (n ?? 0) >= 80

    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const choose = async (ms: number) => {
      await update($, everyMs, () => ms)
      await update($, isPicking, () => false)
      await $.store.set(EVERY_KEY, ms).catch(() => undefined)
    }
    const toggleTranslate = async () => {
      const show = !(await read($, translateOn))
      await update($, translateOn, () => show)
      await $.store.set(TRANSLATE_KEY, show).catch(() => undefined)
    }
    const toggleAsking = async () => {
      const show = !(await read($, isAsking))
      await update($, isAsking, () => show)
      if (show) await $.ui.focus({ requestId: e.requestId, key: 'question' }).catch(() => undefined)
    }
    const submit = async (value: string) => {
      await update($, isAsking, () => false)
      const question = value.trim()
      const cur = await read($, run)
      if (question && cur) await answer($, cur, question, await $.clock.now())
    }
    const dismiss = (at: number) => update($, run, cur => cur && { ...cur, asks: (cur.asks ?? []).filter(a => a.at !== at) })

    // Right-aligned Hebrew: each text is broken into lines here and every line is drawn
    // flush right (one wrapped Text leaves its lines flush left). Width = the band's own
    // cells (`bodyColumns`: the column less the engine's `[-]`; never `viewport.columns`)
    // less the limits box (widest line, border, padding), this box's border and padding,
    // and a safety margin. Without a usable width: one wrapped Text.
    const fiveLine = `${percent(used.fiveHour)} 5 שעות`
    const weekLine = `${percent(used.week)} שבועי`
    const limitsWidth = Math.max([...fiveLine].length, [...weekLine].length) + 4
    const bodyColumns = typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns : 0
    const textWidth = bodyColumns - limitsWidth - 4 - 1
    const rtl = (key: string, text: string, dim = false, prefix?: string, width = textWidth) =>
      width >= 20 ? (
        <Box key={key} flexDirection="column" alignItems="flex-end">
          {wrapLines(mirrorBrackets(text), width - (prefix ? prefix.length : 0)).map((l, i) => (
            <Text key={`${key}-${i}`} dimColor={dim}>
              {prefix && i === 0 ? <Text color="claude">{prefix}</Text> : null}
              {l}
            </Text>
          ))}
        </Box>
      ) : (
        <Text key={key} wrap="wrap" dimColor={dim}>
          {prefix ? <Text color="claude">{prefix}</Text> : null}
          {text}
        </Text>
      )

    return (
      <Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} borderStyle="round" borderDimColor paddingX={1}>
          {/* Buttons pinned at the left edge, the status flush right: neither moves when the
              activity's text changes length. */}
          <Box justifyContent="space-between">
            <Box flexShrink={0}>
            <Button
              key="toggle"
              plain
              label={open ? '▴' : '▾'}
              onPress={() => update($, isOpen, v => !v)}
            />
            <Box marginLeft={1}>
              <Button
                key="every"
                plain
                dimColor={!picking}
                label="↻"
                onPress={() => update($, isPicking, v => !v)}
              />
            </Box>
            <Box marginLeft={1}>
              <Button key="ask" plain dimColor={!asking} label="?" onPress={toggleAsking} />
            </Box>
            {/* The translation switch, a filled square and lit text while English answers get
                a Hebrew translation, an empty square and dim text while they do not. */}
            <Box marginLeft={2}>
              <Button key="translate" plain label="תרגם" onPress={toggleTranslate}>
                {translating ? <Text color="claude">■ תרגם</Text> : <Text dimColor>□ תרגם</Text>}
              </Button>
            </Box>
            </Box>
            {/* A layout gap, not a space inside the Hebrew text: that text is drawn right-to-left
                as one run, so a leading space in it lands at its far end and the step number
                at the start, against the button. */}
            <Box marginLeft={2} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={isStuck ? 'warning' : 'claude'}>● </Text>
                <Text bold>{activity}</Text>
                <Text dimColor>{'  ·  '}צעד {r.steps.length}</Text>
              </Text>
            </Box>
          </Box>
          {picking ? (
            <Box key="picker" justifyContent="flex-end">
              {EVERY_OPTIONS.map(o => (
                <Box key={`o${o.ms}`} marginRight={2}>
                  <Button key={`every-${o.ms}`} plain onPress={() => choose(o.ms)}>
                    {o.ms === every ? <Text color="claude" bold>{o.label}</Text> : <Text dimColor>{o.label}</Text>}
                  </Button>
                </Box>
              ))}
            </Box>
          ) : null}
          {asking ? (
            // The engine draws the field at its own width with the text at its left end, so it
            // cannot sit flush right like the rest; anchored left, it at least starts at the
            // edge. The submit hint is the enter glyph alone: a Hebrew label was drawn glued
            // to the typed text.
            <Box key="question-row" justifyContent="flex-start">
              <Box width={textWidth >= 20 ? Math.min(textWidth, 72) : undefined} flexGrow={textWidth >= 20 ? 0 : 1}>
                <Input
                  key="question"
                  autoFocus
                  placeholder="מה תרצה לדעת על מה שקורה עכשיו?"
                  submitLabel=" "
                  onSubmit={submit}
                />
              </Box>
            </Box>
          ) : every === 0 ? null : lastNote ? (
            rtl('note', lastNote.text)
          ) : (
            rtl('note', 'ההסבר הראשון יופיע אחרי כמה צעדים', true)
          )}
          {/* Each question with its answer under it, flush right, and a close button pinned
              at the left edge of its own row; the text is sized to what the button leaves. */}
          {!asking
            ? (r.asks ?? []).map(a => (
                <Box key={`ask${a.at}`} justifyContent="space-between" marginTop={1}>
                  <Box flexShrink={0} marginRight={2}>
                    <Button key={`close-${a.at}`} plain dimColor label="×" onPress={() => dismiss(a.at)} />
                  </Box>
                  <Box flexDirection="column" alignItems="flex-end" flexShrink={1}>
                    {rtl(`q${a.at}`, a.question, true, '? ', textWidth - 3)}
                    {a.answer
                      ? rtl(`r${a.at}`, a.answer, false, undefined, textWidth - 3)
                      : a.failed
                        ? rtl(`r${a.at}`, 'לא הצלחתי לענות הפעם; אפשר לנסות שוב', true, undefined, textWidth - 3)
                        : rtl(`r${a.at}`, '… עונה', true, undefined, textWidth - 3)}
                  </Box>
                </Box>
              ))
            : null}
          {isStuck ? (
            <Box key="stuck" justifyContent="flex-end">
              <Text color="warning" wrap="truncate-end">
                אותה פעולה רצה כבר {minutes(age)}. אם זה לא צפוי, אפשר לעצור עם Esc.
              </Text>
            </Box>
          ) : null}
          {open && earlier.length === 0 ? rtl('none', 'אין עדיין הסברים קודמים', true) : null}
          {open
            ? earlier.map(n => rtl(`n${n.at}`, n.text, true))
            : null}
        </Box>
        <Box key="limits" flexDirection="column" flexShrink={0} borderStyle="round" borderDimColor paddingX={1}>
          <Text>
            <Text color={isHigh(used.fiveHour) ? 'warning' : undefined}>{percent(used.fiveHour)}</Text>
            <Text dimColor> 5 שעות</Text>
          </Text>
          <Text>
            <Text color={isHigh(used.week) ? 'warning' : undefined}>{percent(used.week)}</Text>
            <Text dimColor> שבועי</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
