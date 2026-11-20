import type { EngineInterface, Register } from 'claude-code'
import { STUFEN } from './stufen'

// Geführte Session (Konzept `guided-session` im Gefüge): Eine Claude-Code-Session verbindet sich nur auf den
// ausdrücklichen Befehl /fachwerk-verbinden in genau dieser Session als Host mit einem Gespräch im Gefüge. Erst dann
// meldet sie die Eingabe der Person, Tool-Zeilen (Werkzeug, Ziel, Dauer, Erfolg; nie Argumente oder Ergebnisse) und
// die Antwort am Turn-Ende, bringt Lotsenimpulse und wartende Beiträge zurück und wird von neuen Beiträgen geweckt.
// Ohne Verbindung beendet sich jeder Hook sofort und ruft das Gefüge nicht auf. Alle Aufrufe laufen über die
// angemeldete MCP-Verbindung des Plugins; das Modul kennt kein Secret.

const SERVER = 'fachwerk-gpe'
const CLIENT = 'Claude Code'
// Höchstens so viele Ereignisse nimmt chat.append_host_events je Aufruf an.
const BATCH = 100
const WAIT_MS = 25_000
const NAME_CHARS = 100
const MAX_TEXT = 16_000
// So viele Ereignisse hält das Plugin, während das Gefüge nicht erreichbar ist; die ältesten Tool-Zeilen gehen zuerst.
const MAX_EVENTS = 1000
// So oft hält der Stop-Hook ein Turn-Ende für Impulse an; wartende Beiträge gehen immer in die Session.
const MAX_GUIDANCE = 3
const NOT_CONNECTED = 'chat_host_not_connected'
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
const EVENT_ID = /^[A-Za-z0-9_-]{8,100}$/

export type HostEvent =
  | { kind: 'user_input'; eventId: string; text: string }
  | { kind: 'tool_call'; eventId: string; tool: string; target?: string; durationMs: number; success: boolean }
  | { kind: 'turn_end'; eventId: string; text: string }
type Link = { instance?: string; conversationId: string; profile?: string; queue: HostEvent[] }
type Impulse = { skillId?: unknown; name?: unknown; reason?: unknown }
type Waiting = { text?: unknown; files?: unknown }
type Answer = { impulses?: unknown; waiting?: unknown }

class Refused extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

// Wofür ein eingebautes Werkzeug da ist, in Klartext; nie ein Argument.
const TARGETS: Record<string, string> = {
  Bash: 'Shell-Befehl ausführen', Read: 'Datei lesen', Edit: 'Datei ändern', Write: 'Datei schreiben',
  NotebookEdit: 'Notebook ändern', Grep: 'Inhalte durchsuchen', Glob: 'Dateien finden', WebFetch: 'Webseite abrufen',
  WebSearch: 'Im Web suchen', Agent: 'Subagent beauftragen', Task: 'Subagent beauftragen', TodoWrite: 'Aufgabenliste pflegen',
  Skill: 'Skill laden',
}

const S = {
  sessionId: '',
  server: '',
  link: undefined as Link | undefined,
  // Das Gefüge nimmt von dieser Session nichts mehr an (übernommen oder anderswo getrennt).
  takenOver: false,
  stopped: undefined as string | undefined,
  busy: false,
  listening: false,
  generation: 0,
  failures: 0,
  guided: 0,
  chain: Promise.resolve() as Promise<unknown>,
}

const clip = (text: string, max: number) => [...text.replace(/\0/g, '')].slice(0, max).join('')
// Ein Name oder eine Zeile ohne Steuerzeichen, wie das Gefüge sie annimmt.
const line = (text: string, max: number) => clip(text.replace(/\p{Cc}+/gu, ' '), max).trim()
const stufeOf = (profile: string | undefined) => (profile && Object.hasOwn(STUFEN, profile) ? STUFEN[profile] : undefined)
const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)
const storeKey = () => 'link:' + S.sessionId
const note = ($: EngineInterface, text: string) => $.ui.log('Fachwerk: ' + text, { to: 'debug' })

