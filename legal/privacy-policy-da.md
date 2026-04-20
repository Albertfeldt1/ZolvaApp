# Privatlivspolitik for Zolva

**Ikrafttrædelsesdato:** 20. april 2026
**Senest opdateret:** 20. april 2026

<!--
TODO for den dataansvarlige før publicering:
- Udfyld kontakt-email (søg "TODO_KONTAKT_EMAIL")
- Udfyld juridisk enhed / CVR-nummer (søg "TODO_JURIDISK_ENHED")
- Bekræft dataopbevaringsvinduer (søg "TODO_BEKRÆFT")
-->

Zolva ("vi", "os", "appen") er en personlig AI-assistent, der hjælper dig med
dagens overblik, kalender og mail. Denne politik forklarer, hvilke oplysninger
vi behandler, hvorfor vi behandler dem, hvem vi deler dem med, og hvilke
rettigheder du har.

## 1. Dataansvarlig

TODO_JURIDISK_ENHED
Kontakt: TODO_KONTAKT_EMAIL

## 2. Hvilke oplysninger vi behandler

Når du bruger Zolva, behandler vi følgende kategorier af personoplysninger:

- **Kontoinformation:** email-adresse og en intern bruger-ID hos vores
  leverandør af backend (Supabase). Hvis du logger ind med Apple, kan vi
  modtage et relay-email. Hvis du logger ind med Google eller Microsoft,
  kan vi modtage dit navn og profilbillede fra udbyderen.
- **OAuth-tokens:** når du forbinder Gmail/Google Kalender eller Outlook,
  gemmer vi et refresh-token i vores database, så vi kan hente nye mails
  på dine vegne. Provider-access-tokens opbevares lokalt på din enhed i
  krypteret app-storage.
- **Mail-metadata og mail-indhold:** for at generere opsummeringer og
  kladder henter vi emnefelt, afsender, modtagere og tekstindhold fra
  de mails, du interagerer med eller som rammer din indbakke efter du
  har aktiveret "Nye mails"-notifikationer.
- **Kalenderbegivenheder:** titel, tid, sted og deltagere — bruges til
  dagens overblik og påmindelser.
- **Push-token:** en anonym token fra Apple/Expo, der lader os sende
  notifikationer til din enhed.
- **Indhold i push-notifikationer:** når du aktiverer "Nye mails", sender
  vi pushes der som standard indeholder mailens **afsender** (i notifika-
  tionens titel) og **emnefelt** (i teksten). Dette vises også på din
  låseskærm, afhængigt af dine iOS-notifikationsindstillinger. Du kan
  skjule indholdet ved at åbne **iOS Indstillinger → Notifikationer →
  Zolva → Vis forhåndsvisninger** og vælge "Når ulåst" eller "Aldrig".
  Alternativt kan du slå "Nye mails" fra i Zolva.
- **App-indstillinger:** notifikationspræferencer, arbejdspræferencer og
  privatlivs-toggles opbevares lokalt og/eller i vores database
  tilknyttet din bruger-ID.
- **Chat- og påmindelseshistorik:** tekst du indtaster i Zolva (chat med
  assistenten, noter, påmindelser).

Vi indsamler **ikke** annonce-ID'er, beliggenhed eller kontakter.

## 3. OAuth-scopes og hvad de bruges til

Når du forbinder en konto, beder vi om følgende rettigheder. Du kan til
enhver tid tilbagekalde dem i din Google- eller Microsoft-konto.

### Google

- `openid`, `email`, `profile` — for at logge dig ind og vise dit navn.
- `gmail.modify` — læse og ændre dine mails (fx markere som læst, oprette
  kladder). Vi sletter aldrig mails uden din handling.
- `calendar.readonly` — læse kalenderbegivenheder til dagens overblik.
- `drive.readonly` — læse filer du eksplicit henviser til i Zolva.

### Microsoft

- `openid`, `email`, `profile`, `offline_access` — login og vedvarende adgang.
- `Mail.ReadWrite`, `Mail.Send` — læse mails, oprette kladder og sende
  svar du eksplicit godkender.
- `Calendars.Read` — læse kalenderbegivenheder.

## 4. Databehandlere og underdatabehandlere

Vi bruger følgende leverandører (databehandlere) til at drive tjenesten:

