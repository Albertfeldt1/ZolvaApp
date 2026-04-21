# Privatlivspolitik for Zolva

Ikrafttrædelsesdato: 20. april 2026
Senest opdateret: 20. april 2026

Zolva ("vi", "os", "appen") er en personlig AI-assistent, der hjælper
dig med dagens overblik, kalender og mail. Denne politik forklarer,
hvilke oplysninger vi behandler, hvorfor vi behandler dem, hvem vi
deler dem med, og hvilke rettigheder du har.

## 1. Dataansvarlig

Oscar Hangaard
Vilkestrupvej 1
4623 Lille Skensved
Danmark
Kontakt: kontakt@zolva.io

## 2. Hvilke oplysninger vi behandler

Når du bruger Zolva, behandler vi følgende kategorier af
personoplysninger:

- Kontoinformation: email-adresse og en intern bruger-ID hos vores
  leverandør af backend (Supabase). Hvis du logger ind med Apple, kan
  vi modtage en skjult relay-adresse. Hvis du logger ind med Google
  eller Microsoft, kan vi modtage dit navn og profilbillede fra
  udbyderen.
- OAuth-tokens: når du forbinder Gmail/Google Kalender eller Outlook,
  gemmer vi et refresh-token i vores database, så vi kan hente nye
  mails på dine vegne. Provider-access-tokens opbevares lokalt på din
  enhed i krypteret app-storage.
- Mail-metadata og mail-indhold: for at generere opsummeringer og
  kladder henter vi emnefelt, afsender, modtagere og tekstindhold fra
  de mails, du interagerer med, eller som rammer din indbakke efter du
  har aktiveret "Nye mails"-notifikationer.
- Kalenderbegivenheder: titel, tid, sted og deltagere. Bruges til
  dagens overblik og påmindelser.
- Push-token: en anonym token fra Apple/Expo, der lader os sende
  notifikationer til din enhed.
- Indhold i push-notifikationer: når du aktiverer "Nye mails", sender
  vi push-notifikationer, der som standard indeholder mailens afsender
  (i notifikationens titel) og emnefelt (i teksten). Dette vises også
  på din låseskærm, afhængigt af dine iOS-notifikationsindstillinger.
  Du kan skjule indholdet ved at åbne iOS Indstillinger > Notifikationer
  > Zolva > Vis forhåndsvisninger og vælge "Når ulåst" eller "Aldrig".
  Alternativt kan du slå "Nye mails" fra i Zolva.
- App-indstillinger: notifikationspræferencer, arbejdspræferencer og
  privatlivs-toggles opbevares lokalt og/eller i vores database
  tilknyttet din bruger-ID.
- Chat- og påmindelseshistorik: tekst du indtaster i Zolva (chat med
  assistenten, noter, påmindelser).

Vi indsamler ikke annonce-ID'er, beliggenhed eller kontakter.

## 3. OAuth-scopes og hvad de bruges til

Når du forbinder en konto, beder vi om følgende rettigheder. Du kan til
enhver tid tilbagekalde dem i din Google- eller Microsoft-konto.

### Google

- openid, email, profile: for at logge dig ind og vise dit navn.
- gmail.modify: læse og ændre dine mails (for eksempel markere som
  læst, oprette kladder). Vi sletter aldrig mails uden din handling.
- calendar.readonly: læse kalenderbegivenheder til dagens overblik.

### Microsoft

- openid, email, profile, offline_access: login og vedvarende adgang.
- Mail.ReadWrite, Mail.Send: læse mails, oprette kladder og sende svar
  du eksplicit godkender.
- Calendars.Read: læse kalenderbegivenheder.

## 4. Databehandlere og underdatabehandlere

Vi bruger følgende leverandører til at drive tjenesten:

- Supabase (eu-west-1, Irland): hostet database, auth og edge
  functions. Alle dine konto- og brugerdata opbevares i EU.
- Expo Application Services: push-notifikationer og
  build-infrastruktur.
- Google LLC / Microsoft Corp.: OAuth og API'er for Gmail/Kalender
  henholdsvis Outlook/Kalender. Dine data ligger i disse systemer. Vi
  henter dem via dine tokens.
- Anthropic PBC (underdatabehandler): vi sender mail-emner, afsendere,
  indhold fra mails du eksplicit beder Zolva opsummere eller svare på,
  kalender-titler og dine chat-beskeder til Anthropics Claude-model for
  at generere svar og opsummeringer. Anthropic bruger ikke disse data
  til at træne modeller, jf. deres forretningsbetingelser for
  API-adgang. Anthropic kan opbevare prompts i op til 30 dage til
  misbrugsovervågning.
- Vercel Inc.: hosting af denne privatlivspolitik. Ingen persondata fra
  appen sendes til Vercel.

## 5. Hvorfor vi behandler dine data (retsgrundlag)