export function toolLine(tool: string, eventId: string | undefined, durationMs: number, success: boolean): HostEvent {
  const name = line(tool, NAME_CHARS) || '?'
  const server = /^mcp__(.+?)__/.exec(name)?.[1]
  const target = (Object.hasOwn(TARGETS, name) ? TARGETS[name] : undefined) ?? (server ? line('Werkzeug des MCP-Servers ' + server, NAME_CHARS) : undefined)
  return { kind: 'tool_call', eventId: eventId && EVENT_ID.test(eventId) ? eventId : crypto.randomUUID(), tool: name,
    ...(target ? { target } : {}), durationMs: Math.max(0, Math.round(durationMs)), success }
}

// Die nächste Sendung: höchstens BATCH Ereignisse, ein turn_end nur als letztes.
export function nextBatch(queue: readonly HostEvent[]): HostEvent[] {
  const end = queue.findIndex(event => event.kind === 'turn_end')
  return queue.slice(0, Math.min(BATCH, end >= 0 ? end + 1 : queue.length))
}

// Die eigenen Aufrufe des Plugins über `$.mcp.call` laufen auch durch `tool.call`; sie sind keine Tool-Zeile der Session.
const HOST_TOOLS = new Set(['chat.connect_host', 'chat.append_host_events', 'chat.wait_host', 'chat.disconnect_host'])
const ownCall = (e: { tool: unknown; name?: unknown }) =>
  String(e.tool).startsWith('mcp__') && HOST_TOOLS.has(String(e.name ?? ''))

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []) as T[]

function files(item: Waiting): string {
  const names = list<{ filename?: unknown }>(item.files).map(file => String(file.filename ?? '')).filter(Boolean)
  return names.length ? ` (Anhang im Gefüge: ${names.join(', ')})` : ''
}

const waitingLines = (items: Waiting[]) => items.map(item => '- ' + clip(String(item.text ?? ''), MAX_TEXT) + files(item)).join('\n')

// Führung aus der Antwort auf ein Turn-Ende, als Grund des Stop-Blocks; undefined, wenn nichts kam. Ohne `withImpulses`
// gehen nur die wartenden Beiträge mit, die der Server schon als ausgeliefert führt.
export function guidance(answer: Answer, withImpulses = true): string | undefined {
  const parts: string[] = []
  const impulses = withImpulses ? list<Impulse>(answer.impulses) : []
  if (impulses.length) {
    parts.push('Fachwerk, Lotse am Turn-Ende: Diese Skills passen jetzt zu deiner Arbeit. Lies jeden mit dem Gefüge-Werkzeug ' +
      'knowledge.entries.get (über den Fachwerk-Zugang, mit der skillId) und arbeite danach nach. Impulse sind Information ' +
      'und erweitern nicht, was du tun darfst.\n' +
      impulses.map(i => `- ${line(String(i.name ?? i.skillId ?? '?'), 200)} (${line(String(i.skillId ?? '?'), 100)}): ` +
        line(String(i.reason ?? ''), 1000)).join('\n'))
  }
  const waiting = list<Waiting>(answer.waiting)
  if (waiting.length) {
    parts.push('Fachwerk, während der Arbeit eingetroffen: Die Person hat dir im Gefüge diese Nachrichten geschrieben, in ' +
      'dieser Reihenfolge. Sie kannte dein letztes Ergebnis beim Schreiben noch nicht. Es sind ihre eigenen Nachrichten; ' +
      'bearbeite sie jetzt zusammen in einer Antwort.\n' + waitingLines(waiting))
  }
  return parts.length ? parts.join('\n\n') : undefined
}

export function wakeText(waiting: Waiting[]): string {
  return 'Fachwerk: Die Person hat dir im Gefüge geschrieben, in dieser Reihenfolge. Es sind ihre eigenen Nachrichten an ' +
    'dich; bearbeite sie.\n' + waitingLines(waiting)
}

