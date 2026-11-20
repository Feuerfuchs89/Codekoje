# Codekoje – Python lernen für die Kellerfarm

Installierbare Web-App (PWA): Lernpfad mit 25 Lektionen, Übungen auf deinem Niveau, simulierte Raspberry-Pi-Hardware und ein KI-Mentor mit Gemini.

## Online stellen mit GitHub Pages

1. Auf github.com ein neues Repository anlegen, zum Beispiel `Codekoje`.
2. Den **Inhalt** dieses Ordners hochladen (alle Dateien aus dem Ordner `Codekoje`). Über „Add file → Upload files“ kannst du alles auf einmal reinziehen.
3. Im Repository: **Settings → Pages → Branch: main, Ordner: / (root) → Save**.
4. Nach ein bis zwei Minuten läuft die App unter `https://DEIN-NAME.github.io/Codekoje/`.

## Aufs Handy holen

Seite im Handy-Browser öffnen, dann:
- Android (Chrome): Menü ⋮ → „App installieren“ oder „Zum Startbildschirm hinzufügen“
- iPhone (Safari): Teilen → „Zum Home-Bildschirm“

Danach startet die Codekoje wie eine normale App mit eigenem Icon und funktioniert auch offline. Nur der KI-Mentor braucht Internet.

## Gemini einrichten

1. Auf https://aistudio.google.com/apikey mit deinem Google-Konto einen API-Schlüssel erstellen. Die kostenlose Stufe reicht zum Lernen.
2. In der Codekoje oben rechts auf das Zahnrad tippen, den Schlüssel einfügen und auf „Verbindung testen“ tippen.
3. Wird ein Modell nicht gefunden, tippst du auf „Modelle laden“ und wählst ein anderes Gemini-Modell aus.

Der Schlüssel wird nur im Browser deines Geräts gespeichert und geht direkt an Google. Stell ihn nicht ins Repository und gib ihn nicht weiter.

## Fortschritt mitnehmen

Der Fortschritt liegt pro Gerät im Browser. Unter Einstellungen → „Sicherung speichern“ bekommst du eine Datei, die du auf einem anderen Gerät mit „Sicherung laden“ einspielst.

## Aktualisieren

Für eine neue Version ersetzt du einfach die Dateien im Repository. Die App lädt das Update beim nächsten Öffnen mit Internet.

## Werkstatt (echtes Python)

Der vierte Tab unten ist die **Werkstatt**. Dort läuft echtes Python 3 (Pyodide) statt der Lern-Engine:

- **Projekte** mit mehreren Dateien (`main.py`, eigene Module, CSV …), Pakete von PyPI über `requirements.txt` (numpy, pandas, matplotlib … sind schon eingebaut)
- **Editor** mit Farben, Klammern, Fehlermarkierung und Vorschlägen (💡 oder Strg+Leertaste)
- **Mentor**: nutzt automatisch deinen Gemini-Schlüssel und deinen Lernstand aus der Codekoje
- **Pi-Simulator** mit denselben Bauteilen wie im Lernpfad, zusätzlich Knöpfe zum Antippen und Regler für Sensoren
- **Live-Modus**: `input()` fragt direkt nach, ■ hält ein Skript an
- **GitHub-Abgleich** (Push/Pull) und ZIP, damit du am PC und am Handy am selben Projekt arbeitest

Jeder Editor in der Codekoje hat einen Knopf **„Werkstatt“**: Er nimmt den Code mit. Code aus Lektionen landet im Projekt „Codekoje-Übungen“, Code aus dem Mentor-Projekt in einem Projekt mit dessen Namen.

**GitHub-Schlüssel** (nur für den Abgleich): github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Rechte: *Contents* lesen & schreiben, *Administration* lesen & schreiben (nur wenn die Werkstatt neue Repos anlegen soll). Eintragen in der Werkstatt über das Zahnrad.

Beim ersten Start lädt die Werkstatt Python (~15 MB), danach geht vieles offline. Projekte aus der alten Pykoje (gleiche GitHub-Seite) sind automatisch da.

Grenzen: Pakete mit C-Code ohne Browser-Version (z. B. torch) gehen nicht, keine Fenster (tkinter/pygame), keine Hintergrund-Threads.
