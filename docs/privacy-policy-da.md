---
title: Privatlivspolitik
---

# Privatlivspolitik for Zolva

Ikrafttrædelsesdato: 20. april 2026
Senest opdateret: 8. juni 2026

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
- OAuth-tokens: når du forbinder Gmail/Google Kalender eller
  Outlook/Microsoft 365, gemmer vi et refresh-token i vores database,
  så vi kan hente nye mails og kalenderbegivenheder på dine vegne.
  Provider-access-tokens opbevares lokalt på din enhed i krypteret
  app-storage.
- iCloud-loginoplysninger: hvis du forbinder Apple iCloud Mail/Kalender,
  angiver du din Apple ID-email og en **app-specifik adgangskode** fra
  Apple (ikke din almindelige Apple ID-adgangskode). Oplysningen
  opbevares krypteret på din enhed (iOS Keychain / Android Keystore) og
  på vores backend, så vi kan synkronisere mail (IMAP) og kalender
  (CalDAV) på dine vegne.
- Mail-metadata og mail-indhold: for at generere opsummeringer,
  prioritere din indbakke og skrive svarkladder henter vi emnefelt, afsender,
  modtagere og tekstindhold fra de postkasser, du forbinder. Når du
  aktiverer assistenten ("agenten") eller "Nye mails"-notifikationer,
  behandles ny indgående post automatisk som beskrevet i afsnit 4.
- Kalenderbegivenheder: titel, tid, sted, deltagere og beskrivelse.
  Bruges til dagens overblik, påmindelser, planlægning og — med din
  godkendelse — oprettelse eller ændring af begivenheder.
- Forbundne filer: de to udbydere er forskellige, og vi beskriver dem
  hver for sig. Google Drev bruger det fil-specifikke `drive.file`-scope,
  så vi kun kan tilgå filer, du (eller appen på dine vegne) har åbnet
  eller oprettet med Zolva — ikke hele dit Drev. Microsoft bruger
  `Files.Read`-rettigheden, som lader assistenten læse — aldrig redigere
  eller slette — filer på tværs af dit OneDrive/Microsoft 365 for at
  finde og henvise til dokumenter for dig.
- Abonnements- og købsdata: hvis du køber et Lite- eller Pro-abonnement,
  behandler vi din abonnementsstatus via RevenueCat og App Store /
  Google Play. Vi gemmer dit niveau (free/lite/pro), produkt-id'et,
  butikken, prøveperiode-status, hvornår den nuværende periode slutter,
  et RevenueCat bruger-id og den rå abonnementshændelse. Vi modtager
  eller gemmer ikke dine kort- eller betalingsoplysninger.
- Push-token: en anonym token fra Apple/Expo, der lader os sende
  notifikationer til din enhed.
- Indhold i push-notifikationer: når du aktiverer "Nye mails", sender
  vi push-notifikationer, der som standard indeholder mailens afsender
  (i titlen) og emnefelt (i teksten). Assistenten kan også sende
  proaktive notifikationer ("nudges"), for eksempel om aftaler eller
  kommende møder. Indholdet vises på din låseskærm afhængigt af dine
  iOS-notifikationsindstillinger. Du kan skjule indholdet ved at åbne
  iOS Indstillinger > Notifikationer > Zolva > Vis forhåndsvisninger og
  vælge "Når ulåst" eller "Aldrig". Du kan også slå "Nye mails" og
  assistenten fra i Zolva.
- App-indstillinger og assistentens hukommelse: notifikationspræferencer,
  arbejdspræferencer, privatlivs-toggles og "fakta", som assistenten
  husker om dig (for eksempel aftaler og tilbagevendende opgaver),
  opbevares lokalt og/eller i vores database tilknyttet din bruger-ID.
  Du kan slå hukommelse fra og slette gemte fakta i Indstillinger.
- Chat- og påmindelseshistorik: tekst du indtaster i Zolva (chat med
  assistenten, noter, påmindelser).

Vi indsamler ikke annonce-ID'er, beliggenhed eller kontakter.

## 3. OAuth-scopes og hvad de bruges til

Når du forbinder en konto, beder vi om følgende rettigheder. Du kan til
enhver tid tilbagekalde dem i din Google-, Microsoft- eller Apple-konto.

### Google

- openid, email, profile: for at logge dig ind og vise dit navn.
- gmail.readonly: læse dine mails for at opsummere og prioritere dem.
- gmail.compose: oprette svarkladder. Vi beder ikke om adgang til at
  ændre eller slette dine mails, og Zolva sletter aldrig dine mails.
- calendar.events: læse og — med din godkendelse — oprette eller ændre
  kalenderbegivenheder til dagens overblik, påmindelser og planlægning.
- calendar.calendarlist.readonly: læse listen over dine kalendere, så du
  kan vælge, hvilken der skal bruges.
- drive.file: kun adgang til de specifikke Google Drev-filer, du åbner
  eller opretter med Zolva.

### Microsoft