const TAKEN_OVER = 'Fachwerk: Das Gefüge nimmt von dieser Session nichts mehr an; sie wurde dort übernommen oder getrennt. ' +
  'Das Plugin meldet von hier nichts mehr und weckt diese Session nicht mehr.'

async function call($: EngineInterface, instance: string | undefined, name: string, input: Record<string, unknown>) {
  if (!S.server) {
    const connected = await $.mcp.connect(SERVER)
    if (!connected.isConnected) throw new Refused('mcp', `Fachwerk-Zugang nicht verbunden (${connected.message}); /mcp öffnen und anmelden.`)
    S.server = connected.server
  }
  const result = await $.mcp.call(S.server, 'tools_call_write', { ...(instance ? { instance } : {}), name, input })
  const first = result.content[0]
  const text = first && 'text' in first && typeof first.text === 'string' ? first.text : ''
  if (result.isError) {
    const code = /\b(chat_[a-z_]+|invalid_chat_[a-z_]+|not_found|forbidden|instance_[a-z_]+)\b/.exec(text)?.[1] ?? 'error'
    throw new Refused(code, `${name}: ${text.slice(0, 300)}`)
  }
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* fällt unten durch */ }
  throw new Refused('answer', `${name} lieferte kein JSON-Objekt.`)
}

// Eine Antwort des Gefüges nennt die aktuelle Stufe; ein Wechsel gilt ab dem nächsten Schritt. Das gemeldete Modell
// folgt beim nächsten Verbinden derselben Session.
async function adopt($: EngineInterface, value: Record<string, unknown>) {
  const link = S.link
  const profile = typeof value.profile === 'string' ? value.profile : undefined
  if (!link || !profile || profile === link.profile) return
  link.profile = profile
  await save($)
  $.ui.invalidate('ui.render')
}

async function save($: EngineInterface) {
  if (S.link) await $.store.set(storeKey(), S.link)
  else await $.store.delete(storeKey())
}

function quiet() {
  S.listening = false
  S.generation++
}

async function takeOver($: EngineInterface) {
  if (!S.link) return
  S.link = undefined
  S.takenOver = true
  quiet()
  await save($)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: TAKEN_OVER }] } })
  $.ui.toast('Fachwerk: Session im Gefüge übernommen; hier wird nichts mehr gemeldet.')
  $.ui.invalidate('ui.render')
}

async function send($: EngineInterface): Promise<Answer | undefined> {
  let answer: Answer | undefined
  while (S.link?.queue.length) {
    const link = S.link
    const batch = nextBatch(link.queue)
    try {
      const value = await call($, link.instance, 'chat.append_host_events',
        { conversationId: link.conversationId, sessionId: S.sessionId, events: batch })
      if (batch.at(-1)?.kind === 'turn_end') answer = value
      await adopt($, value)
    } catch (error) {
      if (!(error instanceof Refused) || error.code === 'mcp') throw error
      if (error.code === NOT_CONNECTED) { await takeOver($); return undefined }
      // Nur eine inhaltlich abgewiesene Sendung entfällt, weil eine Wiederholung wieder abgewiesen würde.
      if (!/^(invalid_chat_host_events|chat_request_conflict)$/.test(error.code)) throw error
      note($, 'Ereignisse abgewiesen: ' + error.message)
    }
    link.queue.splice(0, batch.length)
    await save($)
  }
  return answer
}

// Sendet, was ansteht, in Reihenfolge; ein Fehler im Netz lässt die Ereignisse mit ihren IDs für den nächsten Versuch.
function flush($: EngineInterface): Promise<Answer | undefined> {
  const run = S.chain.then(() => send($), () => send($))
  S.chain = run.catch(() => undefined)
  return run
}

async function enqueue($: EngineInterface, event: HostEvent) {
  const queue = S.link!.queue
  queue.push(event)
  while (queue.length > MAX_EVENTS) {
    const oldest = queue.findIndex(item => item.kind === 'tool_call')
    queue.splice(oldest >= 0 ? oldest : 0, 1)
  }
  await save($)
}

