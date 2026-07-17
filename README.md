# Lernzeit

Lernzeit ist ein geschützter Lerntracker für mehrere private Gruppen mit jeweils bis zu zehn Personen. Wochen-, Monats-, Jahres- und Eintragsdaten sind erst nach einer Anmeldung sichtbar.

## Lokal starten

```bash
python3 main.py
```

Danach `http://127.0.0.1:8000` in Brave öffnen. Vor der ersten Anmeldung muss der Online-Modus wie unten beschrieben eingerichtet sein.

## Online-Modus einrichten

Für Konten, Gruppen und die Synchronisierung wird ein Supabase-Projekt benötigt.

1. Unter `https://supabase.com/dashboard` ein neues Projekt erstellen.
2. Im Supabase-Dashboard den **SQL Editor** öffnen.
3. Den vollständigen Inhalt von `supabase-schema.sql` einfügen und einmal ausführen.
4. Unter **Project Settings → API** die Projekt-URL und den öffentlichen `anon`- beziehungsweise Publishable-Key kopieren.
5. Beide Werte in `config.js` eintragen:

```js
window.LERNZEIT_CONFIG = {
  supabaseUrl: "https://DEIN-PROJEKT.supabase.co",
  supabaseAnonKey: "DEIN-OEFFENTLICHER-KEY"
};
```

Der öffentliche Browser-Key darf in der Web-App stehen. Niemals den `service_role`-Key in `config.js` eintragen; dieser würde die Datenbankregeln umgehen.

## Was der Online-Modus kann

- Registrierung und Anmeldung per E-Mail und Passwort
- mehrere private Gruppen pro Konto
- pro Gruppe zwischen zwei und zehn Plätze, durch Admins einstellbar
- Beitritt über einen achtstelligen Einladungs-Code
- Beitrittsanfragen, die erst ein Admin bestätigt
- Einladungen deaktivieren, zeitlich begrenzen oder mit einem neuen Code versehen
- synchronisierte Lernzeiten auf mehreren Geräten
- Lernzeiten bearbeiten und wahlweise einer Gruppe zuordnen
- Sichtbarkeit pro Eintrag: **Ganze Gruppe**, **Nur Gruppenadmins** oder **Nur ich**
- persönliches Wochenziel mit Fortschrittsanzeige
- Export aller eigenen Einträge als CSV oder druckbare PDF
- Wochen-, Monats- und Jahresvergleich
- gemeinsame Aktivitätsübersicht mit Thema und Kategorie
- Rollen: **Hauptadmin**, **Admin** und **Mitglied**
- nur der Hauptadmin kann Adminrechte vergeben oder entziehen
- Admins können Gruppen- und Admin-Einträge sehen und verwalten sowie Mitglieder entfernen
- normale Mitglieder sehen ausschließlich freigegebene Gruppeneinträge
- Gruppen umbenennen, verlassen, löschen und den Hauptadmin übertragen
- Admin-Protokoll für Rollen-, Mitglieder- und Einladungsänderungen
- Anzeigename, E-Mail und Passwort verwalten sowie das eigene Konto löschen
- als App installierbar; die Oberfläche öffnet sich auch offline, die Synchronisierung benötigt Internet
- automatische, private Übernahme vorhandener lokaler Einträge beim ersten Login

## Datenschutz und Zugriffsregeln

Die Zugriffsregeln liegen in der Datenbank und nicht nur in der Oberfläche. Einträge können ohne Gruppe privat bleiben oder einer ausgewählten Gruppe zugeordnet werden. Normale Mitglieder sehen Gruppeneinträge, Admins zusätzlich ausdrücklich für Admins freigegebene Einträge. **„Nur ich“-Einträge bleiben auch vor Admins verborgen.** Nur der Hauptadmin kann Rollen vergeben, entziehen und den Besitz übertragen.

## Vor einer öffentlichen Veröffentlichung

- In Supabase unter **Authentication → URL Configuration** die endgültige Website-Adresse als Site URL eintragen.
- Für lokale Tests `http://127.0.0.1:8000/**` als zusätzliche Redirect URL erlauben.
- Die Netlify-Adresse zusätzlich als Redirect URL eintragen, damit Passwort-Zurücksetzen funktioniert.
- E-Mail-Bestätigung aktiviert lassen.
- `config.js` mit den öffentlichen Projektdaten zusammen mit den übrigen Dateien hosten.
- Die App ausschließlich über HTTPS veröffentlichen.
