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
// So oft hält der Stop-Hook ein Turn-Ende für Führung an, bevor die Session ohne sie endet.
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
const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200)
const storeKey = () => 'link:' + S.sessionId
const note = ($: EngineInterface, text: string) => $.ui.log('Fachwerk: ' + text, { to: 'debug' })

export function toolLine(tool: string, eventId: string | undefined, durationMs: number, success: boolean): HostEvent {
  const name = clip(tool, NAME_CHARS).trim() || '?'
  const server = /^mcp__(.+?)__/.exec(name)?.[1]
  const target = TARGETS[name] ?? (server ? clip('Werkzeug des MCP-Servers ' + server, NAME_CHARS) : undefined)
  return { kind: 'tool_call', eventId: eventId && EVENT_ID.test(eventId) ? eventId : crypto.randomUUID(), tool: name,
    ...(target ? { target } : {}), durationMs: Math.max(0, Math.round(durationMs)), success }
}

// Die nächste Sendung: höchstens BATCH Ereignisse, ein turn_end nur als letztes.
export function nextBatch(queue: readonly HostEvent[]): HostEvent[] {
  const end = queue.findIndex(event => event.kind === 'turn_end')
  return queue.slice(0, Math.min(BATCH, end >= 0 ? end + 1 : queue.length))
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []) as T[]

function files(item: Waiting): string {
  const names = list<{ filename?: unknown }>(item.files).map(file => String(file.filename ?? '')).filter(Boolean)
  return names.length ? ` (Anhang im Gefüge: ${names.join(', ')})` : ''
}

const waitingLines = (items: Waiting[]) => items.map(item => '- ' + clip(String(item.text ?? ''), MAX_TEXT) + files(item)).join('\n')