function schedule($: EngineInterface, ms: number) {
  const mine = S.generation
  $.clock.after(ms, () => { if (mine === S.generation) void tick($, mine) })
}

// Warten auf Beiträge, solange die verbundene Session ruht. Ein Beitrag weckt sie mit einem eigenen Turn.
async function tick($: EngineInterface, mine: number) {
  const link = S.link
  if (!link || S.busy) { if (mine === S.generation) S.listening = false; return }
  try {
    const value = await call($, link.instance, 'chat.wait_host',
      { conversationId: link.conversationId, sessionId: S.sessionId, waitMs: WAIT_MS })
    S.failures = 0
    S.stopped = undefined
    const waiting = list<Waiting>(value.waiting)
    await adopt($, value)
    // Ausgelieferte Beiträge sind die nächste Eingabe; sie gehen in die Session, auch wenn inzwischen ein Turn läuft.
    if (waiting.length && S.link?.conversationId === link.conversationId) {
      if (mine === S.generation) S.listening = false
      const entered = await $.prompt.submit({ text: wakeText(waiting) })
      if (entered.drop !== undefined) note($, 'Weckender Beitrag nicht angenommen: ' + entered.drop)
      return
    }
    if (mine === S.generation) schedule($, 0)
  } catch (error) {
    if (error instanceof Refused) {
      if (mine === S.generation) S.listening = false
      if (error.code === NOT_CONNECTED) return takeOver($)
      S.stopped = error.message
      note($, error.message)
      $.ui.invalidate('ui.render')
      return
    }
    // Netz oder Neustart des Gefüges: zurückhaltend weiter warten.
    S.failures++
    note($, `Warten fehlgeschlagen (${S.failures}): ${message(error)}`)
    if (mine === S.generation) schedule($, Math.min(60_000, 5000 * 2 ** Math.min(S.failures, 4)))
  }
}

function listen($: EngineInterface) {
  if (S.listening || !S.link || S.busy) return
  S.listening = true
  S.generation++
  schedule($, 0)
  $.ui.invalidate('ui.render')
}

async function machine($: EngineInterface): Promise<string> {
  for (const argv of [['scutil', '--get', 'LocalHostName'], ['hostname', '-s']]) {
    try {
      const done = await $.process.run(argv, { timeoutMs: 3000 })
      if (done.exitCode === 0 && done.stdout.trim()) return clip(done.stdout.trim(), NAME_CHARS)
    } catch { /* nächster Weg */ }
  }
  return 'unbekannter Rechner'
}

