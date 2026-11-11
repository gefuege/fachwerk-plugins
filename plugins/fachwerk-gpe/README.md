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
