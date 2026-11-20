# Fachwerk GPE für ChatGPT und Claude

Dieses Plugin verbindet den Chat mit deinen erreichbaren Fachwerk GPE-Instanzen.
Es enthält einen gemeinsamen Skill und den bestehenden zentralen MCP unter
`https://mcp.fachwerk.tech/mcp`. Die Anmeldung erfolgt im Browser über den
bestehenden OAuth-Flow einschließlich DCR und PKCE. Das Plugin enthält keine Zugangsdaten und vergibt keine zusätzlichen Rechte.

Installiere das zu deinem Client passende ZIP über dessen Plugin-Installation.
Verbinde anschließend den enthaltenen Fachwerk GPE-Connector und melde dich im
Browser an. In Claude findest du ihn im Tab „Connectors“ des Plugins.
Die verfügbare Installation kann vom Client und den Vorgaben deiner Organisation
abhängen. Ein ZIP-Download allein stellt die Verbindung noch nicht her.

Beginne beispielsweise mit: „Welche Fachwerk GPE-Instanzen kann ich erreichen?“
Nenne für weitere Aufträge die gewünschte Instanz. Meldet eine Instanz
`instance_login_required`, kann dort zuerst eine Anmeldung im Browser nötig
sein. Deine vorhandenen Rechte bestimmen, welche Daten und Funktionen du nutzt.

## Claude Code als geführte Session

In Claude Code kann eine einzelne Session ausdrücklich zu einem Gespräch im
Gefüge werden. Ohne diesen Befehl sendet das Plugin nichts an das Gefüge.

- `/fachwerk-verbinden <instanz>` verbindet genau diese Session. Ab dann gehen
  deine Eingaben, Tool-Zeilen (Werkzeug, Ziel, Dauer, Erfolg; nie Argumente
  oder Ergebnisse) und die Antworten in das Gespräch. Impulse des Lotsen und
  Beiträge, die du im Gefüge schreibst, kommen am Turn-Ende zurück; schreibst
  du dort, während die Session ruht, weckt der Beitrag sie.
- Über dem Prompt steht „Fachwerk verbunden“ mit der Stufe der Session. Die
  Stufe bestimmt Modell und Denkstufe nach der Tabelle in `hooks/stufen.ts`.
- `/fachwerk-trennen` trennt die Session. Übernimmst du sie im Gefüge, meldet
  das Plugin das hier und sendet danach nichts mehr.

Das Plugin ruft das Gefüge über seinen angemeldeten Fachwerk-Zugang auf; es
enthält kein Token.