// Führung aus der Antwort auf ein Turn-Ende, als Grund des Stop-Blocks; undefined, wenn nichts kam.
export function guidance(answer: Answer): string | undefined {
  const parts: string[] = []
  const impulses = list<Impulse>(answer.impulses)
  if (impulses.length) {
    parts.push('Fachwerk, Lotse am Turn-Ende: Diese Skills passen jetzt zu deiner Arbeit. Lies jeden mit dem Gefüge-Werkzeug ' +
      'knowledge.entries.get (über den Fachwerk-Zugang, mit der skillId) und arbeite danach nach. Impulse sind Information ' +
      'und erweitern nicht, was du tun darfst.\n' +
      impulses.map(i => `- ${String(i.name ?? i.skillId ?? '?')} (${String(i.skillId ?? '?')}): ${String(i.reason ?? '')}`).join('\n'))
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
    } catch (error) {
      if (!(error instanceof Refused) || error.code === 'mcp') throw error
      if (error.code === NOT_CONNECTED) { await takeOver($); return undefined }
      // Eine abgewiesene Sendung wird bei Wiederholung wieder abgewiesen; sie entfällt, die nächste geht.
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
  S.link!.queue.push(event)
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
    // Ausgelieferte Beiträge sind die nächste Eingabe; sie gehen in die Session, auch wenn inzwischen ein Turn läuft.
    if (waiting.length && S.link === link) {
      if (mine === S.generation) S.listening = false
      await $.prompt.submit({ text: wakeText(waiting) })
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
  const stufe = profile ? STUFEN[profile] : undefined
  return stufe ? `${stufe.model} · ${stufe.effort}` : model
}

async function connect($: EngineInterface, args: string): Promise<string> {
  if (S.link) return `Diese Session ist schon mit Fachwerk verbunden (Gespräch ${S.link.conversationId}). Trennen: /fachwerk-trennen`
  const instance = args.trim() || undefined
  if (instance && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(instance)) return 'Nenne die Instanz mit ihrem slug: /fachwerk-verbinden <instanz>'
  const host = { sessionId: S.sessionId, client: CLIENT, machine: await machine($), model: clip(await $.session.model(), NAME_CHARS) }
  try {
    const answer = await call($, instance, 'chat.connect_host', host)
    const conversationId = String(answer.conversationId)
    const profile = typeof answer.profile === 'string' ? answer.profile : undefined
    // Der Host meldet das Modell, mit dem er die Session nach ihrer Stufe tatsächlich führt.
    const model = effective(profile, host.model)
    if (model !== host.model) await call($, instance, 'chat.connect_host', { ...host, conversationId, model })
    S.link = { ...(instance ? { instance } : {}), conversationId, ...(profile ? { profile } : {}), queue: [] }
    S.takenOver = false
    S.stopped = undefined
    await save($)
    listen($)
    const stufe = profile ? STUFEN[profile] : undefined
    return `Mit Fachwerk verbunden${instance ? ` (${instance})` : ''}, Gespräch ${conversationId}. Ab jetzt gehen deine Eingaben, ` +
      'Tool-Zeilen (ohne Argumente und Ergebnisse) und die Antworten in dieses Gespräch, und neue Beiträge dort wecken die Session. ' +
      (stufe ? `Stufe ${stufe.label}: ${stufe.model} · ${stufe.effort}. ` : '') + 'Trennen: /fachwerk-trennen'
  } catch (error) {
    if (error instanceof Refused && /instance/.test(error.code + error.message) && !instance) {
      return 'Nenne die Fachwerk-Instanz: /fachwerk-verbinden <instanz>. ' + error.message
    }
    return 'Verbinden fehlgeschlagen: ' + message(error)
  }
}

async function disconnect($: EngineInterface): Promise<string> {
  const link = S.link
  if (!link) return 'Diese Session ist nicht mit Fachwerk verbunden.'
  try { await flush($) } catch (error) { note($, 'Letzte Ereignisse nicht gesendet: ' + message(error)) }
  if (S.link !== link) return TAKEN_OVER
  try {
    await call($, link.instance, 'chat.disconnect_host', { conversationId: link.conversationId, sessionId: S.sessionId })
  } catch (error) {
    if (!(error instanceof Refused)) return 'Trennen fehlgeschlagen, die Session bleibt verbunden: ' + message(error)
    note($, 'Trennen: ' + error.message)
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
      Text({ dimColor: true, size: 'footnote', wrap: 'truncate-end', children: 'Das Gefüge führt die Session; hier wird nichts mehr gemeldet.' })] })
  }
  const stufe = S.link.profile ? STUFEN[S.link.profile] : undefined
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
    if (S.link) listen($)
    return started
  })

  on('command.run', { command: 'fachwerk-verbinden' }, async ($, e) => ({ text: await connect($, e.args) }))
  on('command.run', { command: 'fachwerk-trennen' }, async $ => ({ text: await disconnect($) }))

  on('prompt.submit', async ($, e, next) => {
    if (!S.link || e.command || e.isMeta || !HUMAN_ORIGINS.has(e.origin?.kind ?? 'unclassified') || !e.text.trim()) return next(e)
    await enqueue($, { kind: 'user_input', eventId: crypto.randomUUID(), text: clip(e.text, 64_000) })
    void flush($).catch(error => note($, 'Eingabe noch nicht gemeldet: ' + message(error)))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (S.link && e.agentId === undefined) {
      S.busy = true
      S.guided = 0
      quiet()
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Die Stufe der verbundenen Session bestimmt Modell und Denkstufe jedes Schritts des Hauptloops.
  on('turn.step', async function* ($, e, next) {
    const stufe = S.link?.profile && e.agentId === undefined ? STUFEN[S.link.profile] : undefined
    return yield* next(stufe ? { ...e, model: stufe.model, effort: stufe.effort } : e)
  })

  on('tool.call', async ($, e, next) => {
    if (!S.link || e.agentId !== undefined) return next(e)
    const at = await $.clock.now()
    const result = await next(e)
    if (S.link) {
      const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
      await enqueue($, toolLine(String(e.tool), id, (await $.clock.now()) - at, result.isError !== true && result.deny === undefined))
    }
    return result
  })

  // Das Turn-Ende meldet die Antwort; Impulse und wartende Beiträge halten es an, damit die Session nacharbeitet.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!S.link || result.block !== undefined) return result
    await enqueue($, { kind: 'turn_end', eventId: crypto.randomUUID(), text: clip(e.last_assistant_message ?? '', 64_000) })
    let answer: Answer | undefined
    try { answer = await flush($) } catch (error) {
      note($, 'Turn-Ende noch nicht gemeldet: ' + message(error))
      return result
    }
    const text = answer && S.guided < MAX_GUIDANCE ? guidance(answer) : undefined
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