- **Supabase (TODO_BEKRÆFT_REGION — fx "eu-central-1, Frankfurt"):**
  hostet database, auth og edge functions. Bekræft den faktiske region
  i dit Supabase-projekt (Dashboard → Project Settings → General) og
  opdatér teksten her før publicering. Hvis regionen er uden for EU/EØS,
  skal overførsler dække af Standardkontraktbestemmelser (SCC'er) —
  se punkt 7.
- **Expo Application Services:** push-notifikationer og build-infrastruktur.
- **Google LLC / Microsoft Corp.:** OAuth og API'er for Gmail/Kalender
  hhv. Outlook/Kalender. Dine data ligger i disse systemer — vi henter
  dem via dine tokens.
- **Anthropic PBC (underdatabehandler):** vi sender mail-emner, afsendere,
  mail-indhold du selv åbner/klikker opsummer, kalender-titler og dine
  chat-beskeder til Anthropics Claude-model for at generere svar og
  opsummeringer. Anthropic **bruger ikke** disse data til at træne
  modeller, jf. deres forretningsbetingelser for API-adgang.

## 5. Hvorfor vi behandler dine data (retsgrundlag)

- **Opfyldelse af aftale (art. 6, stk. 1, litra b):** for at levere Zolvas
  kernefunktioner — dagens overblik, mail-assistent, kalender, påmindelser.
- **Samtykke (art. 6, stk. 1, litra a):** når du aktiverer specifikke
  valgfrie funktioner (fx "Nye mails"-notifikationer, forbindelse til
  Google/Microsoft, push-notifikationer). Du kan trække samtykket tilbage
  når som helst i Indstillinger.
- **Legitim interesse (art. 6, stk. 1, litra f):** for fejlsøgning og
  sikkerhed, fx for at logge fejl uden indhold fra dine beskeder.

## 6. Datalagring og -opbevaring

- **OAuth-refresh-tokens:** opbevares så længe du har kontoen forbundet.
  Slettet når du kobler kontoen fra eller sletter din konto.
- **Mail-indhold sendt til Claude:** sendes direkte til Anthropic ved
  behov og opbevares ikke permanent af Zolva. Anthropic kan opbevare
  prompts i op til 30 dage til misbrugsovervågning (TODO_BEKRÆFT).
- **Chat- og påmindelseshistorik:** opbevares lokalt på din enhed og/eller
  i vores database tilknyttet din bruger-ID, indtil du sletter dem eller
  sletter kontoen.
- **Push-token:** opbevares indtil du slår notifikationer fra eller
  sletter kontoen.
- **Logs uden indhold:** op til 30 dage (TODO_BEKRÆFT), herefter slettet.
- **Kontodata ved sletning:** slettes inden for 30 dage fra du sletter
  din konto i appen. Sikkerhedskopier overskrives i en rullende cyklus
  på op til 30 dage (TODO_BEKRÆFT).

## 7. Datalokation og overførsel

TODO_BEKRÆFT: Bekræft den faktiske hosting-region for dit Supabase-
projekt og tilpas afsnittet herunder.

**Hvis databasen ligger i EU/EØS (fx Frankfurt, Dublin, Stockholm):**
Databaser og edge functions kører i EU/EØS. Overførsler til Anthropic
(USA) og til Google/Microsoft (globale datacentre) sker på grundlag
af Standardkontraktbestemmelser (SCC'er) jf. Kommissionens afgørelse
2021/914 samt — for Google/Microsoft — EU-U.S. Data Privacy Framework.

**Hvis databasen ligger uden for EU/EØS (fx us-east-1):**
Data overføres til USA og er underlagt Standardkontraktbestemmelser
(SCC'er) mellem os og Supabase som overførselsgrundlag. Det samme
gælder Anthropic. Google og Microsoft behandler dine data i henhold
til deres egne politikker og relevante overførselsmekanismer.

## 8. Dine rettigheder (GDPR)

Du har ret til:

- **Indsigt:** få oplyst hvilke data vi har om dig.
- **Berigtigelse:** få ukorrekte data rettet.
- **Sletning ("retten til at blive glemt"):** få dine data slettet.
  Brug "Slet konto" i Indstillinger — sletning gennemføres automatisk
  i løbet af sekunder og omfatter OAuth-tokens, push-tokens,
  mail-watchers og selve brugerkontoen.
- **Dataportabilitet:** få udleveret dine data i et maskinlæsbart format.
  Brug "Eksportér alle data" i Indstillinger.
- **Begrænsning og indsigelse:** få behandlingen begrænset eller
  indsigelse mod den.
- **Tilbagekaldelse af samtykke:** hvor behandlingen sker på samtykke,
  kan du trække det tilbage uden at det påvirker tidligere behandlings
  lovlighed.

Send din forespørgsel til TODO_KONTAKT_EMAIL. Vi svarer inden for 30 dage.

## 9. Klageret

Du har ret til at klage til tilsynsmyndigheden. I Danmark er det:

**Datatilsynet**
Carl Jacobsens Vej 35
2500 Valby
Telefon: +45 33 19 32 00
Email: dt@datatilsynet.dk
Web: https://www.datatilsynet.dk

## 10. Sletning af konto

Du kan slette din konto når som helst:

1. Åbn **Indstillinger** i Zolva.
2. Rul ned til **Konto** → **Slet konto**.
3. Bekræft ved at skrive "SLET" og tryk **Slet konto permanent**.

Sletning omfatter: kontooplysninger, OAuth-refresh-tokens, push-tokens,
mail-watcher-tilstand og alle rækker i vores database tilknyttet din
bruger-ID. Vi forsøger desuden at tilbagekalde dine OAuth-tokens hos
Google/Microsoft. Handlingen kan **ikke** fortrydes.

## 11. Børn

Zolva er ikke rettet mod børn under 13 år, og vi indsamler ikke bevidst
data om børn. Hvis du tror, at et barn har givet os data, så kontakt os
og vi sletter dem.

## 12. Ændringer til denne politik

Vi opdaterer politikken når vores databehandling ændrer sig. Væsentlige
ændringer meddeles i appen. Seneste opdateringsdato fremgår øverst.

## 13. Kontakt

Spørgsmål? Skriv til TODO_KONTAKT_EMAIL.
