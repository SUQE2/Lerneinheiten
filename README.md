# Lernzeit

Lernzeit ist ein geschützter Lerntracker für eine private Gruppe von bis zu zehn Personen. Wochen-, Monats-, Jahres- und Eintragsdaten sind erst nach einer Anmeldung sichtbar.

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
- genau eine private Gruppe pro Konto
- maximal zehn Gruppenmitglieder
- Beitritt über einen achtstelligen Einladungs-Code
- synchronisierte Lernzeiten auf mehreren Geräten
- Wochen-, Monats- und Jahresvergleich
- gemeinsame Aktivitätsübersicht mit Thema und Kategorie
- Rollen: **Hauptadmin**, **Admin** und **Mitglied**
- nur der Hauptadmin kann Adminrechte vergeben oder entziehen
- Admins können alle Einträge der Gruppe sehen und verwalten sowie Mitglieder entfernen
- normale Mitglieder sehen ausschließlich freigegebene Gruppeneinträge
- Sichtbarkeit pro Eintrag: **Mit Gruppe teilen** oder **Nur für mich und Admins**
- automatische, private Übernahme vorhandener lokaler Einträge beim ersten Login

## Datenschutz und Zugriffsregeln

Die Zugriffsregeln liegen in der Datenbank und nicht nur in der Oberfläche. Normale Mitglieder können ihr eigenes Profil, die eigene Gruppe und freigegebene Einträge ihrer Gruppenmitglieder abrufen. Hauptadmin und ernannte Admins können zusätzlich private Einträge der eigenen Gruppe sehen und verwalten. Nur der Hauptadmin kann Rollen vergeben und entziehen.

## Vor einer öffentlichen Veröffentlichung

- In Supabase unter **Authentication → URL Configuration** die endgültige Website-Adresse als Site URL eintragen.
- Für lokale Tests `http://127.0.0.1:8000/**` als zusätzliche Redirect URL erlauben.
- E-Mail-Bestätigung aktiviert lassen.
- `config.js` mit den öffentlichen Projektdaten zusammen mit den übrigen Dateien hosten.
- Die App ausschließlich über HTTPS veröffentlichen.
