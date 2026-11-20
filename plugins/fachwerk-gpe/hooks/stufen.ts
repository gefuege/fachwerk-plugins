// Die Stufe einer Session (Konzept `guided-session`, Abschnitt Stufe) als Modell und Denkstufe in Claude Code.
// Die Instanz nennt einem externen Client nur die Stufe; diese Tabelle übersetzt sie und wird mit dem
// Plugin gepflegt. Modelle sind Aliase, wie `--model` sie annimmt.
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Stufe = { label: string; model: string; effort: Effort }

export const STUFEN: Readonly<Record<string, Stufe>> = {
  light: { label: 'Einfach', model: 'sonnet', effort: 'low' },
  balanced: { label: 'Ausgewogen', model: 'sonnet', effort: 'medium' },
  thorough: { label: 'Gründlich', model: 'opus', effort: 'high' },
  frontier: { label: 'Frontier', model: 'fable', effort: 'high' },
}