- openid, email, profile, offline_access: login og vedvarende adgang.
- Mail.ReadWrite, Mail.Send: læse mails, oprette kladder og sende svar,
  du godkender.
- Calendars.ReadWrite: læse og — med din godkendelse — oprette eller
  ændre kalenderbegivenheder.
- Files.Read: skrivebeskyttet adgang til dine OneDrive/Microsoft
  365-filer, så assistenten kan finde og henvise til dokumenter. I
  modsætning til Googles fil-specifikke scope dækker denne rettighed
  dine filer bredt; Zolva ændrer eller sletter dem aldrig.

### Apple iCloud (IMAP / CalDAV)

- Mail (IMAP, skrivebeskyttet): læse din iCloud-mail for at opsummere og
  prioritere den. Zolva sender ikke mail fra iCloud-konti.
- Kalender (CalDAV, læse/skrive): læse og — med din godkendelse —
  oprette eller ændre iCloud-kalenderbegivenheder.

## 4. Automatisk behandling via assistenten

Hvis du aktiverer assistenten ("agenten"), behandler Zolva dine
forbundne postkasser og kalendere automatisk for at hjælpe dig med at
følge med. Automatiske handlinger omfatter: læsning og opsummering af ny
post, registrering af aftaler, udarbejdelse af svarkladder, søgning i
forbundne filer, hjælp til planlægning og afsendelse af notifikationer
til dig. Assistenten flytter, mærker, arkiverer eller sletter aldrig
dine mails automatisk.

Følgende handlinger udføres **aldrig** uden din godkendelse som standard:
afsendelse af et mailsvar eller en ny mail, svar på en mødeindkaldelse,
og oprettelse eller ændring af en kalenderbegivenhed. For afsendelse kan
du valgfrit lade assistenten sende automatisk til **specifikke modtagere,
du vælger** ("tillid"); du kan tilbagekalde dette når som helst i
Indstillinger. Du bevarer kontrollen: du kan deaktivere assistenten,
begrænse hvad den må, og gennemse eller fortryde dens handlinger i appen.
Assistenten træffer ikke afgørelser med retsvirkning over for dig
(GDPR art. 22).

## 5. Databehandlere og underdatabehandlere

Vi bruger følgende leverandører til at drive tjenesten:

- Supabase (eu-west-1, Irland): hostet database, auth og edge
  functions. Alle dine konto- og brugerdata opbevares i EU.
- Expo Application Services: push-notifikationer og
  build-infrastruktur.
- Google LLC / Microsoft Corp. / Apple Inc.: mail- og kalender-API'er
  for henholdsvis Gmail/Kalender, Outlook/Kalender og iCloud
  Mail/Kalender. Dine data ligger i disse systemer; vi henter dem via
  dine tokens eller loginoplysninger.
- Anthropic PBC (underdatabehandler): for at generere opsummeringer,
  briefs, svarkladder og assistent-handlinger sender vi relevante
  mail-emner, afsendere, modtagere og indhold, kalender-titler og
  -detaljer, huskede fakta og dine chat-beskeder til Anthropics
  Claude-modeller. Når assistenten er aktiveret, omfatter dette ny
  indgående post, der behandles automatisk — ikke kun det, du selv
  åbner. Anthropic bruger ikke disse data til at træne sine modeller,
  jf. deres kommercielle betingelser for API-adgang. Anthropic kan
  opbevare prompts i op til 30 dage til misbrugsovervågning.
- RevenueCat, Inc. (USA): administrerer din abonnementsstatus og dine
  rettigheder. Modtager et pseudonymt bruger-id og abonnementshændelser
  fra App Store / Google Play. RevenueCat modtager ikke dit
  mail-indhold, din kalender eller dine kortoplysninger.
- Apple App Store / Google Play: behandler abonnementskøb og er din
  modpart for selve betalingen. Vi modtager ikke dine kortoplysninger.
- GitHub, Inc. (GitHub Pages) / Vercel Inc.: hosting af denne
  privatlivspolitik og zolva.io-hjemmesiden. Som enhver webhost logger
  de almindelige besøgsdata (fx IP-adresser), når du åbner disse sider;
  ingen data fra selve appen sendes til dem.

## 6. Hvorfor vi behandler dine data (retsgrundlag)

- Opfyldelse af aftale (art. 6, stk. 1, litra b): for at levere Zolvas
  kernefunktioner — dagens overblik, mail-assistent, kalender,
  påmindelser — samt for at levere og fakturere betalte abonnementer.
- Samtykke (art. 6, stk. 1, litra a): når du aktiverer specifikke
  valgfrie funktioner, for eksempel forbindelse til
  Google/Microsoft/iCloud, aktivering af assistenten og automatiske
  handlinger, "Nye mails"-notifikationer eller push-notifikationer. Du
  kan trække samtykket tilbage når som helst i Indstillinger.

## 7. Datalagring og -opbevaring

- OAuth-refresh-tokens og iCloud-loginoplysninger: opbevares så længe du
  har kontoen forbundet. Slettes når du kobler kontoen fra eller sletter
  din konto.