- Opfyldelse af aftale (art. 6, stk. 1, litra b): for at levere Zolvas
  kernefunktioner. Dagens overblik, mail-assistent, kalender,
  påmindelser.
- Samtykke (art. 6, stk. 1, litra a): når du aktiverer specifikke
  valgfrie funktioner, for eksempel "Nye mails"-notifikationer,
  forbindelse til Google/Microsoft, eller push-notifikationer. Du kan
  trække samtykket tilbage når som helst i Indstillinger.

## 6. Datalagring og -opbevaring

- OAuth-refresh-tokens: opbevares så længe du har kontoen forbundet.
  Slettes når du kobler kontoen fra eller sletter din konto.
- Mail-indhold sendt til Claude: sendes direkte til Anthropic ved behov
  og opbevares ikke permanent af Zolva. Anthropic kan opbevare prompts
  i op til 30 dage til misbrugsovervågning.
- Chat- og påmindelseshistorik: opbevares lokalt på din enhed og/eller
  i vores database tilknyttet din bruger-ID, indtil du sletter dem
  eller sletter kontoen.
- Push-token: opbevares indtil du slår notifikationer fra eller sletter
  kontoen.
- Fejl-logs uden indhold: op til 30 dage, herefter slettet.
- Kontodata ved sletning: slettes inden for 30 dage fra du sletter din
  konto i appen. Sikkerhedskopier overskrives i en rullende cyklus på
  op til 30 dage.

## 7. Datalokation og overførsel

Databaser og edge functions kører i EU (Irland, eu-west-1). Overførsler
til Anthropic (USA) sker på grundlag af Standardkontraktbestemmelser
(SCC'er) jf. Kommissionens afgørelse 2021/914. Google og Microsoft
behandler dine data i henhold til deres egne politikker og
overførselsmekanismer, herunder EU-U.S. Data Privacy Framework.

## 8. Sikkerhed

Alle forbindelser mellem appen og vores backend bruger TLS. OAuth-tokens
opbevares i iOS Keychain eller Android Keystore via krypteret
app-storage. Database-adgang er begrænset via Row-Level Security, så
brugere kun kan tilgå egne data.

## 9. Cookies og lokal lagring

Zolva er en mobil-app og anvender ikke cookies. Appen bruger iOS
Keychain og Android Keystore til at opbevare OAuth-tokens sikkert
lokalt på din enhed, samt almindelig app-lagring til præferencer og
cache.

## 10. Dine rettigheder (GDPR)

Du har ret til:

- Indsigt: få oplyst hvilke data vi har om dig.
- Berigtigelse: få ukorrekte data rettet.
- Sletning ("retten til at blive glemt"): få dine data slettet. Brug
  "Slet konto" i Indstillinger. Sletning gennemføres automatisk i løbet
  af sekunder og omfatter OAuth-tokens, push-tokens, mail-watchers og
  selve brugerkontoen.
- Dataportabilitet: få udleveret dine data i et maskinlæsbart format.
  Skriv til kontakt@zolva.io, så leverer vi en kopi inden for 30 dage.
- Begrænsning og indsigelse: få behandlingen begrænset eller gøre
  indsigelse mod den.
- Tilbagekaldelse af samtykke: hvor behandlingen sker på samtykke, kan
  du trække det tilbage. Tilbagekaldelsen påvirker ikke lovligheden af
  behandling, der er sket før tilbagekaldelsen.

Send din forespørgsel til kontakt@zolva.io. Vi svarer inden for 30 dage.

## 11. Klageret

Du har ret til at klage til tilsynsmyndigheden. I Danmark er det:

Datatilsynet
Carl Jacobsens Vej 35
2500 Valby
Telefon: +45 33 19 32 00
Email: dt@datatilsynet.dk
Web: https://www.datatilsynet.dk

## 12. Sletning af konto

Du kan slette din konto når som helst:

1. Åbn Indstillinger i Zolva.
2. Rul ned til Konto > Slet konto.
3. Bekræft ved at skrive "SLET" og tryk Slet konto permanent.

Sletning omfatter: kontooplysninger, OAuth-refresh-tokens, push-tokens,
mail-watcher-tilstand og alle rækker i vores database tilknyttet din
bruger-ID. Vi forsøger desuden at tilbagekalde dine OAuth-tokens hos
Google og Microsoft. Handlingen kan ikke fortrydes.

## 13. Børn

Zolva er ikke rettet mod børn under 13 år (jf. databeskyttelseslovens
§ 6), og vi indsamler ikke bevidst data om børn. Hvis du tror, at et
barn har givet os data, så kontakt os og vi sletter dem.

## 14. Ændringer til denne politik

Vi opdaterer politikken når vores databehandling ændrer sig. Væsentlige
ændringer meddeles i appen. Seneste opdateringsdato fremgår øverst.

## 15. Kontakt

Spørgsmål? Skriv til kontakt@zolva.io.