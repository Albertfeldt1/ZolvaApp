# Papir — Komplet QA-gennemgang (Pre-Launch Audit) — 2026-07-05

**Metode:** 5 parallelle QA-agenter med hver sit lens (Navigation/Shell · Stemmeflow · Data-skærme · Mail/Chat/Briefing · Profil/Settings/App Store). Alle fund er kodeverificerede med fil:linje; dubletter på tværs af agenter er flettet; 12 "virker korrekt"-ikke-fund og 3 falske positiver er fjernet efter manuel efterprøvning (se *Verifikationsnoter* nederst).

**Vigtig ramme:** Papir kører i dag KUN bag en `__DEV__`-toggle — en App Store-reviewer kan ikke se den i et release-build. App Store-/GDPR-fundene nedenfor gælder derfor **den dag Papir skibes som primær UI**. De er markeret ⚖️.

**Optælling:** 🔴 5 · 🟠 14 · 🟡 17 · 🟢 15 = **51 fund**

**✅ STATUS (2026-07-06):** Fase A gennemført i commit `eb55cbe` — K4, K5, H2, H8, H9, H10, M2, M4, M5, M6, M8, M10, M11, L6, L13 fikset; M17 verificeret allerede-korrekt (agent-fejllæsning). **Fase B gennemført i commit `cc4061e`** — K3, H5, H6, H7, H11 (inkl. det klassiske sentinel-fix i reminders.ts), H13, H14, M3, M14 fikset. **M1 udskudt** med begrundelse: legacy `uploadAsync` har intet abort-signal; et skifte til moderne upload-API skal undersøges separat (den pålidelige upload-sti byttes ikke væk for en kant-case). **Fase C gennemført i commit `c785960`** — K1 (delte session-overlays over begge UI'er), K2 (Slet konto i Papir), H1 (LoginCta-bar), H3 (memory-consent-dialog), H4 (Gendan køb), H12 (ærlig briefing-tom-tilstand). **Simulator-verifikation af overlay-flowene (K1) anbefales før merge** — onboarding-kæden er kun typechecket, ikke gennemklikket.

**Fase D gennemført i commit `8cb0f28`** (+ parallel-sessionens polish-runder 1–4, der bl.a. lukkede NAV-3-klassen, tomme-tilstande og loader-branding) — M7 (undo på klaret), M9 (søge-highlight via requestHistorySegment), L2, L5, L8, L9, L10, L12, L15. **Udskudt til paritets-backlog:** M1, M12, M13, M15, M16, L4, L7, L11, L14. Dermed er alle 4 QA-faser lukket; tilbage står kun backloggen + de udskudte store fund.

---

## 🔴 Kritiske (blokerer lancering af Papir som primær UI)

### K1 ⚖️ Onboarding, memory-consent og integrations-setup springes helt over
- **Skærm:** App.tsx (root) / hele Papir · *[AUTH-2 + PAPIR-FLAG-1 + NAV-5-delvis]*
- **Reproduktion:** Ny bruger → log ind via Papirs AuthSheet → lander direkte i tom Papir.
- **Forventet:** V2-onboarding-wizard, memory-consent-modal og integrations-opsætning som i klassisk.
- **Faktisk:** App.tsx's early-return (`if (papirEnabled) return <PapirRoot/>`, App.tsx:565-572) renderer aldrig overlay-modalerne (onboarding, MemoryConsent, IcloudSetup, MS-admin-consent), selvom deres state-logik kører.
- **Konsekvens:** Førstegangsbruger får ingen consent (GDPR), ingen integrationer, ingen præferencer — tom app uden vej frem. Apple 5.1.1-risiko.
- **Årsag:** Bevidst M0-scope ("klassisk-only indtil paritetsfasen") — men det ER launch-blokerende.
- **Løsning:** Render App.tsx's overlays OVEN på PapirRoot i papir-grenen (samme JSX-mønster som klassisk sti), eller giv PapirRoot en context/callbacks til at åbne dem.
- **Kompleksitet:** Stor (3-4 t)

### K2 ⚖️ Kontosletning er uopnåelig fra Papir (Apple 5.1.1(v))
- **Skærm:** PapirSettings / PapirProfile · *[SETTINGS-3 + STORE-3]*
- **Reproduktion:** Indstillinger i Papir → scroll til bund → ingen "Slet konto".
- **Forventet:** Konto-sletning direkte tilgængelig i appen (Apple-krav + GDPR "ret til at blive glemt").
- **Faktisk:** Klassisk har `DeleteAccountScreen`; Papir har intet.
- **Konsekvens:** Garanteret App Store-afvisning hvis Papir er primær UI.
- **Løsning:** Genbrug `DeleteAccountScreen` som overlay fra PapirSettings ("Fare-zone"-gruppe m. rød "Slet konto"-række).
- **Kompleksitet:** Mellem (~45 min)

### K3 Fast 60s upload-timeout gør lange optagelser umulige at gemme på langsomt net
- **Skærm:** PapirTranscription / transcribe.ts:22 · *[VOICE-3]*
- **Reproduktion:** Optag 8-10 min → upload over 3G/svagt WiFi → >60 s → "Transskriberingen tog for lang tid".
- **Forventet:** Upload gennemføres; timeout skal fange *hængte* uploads, ikke langsomme.
- **Faktisk:** `Promise.race` med fast 60s (M82-fixet var for aggressivt). Proxy accepterer 25 MB ≈ 25 min lyd — som aldrig kan nå frem på langsomt net. Retry hjælper ikke (samme timeout).
- **Konsekvens:** Kernefunktionen fejler permanent for lange optagelser; optagelsen går tabt ved exit.
- **Løsning:** Dynamisk timeout efter filstørrelse (fx `max(60s, bytes/50KB/s)`) + upload-progress i UI.
- **Kompleksitet:** Mellem

### K4 Android-back kan ikke lukke login-sheetet (bruger sidder fast-følelse)
- **Skærm:** PapirRoot (AuthSheet-overlay) · *[NAV-1]*
- **Reproduktion:** Logget ud → åbn AuthSheet → tryk hardware-back på Android.
- **Forventet:** Sheetet lukker.
- **Faktisk:** PapirShells BackHandler (PapirShell.tsx:83-103) konsumerer eventet (popper stak/tab) og kender ikke til auth-overlayet i PapirRoot.
- **Konsekvens:** Sheetet føles "fastlåst"; back-knappen gør noget usynligt bag overlayet.
- **Løsning:** BackHandler i PapirRoot der lukker sheetet (registreres efter shellens, så den fyrer først), eller lad shellens handler tjekke authOpen via prop.
- **Kompleksitet:** Lille

### K5 Udløbne provider-tokens giver tom indbakke uden forklaring eller fix-sti
- **Skærm:** PapirInbox · *[MAIL-1 + AUTH-4]*
- **Reproduktion:** Lad Google/Microsoft-token udløbe (eller iCloud-password afvises) → åbn Papir-indbakken.
- **Forventet:** Banner: "Gmail-forbindelsen er udløbet — genopret i Indstillinger" m. CTA (klassisk Inbox har præcis dette).
- **Faktisk:** `useInboxWaiting` leverer `providerErrors`, men PapirInbox renderer dem aldrig — brugeren ser tom/stale liste eller "Alt er klaret".
- **Konsekvens:** Bruger tror mails er væk/appen er i stykker; ingen vej til reparation (re-auth-flows findes heller ikke i Papir → K1).
- **Løsning:** Rendér `inbox.providerErrors` som banner-række(r) med provider-navn + CTA. Kortsigtet kan CTA'en henvise til klassisk UI.
- **Kompleksitet:** Lille-Mellem

---

## 🟠 Høje

### H1 ⚖️ Logget-ud-oplevelsen: ingen login-CTA uden for Profil-tabben
*[NAV-2 + STORE-4 + AUTH-3]* — **Skærm:** Home/Plan/Historik/Inbox/Chat. **Repro:** Åbn Papir logget ud. **Forventet:** Tydelig "Log ind"-affordance (klassisk har LoginCtaBar). **Faktisk:** Tomme lister/"ingen møder" — identisk med en bruger der HAR 0 data; login findes kun via Profil. Efter logout samme forvirring ("hvor er mine ting?"). **Konsekvens:** Apple 5.1.1-gråzone + discoverability. **Løsning:** Papir-udgave af LoginCtaBar i PapirRoot ved `loggedOut` + logget-ud-empty-states der peger på login. **Kompleksitet:** Mellem.

### H2 AuthSheet giver ingen feedback ved login-fejl
*[AUTH-1 — arvet klassisk H3]* — **Skærm:** AuthSheet.tsx:27-31. **Repro:** Log ind → afbryd/netværksfejl. **Faktisk:** Spinneren stopper, intet sker — fejlen sluges (kun dev-log). **Konsekvens:** Bruger fatter ikke hvorfor login "ikke virkede". **Løsning:** `error`-state + dansk fejltekst i sheetet; hold det åbent. Fixer også klassisk H3. **Kompleksitet:** Lille.

### H3 ⚖️ Memory-toggle uden consent + utilgængelige setup-flows
*[SETTINGS-2 + NAV-5]* — **Skærm:** PapirSettings:197. **Repro:** Slå "Lad Zolva lære dig at kende" til. **Forventet:** Consent-forklaring først (klassisk viser MemoryConsentModal). **Faktisk:** Flipper øjeblikkeligt uden forklaring (GDPR: informeret samtykke). iCloud-setup/MS-admin-consent kan slet ikke nås fra Papir. **Løsning:** Intercept flip for `memory-enabled` m. consent-dialog (genbrug klassisk tekst); setup-flows følger K1-overlays. **Kompleksitet:** Lille (consent) / følger K1 (flows).

### H4 ⚖️ "Gendan køb" skal verificeres/tilføjes
*[PREMIUM-2]* — **Skærm:** PapirProfile. **Repro:** Pro købt på anden enhed → Papir → paywall. **Faktisk:** Papir har ingen egen "Gendan køb"; RevenueCats paywall-UI *plejer* at have den, men det er uverificeret her — klassisk Settings har eksplicit knap. **Konsekvens:** Apple kræver restore-mekanisme hvor køb tilbydes. **Løsning:** Verificér RC-paywallen på device; tilføj under alle omstændigheder "Gendan køb"-række i Papir (Purchases.restorePurchases + kvittering). **Kompleksitet:** Lille-Mellem.

### H5 Markdown renderes råt i chatten
*[CHAT-1]* — **Skærm:** PapirChat:145. **Repro:** Stil et spørgsmål → svar med `**fed**`/lister viser bogstavelige asterisker. Klassisk bruger `renderInlineMd`. **Konsekvens:** Ser uprofessionelt ud i kerneflowet. **Løsning:** Genbrug `renderInlineMd` fra components/inline-md i ZolvaMsg m. Papir-typografi. **Kompleksitet:** Mellem.

### H6 Android hardware-back omgår udkast-guarden i mail-detaljen
*[MAIL-4]* — **Skærm:** PapirMailDetail. **Repro:** Skriv svar → tryk hardware-back. **Forventet:** "Forlad udkast?"-guard (som header-back har). **Faktisk:** PapirShells BackHandler popper stakken direkte — udkastet tabes stumt. **Løsning:** Skærm-registreret back-guard (fx `setBackGuard`-callback i nav-context som shellens handler konsulterer før pop). **Kompleksitet:** Mellem.

### H7 Frossen tid på keep-alive-tabs (midnat/lange sessioner)
*[DATA-1 — klassisk H24/M53-klassen genopstået]* — **Skærme:** PapirHome:155, PapirPlan:96, PapirHistory:67, PapirSearch:34. **Repro:** Åbn 23:50 → baggrund → åbn 00:05: "I dag"-grupper, hilsen og due-filtre er fra i går; tabs unmountes aldrig (M85-designet). **Løsning:** Fælles `useNow(60_000)`-hook (+ AppState-refresh) i de fire skærme. **Kompleksitet:** Mellem.

### H8 Ingen pull-to-refresh nogen steder
*[DATA-2 + MAIL-2]* — **Skærme:** Home, Plan, Historik, Inbox. **Repro:** Træk ned → intet. Klassisk Inbox/Today har det; `refreshMailNow()`/`refreshCalendarNow()` findes allerede. **Konsekvens:** Ingen måde at tvinge frisk data — særligt slemt kombineret med K5. **Løsning:** `RefreshControl` pr. skærm koblet på de eksisterende refresh-funktioner. **Kompleksitet:** Lille.

### H9 Fejl vises som evig "Henter…" eller falske nul-tal på Home
*[DATA-3 + DATA-15 + DATA-18]* — **Skærm:** PapirHome:173. **Repro:** Dræb netværket → åbn Home. **Faktisk:** `statusReady` tjekker kun `loading`, ikke `error` → enten evig "Henter dit overblik…" eller "ingen møder og ingen nye mails" præsenteret som fakta. `useReminders` sluger fejl helt. **Løsning:** Error-gren i statuslinjen ("Kunne ikke hente overblik — tjek forbindelsen") + fejl-tekst i lister. **Kompleksitet:** Lille.

### H10 Mikrofon-afvisning er en blindgyde
*[VOICE-1]* — **Skærm:** PapirRecord:48. **Repro:** Afvis mikrofon-tilladelse → tryk optag igen. **Faktisk:** Alert uden handlinger; brugeren må selv finde Indstillinger. **Løsning:** Alert m. "Åbn indstillinger"-knap (`Linking.openSettings()` — mønstret findes i PapirSettings:112). **Kompleksitet:** Lille.

### H11 Handlinger uden tidspunkt: skjult 2099-dato eller fejl først ved tryk
*[VOICE-6 + VOICE-7 + VOICE-12 — interagerer med klassisk H11 (ufikset)]* — **Skærm:** PapirTranscription ActionCard. **Repro:** Optag "påmind mig om at ringe til Søren" (ingen tid) → Tilføj. **Faktisk:** Reminder oprettes uden due-tid → lagres med 2099-sentinelen, som (pga. det ufiksede H11) vises som forfaldsdato 31.12.2099 under "Kommende". Events kaster først fejl EFTER tryk; kort med/uden tid ser identiske ud. **Løsning:** Markér kort uden `whenISO` visuelt ("⚠️ Uden tidspunkt"); reminder-kort må gerne kunne tilføjes (uden tid er gyldigt) men vis "uden tid" eksplicit; fix H11-mapningen i reminders.ts (sentinel → null). **Kompleksitet:** Lille-Mellem.

### H12 "Opdatér" på tom briefing ligner en død knap
*[BRIEF-1]* — **Skærm:** PapirBriefing. **Repro:** Åbn før dagens brief findes → tryk Opdatér. **Faktisk:** `refresh()` re-fetcher kun (genererer ikke) → samme tomme skærm; knappen virker i stykker. **Løsning:** Kortsigtet: erstat knap med "Din briefing lander kl. {brugerens briefing-tid}"; langsigtet: manuel trigger via forced-brief-flowet. **Kompleksitet:** Lille (tekst) / Mellem (trigger).

### H13 "Ryd samtalen" sletter kun lokalt — server-historikken består
*[CHAT-3 — samme adfærd i klassisk]* — **Skærm:** PapirChat / hooks.ts:5713-5718. **Repro:** Ryd samtale → data ligger stadig i `chat_messages`. **Konsekvens:** Privacy-forventning brydes ("slettet" er ikke slettet). Klassisk MemoryScreen har server-sletning — genbrug den. **Løsning:** Server-delete i `clear()` (med loading-state), eller omdøb til "Ryd visning" + henvis til Memory-sletning. **Kompleksitet:** Mellem.

### H14 Baggrund af appen midt i optagelse kan miste optagelsen uden feedback
*[VOICE-4]* — **Skærm:** PapirRecord. **Repro:** Optag → Home-knap → vent → tilbage → Stop. **Faktisk:** Ingen AppState-håndtering; iOS suspenderer og recorder-state kan være inkonsistent (tom/korrupt URI) uden besked. **Løsning:** AppState-listener: auto-stop (og bevar filen) ved baggrund + informér ved retur; kræver device-test. **Kompleksitet:** Mellem.

---

## 🟡 Mellem

| ID | Skærm | Fund | Løsning | Komp. |
|---|---|---|---|---|
| M1 *[VOICE-5]* | Transskribering | "Kassér"/back under upload annullerer ikke in-flight upload — kvote forbrændes i baggrunden | Cancel-flag som transcribeAudio tjekker; eller moderne FileSystem-API m. AbortController | Mellem |
| M2 *[VOICE-8]* | Transskribering | Luk provider-vælgeren via baggrund → fejl-Alert "Annulleret." for en bruger-handling | Luk stille: `setPickFor(null)` + reset kort-state uden alert | Lille |
| M3 *[VOICE-9]* | Transskribering | Offline "Gem note" giver generisk "Prøv igen" uden offline-hint | Netværks-specifik besked; inline ⚠️-banner frem for alert ved gentagen fejl | Lille |
| M4 *[SETTINGS-1]* | Indstillinger | `setValue`-resultat ignoreres — præference ser gemt ud men reverter ved fejl | Tjek `{ok}` + Alert ved fejl | Lille |
| M5 *[PREMIUM-1]* | Profil | `presentPaywall()`-resultat ignoreres — intet feedback hvis paywall fejler at åbne | Await + fejl-Alert; entitlement-listener håndterer succes | Lille |
| M6 *[DATA-5]* | Home/Plan | Overskredne opgaver fra tidligere dage viser kun klokkeslæt → ligner i dag | Dag-præfiks når dueAt ≠ i dag ("i går · 14.30") | Lille |
| M7 *[DATA-6]* | Home/Plan | markDone uden undo — misclick kan ikke fortrydes (ingen un-done-API) | 3s undo-toast før commit, eller un-done-API | Mellem |
| M8 *[DATA-4]* | Home | Opgaveliste cappet til 5 uden indikator på flere | "Se plan (8)"-tekst i SectionHeader når cappet | Lille |
| M9 *[DATA-8]* | Søg | Resultat-tap skifter bare tab — brugeren skal selv finde emnet igen | Nav-param `highlightId` + scroll-to + kort highlight i Historik/Plan | Mellem |
| M10 *[CHAT-2]* | Chat | Kvote-banner: reset-tiden opdaterer aldrig og banneret forsvinder ikke når tiden passeres | Minut-ticker + auto-clear når `resetsAt` passeres (mønster i klassisk ChatScreen:74-80) | Lille |
| M11 *[MAIL-5]* | Mail-detalje | Dobbelttryk på Send kan åbne to confirm-alerts (sending-state er async) | `sendingRef`-gate før Alert | Lille |
| M12 *[MAIL-6]* | Mail-detalje | Vedhæftninger vises ikke (OBS: heller ikke i klassisk — fælles hul, ikke Papir-regression) | Udvid MailDetail m. attachments-metadata + rækker; separat feature | Stor |
| M13 *[NAV-4]* | Push-skærme | Ingen iOS swipe-back — kun header-knappen | PanGesture på push-lag der popper stakken | Mellem |
| M14 *[VOICE-17]* | Optag/Transskribér | 0-sekunders optagelse kan gemmes som meningsløs "Tom optagelse"-note | Deaktivér Gem + vis "Optagelsen var tom" når transcript er tomt | Lille |
| M15 *[DATA-12]* | DayTimeline | 3+ samtidige events: kun 2 kolonner — nr. 3 tegnes ovenpå | Fuld kolonne-tildeling (interval-farvning) eller "+1 mere"-chip | Stor |
| M16 *[DATA-9]* | Plan/Kalender | Ugestriben viser kun 7 dage FREM — gårsdagen kan ikke tjekkes (klassisk: ±52 uger) | Udvid til fortid (pagineret stribe) — paritetspunkt | Stor |
| M17 *[VOICE-15]* | Optager | Pause/genoptag: state sættes FØR try — UI og recorder kan komme ud af sync ved fejl | Sæt state efter succes; revert i catch | Lille |

---

## 🟢 Lave

| ID | Skærm | Fund | Komp. |
|---|---|---|---|
| L1 *[DATA-7]* | Alle | Tre klokkeformater i appen: "13.55" (Home/Plan) vs "9:41" (Historik/Søg) vs "13.00" (timeline) — lav fælles `formatClock()` | Lille |
| L2 *[NAV-6]* | Headers | IconButton 38pt < 44pt-anbefalingen — tilføj hitSlop | Lille |
| L3 *[NAV-3]* | Bottom nav | RecordFAB har ingen disabled/optager-state (harmløst pga. fuldskærms-overlay) | Lille |
| L4 *[VOICE-10]* | Optager | Waveform er ren dekoration (random) — kan vildlede om lydniveau/kvalitet | Lille-Mellem |
| L5 *[VOICE-11]* | Optager | Timer viser "120:00" ved >99 min — skift til H:MM:SS over 1 time | Lille |
| L6 *[VOICE-13]* | Transskribering | Død ternary `=== 1 ? 'ting' : 'ting'` — fjern eller brug "handling/handlinger" | Triviel |
| L7 *[VOICE-14]* | Transskribering | 429-besked uden reset-tid eller opgraderings-hint | Mellem |
| L8 *[VOICE-18]* | Optager | a11y: Stop/Pause-labels uden varighed ("Stop optagelse, 1 minut 30") | Lille |
| L9 *[DATA-10]* | Plan/Kalender | Tom dag = tom grid uden "Ingen begivenheder"-besked | Lille |
| L10 *[DATA-13]* | Søg | autoFocus kan hakke mod slide-in-animationen på langsomme enheder — delay focus ~250ms | Lille |
| L11 *[DATA-16]* | Historik | ScrollView uden virtualisering — jank ved 500+ noter (FlatList senere) | Stor |
| L12 *[DATA-17]* | Søg | Filter pr. tastetryk uden debounce — mærkbart ved 1000+ emner (`useDeferredValue`) | Lille |
| L13 *[MAIL-8]* | Mail-detalje | Tom afsender/emne renderes som tom streng — fallback "Ukendt afsender"/"Uden emne" | Lille |
| L14 *[CROSS-1]* | Mail-detalje | Regex-baseret stripHtml kan lække tags i eksotiske mails (delt med klassisk) | Mellem |
| L15 *[BRIEF-3]* | Briefing | Kind-hilsen ("Godaften…") kan stå forkert ved døgnskifte m. åben app — beregn hilsen af klokken | Lille |

---

## Verifikationsnoter (rettelser af agent-fund)

1. **STORE-1 (permissions) NEDGRADERET til 🟢:** Agenten hævdede manglende/deprecated permission-strenge. Manuelt verificeret: `NSMicrophoneUsageDescription` sættes korrekt på dansk via expo-audio-pluginet (bekræftet i genereret Info.plist:54); `expo-speech-recognition` er IKKE på denne branch (ingen streng nødvendig); appen bruger hverken EventKit-kalender eller kontakter (ingen NSCalendars/NSContacts nødvendig). Tilbage står kun: `NSUserNotificationsUsageDescription` i app.json er ikke en reel iOS-nøgle (harmløs, kan slettes). **Ingen App Store-risiko her.**
2. **"Papir sender uden signatur" AFKRÆFTET:** Signatur appendes inde i provider-lagene (gmail.ts:385 `appendGmailSignature`; graph/iCloud via `buildOutgoingBody`) — Papirs `useSendReply` får den automatisk.
3. **VOICE-2 (optagelse under opkald) UDELADT:** Spekulativt uden device-test; expo-audio/iOS afbryder normalt optagelse ved opkald. Tag med i manuel device-testplan i stedet.
4. **Droppet som "virker korrekt":** VOICE-16 (dobbelt-stop er gated), MAIL-3, MAIL-7, CHAT-5, CHAT-6, BRIEF-2, BRIEF-4, CROSS-2, CROSS-3, STORE-2 (dev-toggle er fin som-er).

## Anbefalet rækkefølge

**Fase A — hurtige gevinster m. stor effekt (≈1 dag):** K4, K5, H2, H8, H9, H10, M2, M4, M5, M6, M8, M10, M11, M17, L6, L13.
**Fase B — kernefunktion robust (≈1-2 dage):** K3 (upload-timeout), H7 (useNow), H11 (+klassisk H11-fix), H14, M1, M3, M14, H5 (markdown), H6 (back-guard).
**Fase C — launch-krav (⚖️, før Papir bliver primær UI):** K1 (overlays), K2 (kontosletning), H1 (logget-ud), H3 (consent), H4 (restore), H12, H13.
**Fase D — polish/paritet:** resten af 🟡/🟢 + paritets-backloggen (fuld Settings, onboarding, agent-sektion, notifikationsfeed, push-routing, widget).

**Hovedkonklusion:** Kernen er reelt funktionel, og intet af det fundne er arkitektonisk — men Papir er IKKE klar til at være primær UI før Fase C er lukket. Som dev-toggle kan alt i Fase A+B fikses løbende uden risiko for produktionen.
