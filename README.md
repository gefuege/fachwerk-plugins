# Fachwerk GPE für Claude

Dieses Repository ist der Marketplace für das Claude-Plugin von Fachwerk GPE. Das Plugin verbindet Claude mit den Fachwerk-Instanzen, die du mit deinem eigenen Konto erreichst. Es enthält keine Zugangsdaten; es gelten deine bestehenden Freigaben für Instanzen, Daten und Aktionen.

## Einrichten in Claude (claude.ai und Desktop-App)

1. Öffne [Claude Plugins](https://claude.ai/customize/plugins) unter „Customize“. Wähle „Add“, dann „Add marketplace“ und trage `gefuege/fachwerk-plugins` ein.
2. Installiere aus dem Marketplace das Plugin „Fachwerk GPE“.
3. Öffne im Plugin den Reiter „Connectors“. Wähle „Connect“ und melde dich mit deinem eigenen Fachwerk-Konto an.

In Team und Enterprise fügt ein Owner den Connector zuerst für die Organisation hinzu.

## Einrichten in Claude Code

```
/plugin marketplace add gefuege/fachwerk-plugins
/plugin install fachwerk-gpe@fachwerk
```

## Erste Frage

„Welche Fachwerk GPE-Instanzen kann ich nutzen?“

## Inhalt und Lizenz

`plugins/fachwerk-gpe` enthält dasselbe Paket, das jede Fachwerk-Instanz im Profil unter „Fachwerk GPE in ChatGPT und Claude“ zum Download anbietet. Es gilt die Lizenz in `plugins/fachwerk-gpe/LICENSE`.