const effective = (profile: string | undefined, model: string) => {
  const stufe = stufeOf(profile)
  return stufe ? `${stufe.model} · ${stufe.effort}` : model
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

// Verbindet diese Session; mit `takeOver` übernimmt sie das genannte Gespräch von einem anderen Host derselben Person.
async function connect($: EngineInterface, instance: string | undefined, takeOver?: string): Promise<string> {
  if (S.link) return `Diese Session ist schon mit Fachwerk verbunden (Gespräch ${S.link.conversationId}). Trennen: /fachwerk-trennen`
  const host = { sessionId: S.sessionId, client: CLIENT, machine: await machine($), model: clip(await $.session.model(), NAME_CHARS) }
  try {
    const answer = await call($, instance, 'chat.connect_host', takeOver ? { ...host, conversationId: takeOver, takeOver: true } : host)
    const conversationId = String(answer.conversationId)
    const profile = typeof answer.profile === 'string' ? answer.profile : undefined
    S.link = { ...(instance ? { instance } : {}), conversationId, ...(profile ? { profile } : {}), queue: [] }
    S.takenOver = false
    S.stopped = undefined
    await save($)
    listen($)
    // Der Host meldet das Modell, mit dem er die Session nach ihrer Stufe tatsächlich führt.
    const model = effective(profile, host.model)
    if (model !== host.model) {
      try { await call($, instance, 'chat.connect_host', { ...host, conversationId, model }) }
      catch (error) { note($, 'Modell der Stufe nicht gemeldet: ' + message(error)) }
    }
    const stufe = stufeOf(profile)
    return `${takeOver ? 'Session übernommen; mit' : 'Mit'} Fachwerk verbunden${instance ? ` (${instance})` : ''}, Gespräch ${conversationId}. Ab jetzt gehen deine Eingaben, ` +
      'Tool-Zeilen (ohne Argumente und Ergebnisse) und die Antworten in dieses Gespräch, und neue Beiträge dort wecken die Session. ' +
      (stufe ? `Stufe ${stufe.label}: ${stufe.model} · ${stufe.effort}. ` : '') + 'Trennen: /fachwerk-trennen'
  } catch (error) {
    if (error instanceof Refused && /instance/.test(error.code + error.message) && !instance) {
      return 'Nenne die Fachwerk-Instanz: /fachwerk-verbinden <instanz>. ' + error.message
    }
    return 'Verbinden fehlgeschlagen: ' + message(error)
  }
}

// Eine fortgesetzte Session verbindet sich erneut: Was das Gefüge vor einem Absturz schon geliefert hatte, kommt dann
// noch einmal, und das gemeldete Modell folgt der aktuellen Stufe.
async function resume($: EngineInterface) {
  const link = S.link!
  const model = clip(await $.session.model(), NAME_CHARS)
  try {
    const answer = await call($, link.instance, 'chat.connect_host', { conversationId: link.conversationId, sessionId: S.sessionId,
      client: CLIENT, machine: await machine($), model: effective(typeof link.profile === 'string' ? link.profile : undefined, model) })
    await adopt($, answer)
  } catch (error) {
    if (error instanceof Refused && error.code !== 'mcp') return takeOver($)
    note($, 'Erneutes Verbinden fehlgeschlagen: ' + message(error))
  }
  listen($)
}

async function disconnect($: EngineInterface): Promise<string> {
  const link = S.link
  if (!link) return 'Diese Session ist nicht mit Fachwerk verbunden.'
  try { await flush($) } catch (error) { note($, 'Letzte Ereignisse nicht gesendet: ' + message(error)) }
  if (S.link !== link) return TAKEN_OVER
  try {
    await call($, link.instance, 'chat.disconnect_host', { conversationId: link.conversationId, sessionId: S.sessionId })
  } catch (error) {
    if (!(error instanceof Refused) || error.code !== NOT_CONNECTED) {
      return 'Trennen fehlgeschlagen, die Session bleibt verbunden: ' + message(error)
    }
  }
  S.link = undefined
  quiet()
  await save($)
  $.ui.invalidate('ui.render')
  return `Von Fachwerk getrennt (Gespräch ${link.conversationId}). Diese Session meldet nichts mehr und wird nicht mehr geweckt.`
}

// Die Verbindung über dem Prompt, wie der Indikator des Leitstands; ohne Verbindung keine Zeile.
function band($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box, Text } = $.ui.resolve(e)
  const head = (color: 'success' | 'warning') => [Text({ color, children: '●' }), Text({ weight: 'semibold', children: 'Fachwerk' })]
  if (!S.link) {
    return Box({ flexDirection: 'row', gap: 1, children: [...head('warning'), Text({ color: 'warning', children: 'übernommen' }),
      Text({ dimColor: true, size: 'footnote', wrap: 'truncate-end', children: 'Die Session wird jetzt woanders geführt; hier wird nichts mehr gemeldet.' })] })
  }
  const stufe = stufeOf(S.link.profile)
  const state = S.stopped ? 'hört nicht zu: ' + S.stopped : S.busy ? 'meldet' : S.listening ? 'hört zu' : 'verbunden'
  return Box({ flexDirection: 'row', gap: 1, children: [...head(S.stopped ? 'warning' : 'success'),
    Text({ children: 'verbunden' + (S.link.instance ? ' mit ' + S.link.instance : '') }),
    ...(stufe ? [Text({ dimColor: true, children: `Stufe ${stufe.label} · ${stufe.model} · ${stufe.effort}` })] : []),
    Text({ dimColor: true, size: 'footnote', wrap: 'truncate-end', children: state })] })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S.sessionId = await $.session.id()
    S.link = (await $.store.get(storeKey())) as Link | undefined
    S.takenOver = false
    await $.command.register({ name: 'fachwerk-verbinden', description: 'Diese Session ausdrücklich mit einem Fachwerk-Gespräch verbinden', argumentHint: '[instanz]' })
    await $.command.register({ name: 'fachwerk-trennen', description: 'Diese Session von Fachwerk trennen' })
    await $.command.register({ name: 'fachwerk-uebernehmen', description: 'Ein Fachwerk-Gespräch, das ein anderer Client führt, in diese Session übernehmen', argumentHint: '<gespräch> [instanz]' })
    if (S.link) await resume($)
    return started
  })

  on('command.run', { command: 'fachwerk-verbinden' }, async ($, e) => {
    const instance = e.args.trim() || undefined
    return { text: instance && !SLUG.test(instance) ? 'Nenne die Instanz mit ihrem slug: /fachwerk-verbinden <instanz>' : await connect($, instance) }
  })
  on('command.run', { command: 'fachwerk-uebernehmen' }, async ($, e) => {
    const [conversation, instance, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (!conversation || !SLUG.test(conversation) || (instance && !SLUG.test(instance)) || rest.length) {
      return { text: 'Nenne das Gespräch: /fachwerk-uebernehmen <gespräch> [instanz]' }
    }
    return { text: await connect($, instance, conversation) }
  })
  on('command.run', { command: 'fachwerk-trennen' }, async $ => ({ text: await disconnect($) }))

  on('prompt.submit', async ($, e, next) => {
    if (!S.link || e.command || e.isMeta || !HUMAN_ORIGINS.has(e.origin?.kind ?? 'unclassified') || !e.text.trim()) return next(e)
    try { await enqueue($, { kind: 'user_input', eventId: crypto.randomUUID(), text: clip(e.text, 64_000) }) }
    catch (error) { note($, 'Eingabe nicht erfasst: ' + message(error)) }
    void flush($).catch(error => note($, 'Eingabe noch nicht gemeldet: ' + message(error)))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (S.link && e.agentId === undefined) {
      S.busy = true
      quiet()
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Die Stufe der verbundenen Session bestimmt Modell und Denkstufe jedes Schritts des Hauptloops.
  on('turn.step', async function* ($, e, next) {
    const stufe = e.agentId === undefined ? stufeOf(S.link?.profile) : undefined
    return yield* next(stufe ? { ...e, model: stufe.model, effort: stufe.effort } : e)
  })

  on('tool.call', async ($, e, next) => {
    if (!S.link || e.agentId !== undefined || ownCall(e)) return next(e)
    const at = await $.clock.now()
    const result = await next(e)
    if (S.link) {
      const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
      await enqueue($, toolLine(String(e.tool), id, (await $.clock.now()) - at, result.isError !== true && result.deny === undefined))
        .catch(error => note($, 'Tool-Zeile nicht erfasst: ' + message(error)))
    }
    return result
  })

  // Das Turn-Ende meldet die Antwort; Impulse und wartende Beiträge halten es an, damit die Session nacharbeitet.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!S.link || result.block !== undefined) return result
    if (!e.stop_hook_active) S.guided = 0
    await enqueue($, { kind: 'turn_end', eventId: crypto.randomUUID(), text: clip(e.last_assistant_message ?? '', 64_000) })
    let answer: Answer | undefined
    try { answer = await flush($) } catch (error) {
      note($, 'Turn-Ende noch nicht gemeldet: ' + message(error))
      return result
    }
    const text = answer ? guidance(answer, S.guided < MAX_GUIDANCE) : undefined
    if (!text) return result
    S.guided++
    return { ...result, block: text }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && S.busy) {
      S.busy = false
      listen($)
      $.ui.invalidate('ui.render')
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) =>
    e.props.hasSurvey || (!S.link && !S.takenOver) ? next(e) : band($, e))

  on('session.end', async ($, e, next) => {
    quiet()
    return next(e)
  })
}