- Mail- og kalenderindhold sendt til Claude: sendes til Anthropic ved
  behov og opbevares ikke permanent af Zolva. Anthropic kan opbevare
  prompts i op til 30 dage til misbrugsovervågning.
- Abonnementsdata: opbevares så længe din konto findes, og så længe det
  kræves af regnskabs- og forbrugerretlige forpligtelser; slettes med
  din konto med forbehold for disse forpligtelser.
- Chat-, påmindelses- og assistent-hukommelsesdata: opbevares lokalt på
  din enhed og/eller i vores database tilknyttet din bruger-ID, indtil
  du sletter dem eller sletter kontoen.
- Push-token: opbevares indtil du slår notifikationer fra eller sletter
  kontoen.
- Fejl-logs uden indhold: op til 30 dage, herefter slettet.
- Kontodata ved sletning: slettes når du sletter din konto i appen (se
  afsnit 12). Sikkerhedskopier overskrives i en rullende cyklus på op
  til 30 dage.

## 8. Datalokation og overførsel

Databaser og edge functions kører i EU (Irland, eu-west-1). Overførsler
til Anthropic (USA) og RevenueCat (USA) sker på grundlag af
Standardkontraktbestemmelser (SCC'er) jf. Kommissionens afgørelse
2021/914. Google, Microsoft og Apple behandler dine data i henhold til
deres egne politikker og overførselsmekanismer, herunder EU-U.S. Data
Privacy Framework.

## 9. Sikkerhed

Alle forbindelser mellem appen og vores backend bruger TLS.
OAuth-tokens og iCloud-loginoplysninger opbevares i iOS Keychain eller
Android Keystore via krypteret app-storage på din enhed, og
refresh-tokens på backend er adgangsbegrænsede. iCloud-loginoplysninger
på backend er desuden krypteret i hvile, og krypteringsnøglen opbevares
uden for databasen. Database-adgang styres via Row-Level Security, så
brugere kun kan tilgå egne data.

## 10. Cookies og lokal lagring

Zolva er en mobil-app og anvender ikke cookies. Appen bruger iOS
Keychain og Android Keystore til at opbevare OAuth-tokens og
iCloud-loginoplysninger sikkert lokalt på din enhed, samt almindelig
app-lagring til præferencer og cache.

## 11. Dine rettigheder (GDPR)

Du har ret til:

- Indsigt: få oplyst hvilke data vi har om dig.
- Berigtigelse: få ukorrekte data rettet.
- Sletning ("retten til at blive glemt"): få dine data slettet. Brug
  "Slet konto" i Indstillinger (se afsnit 12).
- Dataportabilitet: få udleveret dine data i et maskinlæsbart format.
  Skriv til kontakt@zolva.io, så leverer vi en kopi inden for 30 dage.
- Begrænsning og indsigelse: få behandlingen begrænset eller gøre
  indsigelse mod den.
- Tilbagekaldelse af samtykke: hvor behandlingen sker på samtykke, kan
  du trække det tilbage. Tilbagekaldelsen påvirker ikke lovligheden af
  behandling, der er sket før tilbagekaldelsen.

Send din forespørgsel til kontakt@zolva.io. Vi svarer inden for 30 dage.

## 12. Sletning af konto

Du kan slette din konto når som helst:

1. Åbn Indstillinger i Zolva.
2. Rul ned til Konto > Slet konto.
3. Bekræft ved at skrive "SLET" og tryk Slet konto permanent.

Sletning køres med det samme og fjerner: kontooplysninger,
OAuth-refresh-tokens, push-tokens, mail-watcher-tilstand,
abonnements-/rettighedsdata og alle rækker i vores database tilknyttet
din bruger-ID (herunder chat, mail, kalender, fakta og assistent-data).
Vi forsøger at tilbagekalde dit Google-OAuth-token; Microsoft tilbyder
ikke tilbagekaldelse pr. token, så et eventuelt resterende
Microsoft-samtykke består, indtil det udløber, eller du tilbagekalder
det i din Microsoft-konto. Forbundne iCloud-loginoplysninger fjernes,
når du kobler iCloud fra eller sletter din konto. Handlingen kan ikke
fortrydes.

## 13. Klageret

Du har ret til at klage til tilsynsmyndigheden. I Danmark er det:

Datatilsynet
Carl Jacobsens Vej 35
2500 Valby
Telefon: +45 33 19 32 00
Email: dt@datatilsynet.dk
Web: https://www.datatilsynet.dk

## 14. Børn

Zolva er ikke rettet mod børn under 13 år (jf. databeskyttelseslovens
§ 6), og vi indsamler ikke bevidst data om børn. Hvis du tror, at et
barn har givet os data, så kontakt os og vi sletter dem.

## 15. Ændringer til denne politik

Vi opdaterer politikken når vores databehandling ændrer sig. Væsentlige
ændringer meddeles i appen. Seneste opdateringsdato fremgår øverst.

## 16. Kontakt

Spørgsmål? Skriv til kontakt@zolva.io.
