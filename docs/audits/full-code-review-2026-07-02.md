# Komplet code review — hele kodebasen (2026-07-02)

**Metode:** 8 parallelle review-agenter (Claude Fable 5) med hver sit område: app-kerne/auth, klient-datalag (`src/lib`), klassiske screens, Papir-redesign + design-system, komponenter, edge functions (AI/agent), edge functions (integrationer/betaling), database/RLS + config/tooling. Alle fund er verificeret mod konkret kode; dubletter på tværs af agenter er flettet. Branch: `feat/papir-redesign`.

**Omfang:** ~75.000 linjer — 234 TS/TSX-filer i `src/`, 30 edge functions (~24.000 linjer Deno), 55 migrationer, config/plugins/targets.

**Status:** Ingen kode er ændret. Rapporten er arbejdslisten; fund refereres med ID (K=kritisk, H=høj, M=mellem, L=lav).

| Prioritet | Antal |
|---|---|
| 🔴 Kritisk | 8 |
| 🟠 Høj | 41 |
| 🟡 Mellem | ~65 |
| 🟢 Lav | ~55 |

**Tværgående temaer** (én beslutning lukker mange fund):
1. **Ingen sikkerhedsnet i processen:** ingen CI, ingen ESLint, rød typecheck, ingen crash-rapportering (H39–H40, K3, M-config). Det er sådan K1 og K2 har kunnet ligge ubemærket.
2. **Supabase-builders kaster ikke** — `{ error }` ignoreres eller wrappes i død try/catch mange steder (H10, M-lib flere).
3. **"Tjek uid efter await"-guarden** findes i de bedste moduler men mangler i 4–5 andre → kontoskifte-races (M-lib).
4. **UTC vs. lokal dansk dag** går igen i mindst 6 filer (H21, M-lib flere).
5. **Copy-paste-infrastruktur der er divergeret** — realtime-hooks, bottom-sheets, JWT-verifikation, billede-pipeline. K2 er præcis denne fejlklasse.
6. **Tre parallelle theme-systemer** uden udfasningsplan (H41, H32).

---

## 🔴 Kritiske fund

### K1. `PAPIR_PREVIEW = true` er committet i app-entrypointet
- **Placering:** `index.ts:10-15` (commit `adbd473`)
- **Problem:** `registerRootComponent(PAPIR_PREVIEW ? PapirPreviewRoot : App)` med flaget hardcodet `true`. Hele den rigtige app (auth, mail, kalender, chat) er koblet fra på branchen. Fundet uafhængigt af 3 agenter.
- **Hvorfor:** En merge + EAS Update ville skibe en statisk prototype uden login til alle brugere. Projektet har allerede haft én prod-OTA-crash, og der er ingen crash-rapportering til at opdage det.
- **Løsning:** `const PAPIR_PREVIEW = __DEV__ && process.env.EXPO_PUBLIC_PAPIR_PREVIEW === '1'`. Udvid desuden fail-fast-guarden i `app.config.js` til at kaste ved prod-build med flaget sat.
- **Indsats:** Lille

### K2. `agent-approve` sender aldrig godkendte svar — men markerer dem som sendt
- **Placering:** `supabase/functions/agent-approve/index.ts:139-147` + `_shared/agent/tools/dispatch.ts:558`
- **Problem:** Dispatch-gaten kræver `opts.safety.railsOk` (tilføjet 2026-06-10 i commit `c032968`), men `agent-approve` bygger stadig safety-objektet uden feltet → `!undefined === true` → dispatch returnerer `mode: 'propose'` uden at sende. `agent-approve` tjekker aldrig `exec.mode` og markerer alligevel `executed` + svarer `{ ok: true, sent: true }`.
- **Hvorfor:** Brugeren trykker "Send", appen siger sendt, mailen sendes aldrig (bliver i Drafts). Kernefunktion brudt siden 10. juni. Trust-eskalering tæller oveni de falske `executed`-rækker. `edited_body`-stien rammes også.
- **Løsning:** (1) Tilføj `railsOk: true` i `agent-approve`s safety-objekt. (2) Tjek `exec.mode === 'executed'` før proposal markeres executed. (3) `deno check` i CI + integrationstest. (4) Verificér prod-data: er `executed`-rækker efter 2026-06-10 reelt sendt?
- **Indsats:** Lille for fixet; Mellem inkl. test + dataoprydning
- **✅ STATUS (2026-07-05):** Fixet i commit `28194eb` (railsOk + `exec.mode`-tjek) og deployet som `agent-approve` v16 kl. 13:06. Prod-data verificeret via SQL: **0** `executed`-rækker i bug-vinduet (10/6→5/7) — kun 2 executed nogensinde, begge 30/5 (før buggen). Ingen brugere ramt, ingen oprydning nødvendig. Punkt (3) — CI/test — udestår (H40).

### K3. Reel TypeScript-fejl: `runTurn` returnerer streng hvor `TurnResult` kræves
- **Placering:** `src/lib/hooks.ts:5393` (type :5277, caller :5553)
- **Problem:** `return CHAT_ERROR_TEXT;` i chat-fejlgrenen, men signaturen er `Promise<TurnResult>`. `npx tsc --noEmit` fejler med præcis denne ene fejl — `npm run typecheck` er rød.
- **Hvorfor:** Ved runtime bliver `answer` `undefined`, `answer.length` kaster TypeError, og quota-/ratelimit-håndteringen i fejlgrenen rammes aldrig; brugeren reddes kun tilfældigt af den generiske `.catch`.
- **Løsning:** `return { text: CHAT_ERROR_TEXT, finalizeJobId: null };`
- **Indsats:** Lille (én linje)
- **✅ STATUS (2026-07-05):** Fixet i commit `ea22aba`; `npx tsc --noEmit` er grøn.

### K4. Afbrudt OAuth-reconnect efterlader brugeren unlinked eller helt logget ud
- **Placering:** `src/lib/auth.ts:351-374, 427-435`
- **Problem:** `runOAuth` muterer auth-state FØR browseren åbnes (`signOut()` for eneste-identitet, `unlinkIdentity` for flerkonto). Annullerer brugeren browser-flowet, returneres `{ data: null, error: null }` uden genopretning. Egen kommentar (:706-708) dokumenterer at `unlinkIdentity` revokerer ALLE refresh tokens.
- **Hvorfor:** Ét tryk på "Annullér" kan logge brugeren fuldt ud eller efterlade identiteten unlinked — og fordi fejlen returneres som `null`, kan callers ikke engang advare.
- **Løsning:** Udskyd den destruktive del til efter succesfuldt browser-resultat; ellers informér brugeren først og returnér eksplicit `cancelled`-status så UI kan route til login.
- **Indsats:** Mellem

### K5. Netværksfejl efterlader agent-knapper i evig spinner
- **Placering:** `src/components/AgentActionCard.tsx:74-80`, `AgentActionDetailModal.tsx:93-103`, `ProposedActionCard.tsx:44-59`, `ProposalDetailModal.tsx:99-123`
- **Problem:** `setPending(...); await revertAgentAction(...); setPending(null);` uden try/catch — lib-funktionerne (`agent-feed.ts:82`, `agent-proposals.ts:72,87`) bruger rå `fetch` der KASTER ved netværksfejl.
- **Hvorfor:** Offline er normaltilfældet på mobil. Knappen ("Send"/"Fortryd"/"Spring over") fryser i ActivityIndicator, ingen fejlbesked, unhandled rejection. Brugeren kan ikke betjene agentens forslag uden at lukke skærmen.
- **Løsning:** try/finally i alle fire handlers (+ fejlbesked), eller fang netværksfejl i lib-laget og returnér `{ ok: false }` konsekvent (se også M-lib: fælles `callEdgeFunction`-helper).
- **Indsats:** Lille

### K6. iCloud `updateEvent` sletter RRULE, deltagere, alarmer og undtagelser
- **Placering:** `src/lib/icloud-calendar.ts:1004-1019` (+ `buildVeventIcs` :915-938)
- **Problem:** Update PUT'er en minimal VEVENT (kun UID/DTSTAMP/DTSTART/DTEND/SUMMARY/LOCATION/DESCRIPTION) oven på den eksisterende ressource uden først at hente den. CalDAV-PUT erstatter hele ressourcen.
- **Hvorfor:** Redigerer brugeren (via chat/stemme) fx titlen på en gentaget begivenhed, bliver den til en engangs-begivenhed uden deltagere, alarmer og RECURRENCE-ID-overrides — stille datatab i brugerens kalender.
- **Løsning:** GET den eksisterende .ics, patch kun de ændrede properties, PUT tilbage — helst med `If-Match: <etag>`.
- **Indsats:** Mellem

### K7. Papir: tilbage-knappen på transskriptionsskærmen gør ingenting
- **Placering:** `src/screens/papir/PapirTranscription.tsx:123` + `PapirShell.tsx:68-76` + `PushHeader.tsx:21`
- **Problem:** `PushHeader`s back kalder `usePapirNav().back()` (`setPushed(null)`), men skærmen styres af `transcribeUri` — back ændrer intet. Kassér/Gem er skjult mens `loading` er true, og der er ingen timeout på transskriberingen (M-papir).
- **Hvorfor:** Under transskribering er der ingen fungerende vej ud — knappen ser trykbar ud, giver haptik, gør intet.
- **Løsning:** Giv `PushHeader` en `onBack`-prop og kald `onDone`; tilføj annullér-mulighed i loading-state.
- **Indsats:** Lille

### K8. Papir: funktionalitetsparitet — samtlige skærme er statiske mockups
- **Placering:** Hele `src/screens/papir/` (fx `PapirChat.tsx` 139 linjer vs `ChatScreen.tsx` 1.152; `PapirSettings.tsx` 106 vs `SettingsScreen.tsx` 3.864)
- **Problem:** Composer uden TextInput, hardcodet mail-liste, søgefelt der ikke er et input, hardcodet profil ("Oscar Hangaard"/"oscar@zolva.io"/128-64-41), toggles uden persistens, "Gem note" der intet gemmer, "Log ud" uden onPress. Forventeligt for fasen, men skal spores eksplicit ift. 100%-kravet.
- **Hvorfor:** Risiko for massiv undervurdering af wiring-arbejdet hvis mockups opfattes som "næsten færdige".
- **Løsning:** Byg en paritets-matrix (gammel skærm → Papir-skærm → manglende features) og wire til eksisterende hooks (`useChat`, `useInboxWaiting`, `useUser`, reminders …) før mere visuelt arbejde.
- **Indsats:** Stor (dage/uger)

---

## 🟠 Høje fund

### Auth & app-kerne

**H1. `initializing` flipper til false før sessionen er indlæst** — `src/lib/auth.ts:1048-1060` + `App.tsx:537`. Ved kold start findes et vindue hvor `initializing === false && user === null` trods gyldig session: `LoginCtaBar` blinker, og RevenueCat `logoutPurchases()`/`loginPurchases()` kører frem og tilbage. Fix: flip først når `getSession()` er resolvet (modul-flag + listener i stedet for `setTimeout(0)`). *Mellem.*

**H2. Kontosletning rydder ikke keychain og lokal brugerdata** — `DeleteAccountScreen.tsx:86-92`. Kalder rå `supabase.auth.signOut()` i stedet for `performSignOut` → Google/Microsoft provider-tokens og iCloud app-password (Apple-ID + password!) bliver i keychain — som kan overleve app-afinstallation. Kommentaren i `icloud-credentials.ts:14-16` om orphan-wipe er forkert. Fix: kald `performSignOut()` + slet iCloud-credential eksplicit. *Lille.*

**H3. AuthSheet viser aldrig login-fejl** — `AuthSheet.tsx:21-32`. `signInWithGoogle/Microsoft` kaster ikke, de returnerer `{ error }` — som aldrig inspiceres; sheet lukker som ved succes. Admin-consent-detektion får aldrig chancen. Fix: tjek resultatets `error`, hold sheet åbent med fejltekst (mønstret findes i SettingsScreens `LoginCard`). *Lille.*

### Backend — sikkerhed & økonomi

**H4. CRLF/mail-header-injektion i `buildRfc822` (Gmail-udkast)** — `supabase/functions/_shared/agent/tools/gmail.ts:122-136`. `to`/`subject`/`in_reply_to_message_id` interpoleres usaniteret i rå RFC822-headere; input kommer fra Claudes tool-input påvirket af angriberkontrolleret mail. `to = "x@y.dk\r\nBcc: attacker@evil.com"` → skjult Bcc sendes ved godkendelse. Fix: strip CR/LF + validér `to` mod e-mail-regex. Samme klasse på klienten: `src/lib/gmail.ts:612-617` (M-lib). *Lille.*

**H5. SSRF + iCloud-credential-forwarding i widget-action** — `widget-action/icloud-write.ts:37-50`, `provider-write.ts:101-123`. `calendarId` for iCloud er en fri CalDAV-URL fra `user_profiles` (klient-skrivbar via RLS); funktionen PUT'er dertil med Basic-auth (iCloud-email + app-password) uden host-validering — i modsætning til `icloud-creds-link`, der kræver `*.caldav.icloud.com`. Fix: genbrug host-valideringen (eller kræv samme origin som valideret `calendar_home_url`). *Lille.*

**H6. Ubegrænset input-størrelse på LLM-proxies → omkostningsrisiko** — `claude-proxy/index.ts:138-151`, `chat-run/index.ts:169-171`. Dagskvoten tæller requests (250–500/dag), ikke tokens; `messages` valideres kun som non-empty array. Scriptet klient kan sende ~200k tokens × 500/dag ≈ hundredvis af dollars pr. bruger pr. dag på delt org-nøgle. `transcribe-proxy`: 25 MB × 500/dag på delt OpenAI-nøgle. Fix: bound body-størrelse + token-baseret dagsgrænse (data findes i `record_claude_tokens`). *Mellem.*

**H7. Ugentlig chat-kvote kan omgås via `claude-proxy`** — kvoten (`check_and_incr_chat_quota`) håndhæves kun i `chat-run`; `claude-proxy` accepterer samme payload uden kvotetræk. Free-brugere får de facto 1.750/uge i stedet for 50 — paywallen kan aldrig udløses. Fix: træk kvote i claude-proxy for round-0-kald (kald uden `tool_result`-blokke), eller sænk dagsloftet markant. *Mellem.*

**H8. Session-scoped advisory lock over connection pool i poll-mail** — `migrations/20260420020000_poll_mail_lock.sql:5-21` + `poll-mail/index.ts:97,115`. `pg_try_advisory_lock` tages og frigives i to separate `.rpc()`-kald, der kan lande på forskellige pooler-connections → låsen frigives ikke korrekt / ingen reel mutual exclusion mellem overlappende cron-ticks. Fix: transaction-scoped mønster som `agent_claim_events` (`pg_advisory_xact_lock` i én SQL-funktion). *Mellem.*

**H9. `proposed_actions`/`trust_offers` UPDATE-policies uden kolonnebegrænsning** — `20260511180000:131-133`, `20260530150000:37-39`. `WITH CHECK` tjekker kun ejerskab: klienten kan via rå `.update()` sætte `status='executed'`, ændre `payload`/`preview` eller selv-promovere trust-offer til `accepted`. Ingen direkte mail-afsendelse trigges, men agent-tilstand og trust-eskaleringens integritet kan korrumperes. Fix: fjern klient-UPDATE (alt via edge functions) eller lås lovlige statusovergange + kolonner med trigger/column-grant. *Mellem.*

### Klient-datalag

**H10. Reminder-migrering sletter lokale data uden at tjekke insert-fejl** — `src/lib/reminders.ts:127-130`. `insert(rows)`-resultatet ignoreres (supabase-js kaster ikke); legacy-nøglen slettes og flaget sættes ubetinget → uigenkaldeligt datatab ved netværks-/RLS-fejl i one-shot-migrering. Fix: tjek `{ error }` før sletning/flag. *Lille.*

**H11. Sentinel-datoen 2099 lækker som reel `dueAt`** — `reminders.ts:62` + `:31`. "Ingen tid"-sentinelen (`2099-12-31`) mappes aldrig tilbage til `null` → påmindelser uden tid vises med forfaldsdato 31.12, sorteres forkert, og modellen får en fiktiv deadline. Fix: map sentinel → `null` i `rowToReminder`. *Lille.*

**H12. Widget-snapshot: last-writer-wins sletter de andre kilders data** — `src/lib/widget-bridge.ts:91-104` + `briefs.ts:110-114` + `hooks.ts:1100`. Hver skriver rebuilder HELE snapshottet fra partielle kilder (brief-skriveren nulstiller events og omvendt); `useDaySchedule(i morgen)` blanker widget'ens i-dag-events; debounce DROPPER skrivning 2 i stedet for at udskyde. Fix: merge ind i sidste kendte snapshot; kun events-skrivning når intervallet dækker i dag; trailing debounce. *Mellem.*

**H13. iCloud recurrence-guard tæller forekomster FØR vinduet** — `icloud-calendar.ts:710-722`. Iteratoren starter ved seriens DTSTART og hver skippet forekomst tæller mod `guard < 1000` → dagligt event ældre end ~2,7 år forsvinder helt fra visningen. Fix: `event.iterator(ICAL.Time.fromJSDate(rangeStart))` og/eller tæl kun forekomster i vinduet. *Lille.*

**H14. Ingen pagination — kalender-events cappet til 50** — `google-calendar.ts:80-81` (`maxResults: '50'`, `nextPageToken` ignoreres), `microsoft-graph.ts:534` (`$top=50`, `@odata.nextLink` ignoreres). Uge-/månedsvisninger og chattens "denne uge" mangler events sidst i intervallet uden fejl — Graph sorterer på starttid, så netop de seneste dage mangler. Fix: følg page-tokens med totalloft. *Lille–Mellem.*

**H15. Gentagne forekomster der overlapper vinduets start droppes (iCloud)** — `icloud-calendar.ts:718` vs. `inRange` :688. Filtrerer kun på forekomst-START hvor enkeltevents bruger `end >= rangeStart` → igangværende gentaget møde vises ikke "i dag". Fix: anvend samme `inRange(start, end)`-tjek via `getOccurrenceDetails`. *Lille.*

**H16. Chat-svar markeres aldrig "besvaret" for Gmail/Outlook** — `hooks.ts:4598, 4701, 4760` vs. `:1258/:1275`. Chat bruger unified-ID'er (`google:abc`), indbakken rå id'er → `replied.has(m.id)` matcher aldrig; besvarede mails bliver i "Venter på dig". Fix: normalisér id (strip prefix for google/microsoft) i `runMailComposeTool`/`sendChatDraft`. *Lille.*

**H17. Ingen delt cache: hver hook-instans laver fuld provider-fetch** — `hooks.ts:1200-1360, 910-1128`. `useMailItems` mountes af 5+ konsumenter — hver henter 50 mails × 3 providere; iCloud-SWR-callback bumper global tick pr. instans → refetch-storme, ratelimit-pres, batteri. Fix: modul-singleton med subscribe (mønstret findes i `dismissedMailIds`) eller React Query. *Stor.*

**H18. `useDaySchedule`: to events i samme time — sidste vinder** — `hooks.ts:2824-2836`. Ét event pr. time-slot; møder 10:00 og 10:30 → kun ét vises. Reelt datatab i dagsvisningen. Fix: liste pr. slot + stakning i UI. *Mellem.*

**H19. Kalenderliste til chatmodellen sorteres alfabetisk, ikke kronologisk** — `chat-tools.ts:158-159`. `lines.sort()` på strenge der starter med `[provider:id]` → modellen svarer forkert på "hvad er min næste aftale?". Fix: sortér objekter på `start.getTime()` før formatering. *Lille.*

**H20. iCloud-skrivninger i chatten ignorerer integrations-togglen** — `chat-tools.ts:867-868, 911, 962`. Create/update/delete tjekker kun `ctx.userId`, ikke `ctx.icloud` (læse-stierne gør). Bruger med iCloud slået fra kan stadig få ændret sin iCloud-kalender via chat. Fix: tilføj toggle-tjek i de tre grene. *Lille.*

**H21. Konfliktbesked og kvittering sender UTC-tider til modellen** — `chat-tools.ts:771-773, 1046`. `.toISOString()` hvor filens egen kommentar (:224-229) dokumenterer præcis denne bugklasse — 2 timer forkert i dansk sommertid. Fix: `formatLocalDateTime()` begge steder. *Lille.*

**H22. Signatur-sanitizer: uafsluttet tag udskrives råt** — `mail-signature/sanitize.ts:108-113, 217-220`. Input der slutter med tag uden `>` (fx `<img src=x onerror=…`) tokeniseres som tekst og udskrives ordret — HTML-parsere læser det som reelt tag; sanitizeren er eneste barriere før udgående mail. Fix: HTML-escape `<` i tekst-tokens. *Lille.*

**H23. Signatur-importens prompt modsiger sanitizer-allowlisten** — `import-from-screenshot.ts:58` vs `sanitize.ts:36-37`. Prompten instruerer `background`/`width`/`height`, som allowlisten fjerner → kontaktikoner ender usynlige. Fix: udvid allowlist eller ret template + enforce-pass. *Mellem.*

### Screens

**H24. TodayScreen viser frosset ur og forældet "i dag"-data** — `TodayScreen.tsx:122, 623`. `useMemo(() => new Date(), [])` bruges som ur, hilsen, "nu"-markør og forfalden-filter — og tabben re-mountes aldrig. Uret står bogstaveligt stille. Fix: fælles `useNow(60_000)`-hook (CalendarScreen :171-182 har mønstret). Samme mønster i Memory/Notifications/Chat (M-screens). *Lille.*

**H25. Pull-to-refresh-spinneren i Inbox lukker med det samme** — `InboxScreen.tsx:162-169`. Release-effekten læser `waitingLoading === false` fra samme commit før loading flipper → spinneren "holder" ikke som kommentaren lover. Fix: latch på loading-overgangen (track forrige værdi) eller lad `refreshMailNow` returnere et promise. *Lille.*

**H26. CalendarScreen renderer 53 ugesider (inkl. 53 native GlassViews) eagert** — `CalendarScreen.tsx:91-93, 395-430`. 53 blur-views + 371 Pressables permanent; hele `weeks`-arrayet genberegnes ved hvert dagsvalg (deps på `selectedDate`). Fix: pagineret FlatList / render ±1 uge; flyt `isSelected` ud af memo-deps. *Mellem.*

**H27. ChatScreen re-renderer og re-parser alle bobler ved hvert tastetryk** — `ChatScreen.tsx:109, 377-379`. `input`-state i skærm-roden + ikke-memoiseret `Bubble` med friske inline-closures → op til 50 bobler inkl. markdown-parsing og blur pr. tast. Fix: flyt composer-state ned i `DockRow`, `React.memo` på `Bubble` med stabile callbacks, evt. inverted FlatList. *Mellem.*

**H28. Tilbage-knappen i InboxDetail kasserer uafsendt svar uden bekræftelse** — `InboxDetailScreen.tsx:140-157` vs. `:182-196`. Arkivér nagger korrekt; tilbage gør ikke. Manuelt skrevet svar tabes ved ét fejltryk. Fix: samme confirm ved ikke-tomt draft, eller persistér udkast pr. mail-id. *Lille.*

### Komponenter

**H29. TextInput i ProposalDetailModal dækkes af tastaturet** — `ProposalDetailModal.tsx:234-242`. Bund-forankret sheet uden KeyboardAvoidingView → "Redigér svar"-feltet og Send-knappen ligger bag tastaturet. Kerneflow reelt ubrugeligt på små skærme. Fix: `KeyboardAvoidingView behavior="padding"`. *Lille.*

**H30. Tab-barens faner er usynlige for VoiceOver** — `ClassicTabBar.tsx:66`, `LiquidTabBar.tsx:158`. Ingen `accessibilityRole="tab"`, `accessibilityState={{ selected }}` eller label (inkl. badge-count). Appens primære navigation uden semantik. Fix: tilføj rolle/state/label på begge. *Lille.*

**H31. Swipe-gestus med `locationX` vælger forkert fane** — `LiquidTabBar.tsx:108-123`, `LiquidTabSwitcher.tsx:80-90`. `locationX` er relativ til det ramte child-view, ikke rækken → pillen hopper til forkert fane med fejl-haptik. Fix: `gestureState.moveX` minus rækkens position (`measureInWindow`). *Mellem.*

**H32. To temasystemer blandet i samme komponenter — ulæselig i dark-direction** — mindst 8 filer (fx `AgentActionCard.tsx:4-5`, `ProposalDetailModal.tsx:26-28`): baggrund fra retningsafhængig `useTheme`, tekst fra statisk legacy `colors.ink`. `ThemeProvider` læser stadig persisteret direction fra AsyncStorage, så en gemt 'E' aktiverer dark → sort-på-mørkt. Fix: ét tokensystem pr. komponent; kortsigtet lås direction til G. *Stor (følger H41).*

### Papir-redesign

**H33. Race conditions i optageflowet** — `PapirRecord.tsx:31-50, 62-70`. `cancelled` tjekkes ikke efter `prepareToRecordAsync()`; pause/stop kan trykkes før `record()` er kaldt (illegal state → crash på Android); `startedRef` skrives men læses aldrig. Fix: guards + try/catch. *Lille.*

**H34. Optagelse stoppes ikke ved Annullér/unmount; audio-mode nulstilles aldrig** — `PapirRecord.tsx:40-48, 146` + `PapirShell.tsx:90`. Ingen `recorder.stop()` i close-stien; `allowsRecording: true` rulles aldrig tilbage → iOS audio-session forbliver i optage-mode, temp-filer efterlades. Fix: stop+slet i onClose/unmount; `setAudioModeAsync({ allowsRecording: false })` efter stop. *Lille.*

**H35. Fejlet transskription viser opdigtet DEMO-indhold som brugerens optagelse** — `PapirTranscription.tsx:17-25, 103-107`. `catch` → `setData(DEMO)`; `TranscribeError`s færdige danske fejlbeskeder smides væk. "Gem note" ville gemme fremmed indhold. Fix: error-state + "Prøv igen"; DEMO kun ved `uri === null`. *Lille–Mellem.*

**H36. Ingen safe-area-håndtering i Papir-UI'et** — 0 hits på `useSafeAreaInsets`/`SafeAreaView` i `src/screens/papir` + `src/design`; alle top/bund-afstande er magiske tal (`PapirBottomNav.tsx:59-62`, `PushHeader.tsx:17` m.fl.). Kolliderer med Dynamic Island; brækker på Android/landscape. Fix: `useSafeAreaInsets()` i shell, header og bottom nav. *Mellem.*

**H37. Push-"stakken" har dybde 1** — `PapirShell.tsx:37,42` + `PapirBriefing.tsx:71`. Briefing→Inbox ERSTATTER briefing (uden animation, samme key); back lander på Hjem. Fix: `PushScreen[]`-stak + `key={screen}` på Animated.View. *Lille–Mellem.*

**H38. Døde tryk-affordances på Hjem m.fl.** — `PapirHome.tsx:191, 198-207, 238, 254`, `PapirChat.tsx:76-91`, `PapirProfile.tsx:127`. `ScaleButton` giver scale+haptik uden `onPress` — hero-kortet (skærmens største CTA), "Noter", "Alle", "Se plan", "Tilføj", Premium-upsell gør intet. Fix: wire de oplagte; skip haptik/scale når `onPress` er undefined. *Lille.*

### Tooling & arkitektur

**H39. Ingen ESLint, ingen Prettier, intet lint-script** — `package.json:5-12`; ingen config i repoet. Billigste sikkerhedsnet mod ubrugte imports, exhaustive-deps-fejl (kodebasen er hook-tung: `hooks.ts` er 5.956 linjer) mangler helt. Fix: `npx expo lint` + `"lint"`-script + CI. *Mellem.*

**H40. Ingen CI overhovedet** — ingen `.github/workflows/`. `typecheck` og `test` (42 testfiler) kører aldrig automatisk — sådan har K1/K2/K3 kunnet ligge committet. Fix: minimal GitHub Actions: `npm ci && npm run typecheck && npm test` + `ZOLVA_REQUIRE_PROD_CONFIG=1 npx expo config` (guarden findes allerede i `app.config.js`). *Lille.*

**H41. Tre parallelle theme-/token-systemer** — `src/theme.ts` (~28 filer), `src/design/theme.ts` + ThemeProvider (~40 filer, directions A–H), `src/design/papir/tokens.ts` (16 filer). Navnekolliderende `spacing`/`shadows`/paletter; to inkompatible `Easing`-typer; skærme blander systemer. Side-by-side er bevidst, men uden exit-plan. Fix: `@deprecated`-markering af legacy-exports, slet direction-kataloget (kun G er aktiv), slet `src/theme.ts`-imports pr. migreret skærm. *Stor (følger Papir-migrationen).*

---

## 🟡 Mellem-fund

### Auth & app-kerne
- **M1.** `unregisterPushToken` sletter ALLE brugerens push-tokens når enhedens token ikke kan hentes — `src/lib/push.ts:81-83`. Log ud på én telefon kan slukke push på andre enheder. Fix: slet kun ved kendt token / persistér sidst registrerede token lokalt. *Lille.*
- **M2.** `useIcloudConnected` opdager aldrig ændringer; `subscribeToIcloudCreds`-bussen har nul abonnenter (død event-bus) — `hooks.ts:654-665`, `icloud-credentials.ts:31-39`. `icloudRefreshVersion`-hacket i App.tsx er symptomet. Fix: abonnér i hooken; fjern plumbing. *Lille.*
- **M3.** SecureStore-migrationen sætter færdig-flag selv når enkelte kopier fejler — `auth.ts:169-183`. Fejlet session-kopi → permanent logget ud. Fix: sæt kun flag når alle nøgler lykkedes. *Lille.*
- **M4.** Supabase-session-blob i expo-secure-store overskrider 2048-byte-anbefalingen — `secure-storage.ts:51-55`. Fix: nøgle-i-keychain + AES-krypteret blob i AsyncStorage (Supabases anbefalede RN-mønster). *Mellem.*

### Edge functions — integrationer
- **M5.** imap-proxy kan bruges som credential-test-orakel mod Apple (validate uden binding-tjek; clear-binding uden rate limit/audit) — `imap-proxy/index.ts:430-476, 735-750, 1429-1446`. Fix: stram binding, fælles bucket for clear+validate, audit-log. *Mellem.*
- **M6.** poll-mail: rå UUID-interpolation i PostgREST `or`-filter + URL-længde-risiko — `poll-mail/index.ts:78-91`. Fix: to queries med `.in()` og flet i JS. *Lille.*
- **M7.** trust-offer-decide autentificerer via service-role-klient med bruger-JWT i header — `trust-offer-decide/index.ts:14-24`. Fungerer, men én fremtidig query uden user-filter = cross-tenant læk. Fix: husets standard (anon-klient til auth + separat service-klient). *Lille.*
- **M8.** RevenueCat-webhook: intet `environment`-filter (sandbox-events!) og ingen sekundær verifikation mod RC's API — `revenuecat-webhook/handler.ts:31-68`. Hele betalingsintegriteten hviler på ét delt secret. Fix: filtrér `PRODUCTION`; overvej bekræftende opslag. *Mellem.*
- **M9.** drive-picker: offentlig HTML med API-key/OAuth-token-injektion uden CSP/X-Frame-Options — `drive-picker/index.ts:34-134`. Fix: stram CSP + verificér referrer-restriktion på nøglen. *Lille.*

### Edge functions — AI/agent
- **M10.** Prompt-injektion: `subject`/`from` ufenced i triage-prompten (+ commitment-scan) — `_shared/agent/prompt.ts:446, 296-299`. Fix: samme defang som snippets. *Lille.*
- **M11.** Prompt-injektion via kalenderinvitationer i reflect (title/location/attendees/description ufenced; katalog omfatter mail-search + push) — `prompt.ts:328-333`. Fix: fence felterne; overvej at droppe description. *Lille.*
- **M12.** Ingen timeout på LLM-/provider-kald (kun guardrail-klassifikatoren har) — `claude.ts:52`, `chat-run:252`, `claude-proxy:199`, `transcribe-proxy:108`, `daily-brief:429`, alle tools. Fix: fælles `AbortSignal.timeout`-wrapper. *Mellem.*
- **M13.** `agent-undo`: rækken markeres reverted FØR provider-kaldet — fejl kan ikke prøves igen — `agent-undo/index.ts:114-140`. Fix: compensating update eller `revert_status`-kolonne. *Mellem.*
- **M14.** Flåde-sweeps (commitments/reflect/followups/brief) kører sekventielt over ALLE brugere i én request uden fremdriftsmarkering — brugere efter wall-clock-cap springes stille over, hver gang. Fix: chunking/cursor eller bounded parallelisme + deadline. *Mellem–Stor.*
- **M15.** Agent-budget er check-then-act — parallelle triggere kan overskride dagsbudgettet — `runner.ts:251-254` m.fl. Fix: atomic check-and-increment (mønstret findes i `check_and_incr_claude_usage`). *Mellem.*
- **M16.** `agent_claim_events` har intet kind-filter — tick kan æde reflect/followup-events (spildte runs; tabte nudges ved crash) — `20260511180000:189-220`. Fix: kind-parameter i claim-RPC. *Mellem.*

### Database
- **M17.** `claude_usage_buckets.user_id` mangler FK/cascade — `20260421300000:12-21`. GDPR-garanti hviler alene på eksplicit delete i delete-account. Fix: tilføj FK. *Lille.*
- **M18.** `purge_tenant_data` afhænger af ~10 tabeller der ikke findes i repo-migrationer — skema-drift kan vælte hele GDPR-tenant-sletningen i én transaktion — `20260427130200:44-66`. Fix: commit migrationerne eller `to_regclass`-defensiv sletning. Bemærk også: `purge_tenant_data` sletter ikke `consent_events`. *Mellem.*
- **M19.** Redundant UTC-baseret unik-index på `briefs` efterladt efter Copenhagen-fixet — `20260421000000:21-22` vs `20260509100000:47-48`. Fix: drop den gamle. *Lille.*
- **M20.** Flere SECURITY DEFINER-funktioner har `search_path = public` uden `pg_temp`; trigger-funktioner og pgcrypto-wrappere har intet search_path — `20260526120000:39`, `20260607150000:23`, `20260429140100:8-26` m.fl. Fix: ensret til `public, pg_temp`. *Lille.*
- **M21. VERIFICÉR I PROD:** `agent_claim_events` havde en 42702-bug (ambiguøs `id`) som kun er rettet i `dashboard-only/2026-05-13-...sql` — migrationsversionen indeholder stadig fejlen. Hvis dashboard-fixet ikke er kørt i prod, har agent-tick aldrig claimet events. *Lille (tjek).*

### Klient-datalag
- **M22.** `useTodayBrief` bruger UTC-dato som "i dag" — brief genereret 00:30 lokal vises ikke — `briefs.ts:94-99`. *Lille.*
- **M23.** `markRead` i briefs: update-fejl tjekkes aldrig (catch er død kode); optimistisk state rulles ikke tilbage — `briefs.ts:131-138`. *Lille.*
- **M24.** Realtime-kanalnavne uden instans-suffix i `agent-feed.ts:61`/`agent-commitments.ts:82` (søsterfilerne fik fixet) — remount kan dræbe subscriptionen. Fix: `useId()`-suffix. *Lille.*
- **M25.** `decideTrustOffer`/`revertTrustOffer` melder `ok: true` ved 0 opdaterede rækker — `trust-offers.ts:72-95`. Fix: `.select('id')` + tjek length. *Lille.*
- **M26.** Kontoskifte-races: `notification-settings.ts:77-99` (A's indstillinger kan lande hos B), `mail-signature/storage.ts:100-104`, `hooks.ts:1595-1622` (draft-cache), `:1881-1907` (verdict-cache), `sent-mails.ts:41-62` (L). Guard-mønstret findes i `notification-feed.ts:79`. Fix: "tjek uid efter await" alle steder. *Lille pr. sted.*
- **M27.** Integrations-flags er IKKE bruger-scopede — `integration-flags.ts:22`. Bruger A's fravalg følger devicet til bruger B. Fix: uid-scope + migrering. *Mellem.*
- **M28.** `requestForcedBriefOnce`: engangs-flag sættes FØR kaldet og invoke-fejl tjekkes aldrig — "first win"-briefen kan gå permanent tabt — `forced-brief.ts:25-36`. *Lille.*
- **M29.** Edge-kald bryder `{ok,error}`-kontrakten ved netværksfejl + 3× duplikeret boilerplate + privat `supabaseUrl`-cast — `agent-feed.ts:82-95`, `agent-proposals.ts:72-103`. Fix: fælles `callEdgeFunction`-helper (løser også K5 ved roden). *Lille.*
- **M30.** Cirkulære imports: 5 lib-moduler ↔ `hooks.ts` via `getPrivacyFlag` — flyt til eget lille modul. *Mellem.*
- **M31.** `getFactsSignature` henter ALLE fact-rækker pr. Claude-kald — `profile-store.ts:385-406`. Fix: limit-1-queries eller count. *Lille.*
- **M32.** `persistDismissed` kan overskrive disken med halvhydreret sæt (arkiverede mails genopstår) — `hooks.ts:772-829`. Fix: gate persist på hydrering-færdig. *Lille.*
- **M33.** `persistObservations` bruger UTC-dato som `source_date` (forkert dedup 00:00–02:00) — `hooks.ts:500`. *Lille.*
- **M34.** Stale closures på `user` i `useSendReply`/`useGenerateDraftAction` (deps omgået med `void user`) — `hooks.ts:2589-2697`. iCloud-svar kan fejle med "Ikke logget ind." trods login. *Lille.*
- **M35.** `urgencyTier` kører ~40 regexes i sort-komparator ved hvert render (tusindvis af kørsler pr. re-render ved 150 mails) — `hooks.ts:2299-2344`. Fix: precompute i `useMemo`. *Lille.*
- **M36.** `toClaudeMessages` kan producere historik der starter med assistant-rolle → Anthropic 400 — `hooks.ts:3969-4009`. *Lille.*
- **M37.** `RIBBON_PALETTE` overskriver ubetinget alle provider-farver (kommentaren siger kun untagged) — `hooks.ts:1081-1083`. Fix: `e.color ?? palette[...]`. *Lille.*
- **M38.** Klient-Gmail `buildMime`: To/Cc/In-Reply-To/References interpoleres råt (kun Subject beskyttes) — `src/lib/gmail.ts:612-617`. Samme klasse som H4. *Lille.*
- **M39.** `completeWithTool` dropper `signal`; `completeRaw` har ingen default-timeout — `claude.ts:289-308, 160-169`. *Lille.*
- **M40.** Provider-fan-out i chat-tools + pre-alerts kører serielt (sum af alle latenser; iCloud har 25-40 s timeout) — `chat-tools.ts:129-156` m.fl. Fix: `Promise.allSettled`. *Mellem.*
- **M41.** iCloud-payload castes uvalideret (`payload as T`) → TypeError uden for `IcloudResult`-kontrakten ved deploy-skew — `icloud-mail.ts:706-709`. *Lille.*
- **M42.** 4× duplikeret billede-pick/resize/base64-pipeline i mail-signature (2 lækker temp-fil) — `image.ts`, `import-from-screenshot.ts:473-513` m.fl. *Mellem.*
- **M43.** 4× duplikeret realtime-hook-mønster med uens fixes; fælles svagheder: DELETE-events ignoreres, fetch-fejl blanker data, gap mellem fetch og kanal-join — `agent-feed/proposals/trust-offers/commitments`. Fix: generisk `useRealtimeRows<T>`. *Mellem.*
- **M44.** Uvaliderede `as`-casts på server-/diskdata (rowTo*-funktioner, chat-historik) — kontrast: LLM-output valideres forbilledligt. Fix: små row-guards. *Mellem.*
- **M45.** iCloud `saveCredential`-rollback sletter en eksisterende fungerende credential — `icloud-credentials.ts:209-231`. *Lille.*
- **M46.** Race: in-flight kald med gammel credential kan markere en nyligt gemt credential invalid — `icloud-credentials.ts:245-257`. Fix: match på email/fingerprint. *Lille.*
- **M47.** Intl-VTIMEZONE-fallback fryser UTC-offset på registreringstidspunktet (DST-forkert, global registrering) — `icloud-calendar.ts:784-813`. *Mellem.*
- **M48.** Graph heldagsevents parses som UTC-midnat → forkert dag vest for UTC (læse-stien; skrive-stien blev fixet) — `microsoft-graph.ts:554-555`. *Lille.*
- **M49.** OneDrive-søgning knækker på apostrof (`O'Brien` → OData 400) — `onedrive.ts:45-58`. Fix: dobl apostroffer. *Lille.*
- **M50.** google-drive `listFolderContents`: child-listning mangler 401/403→`ProviderAuthError` (ingen refresh+retry) — `google-drive.ts:228-235`. *Lille.*
- **M51.** Kategori-fetch kan vælte hele Graph-kalenderhentningen (rejection i `Promise.all`; potentiel unhandled rejection) — `microsoft-graph.ts:528-537`. Fix: `.catch(() => null)`. *Lille.*
- **M52.** `findEventByUid` henter 7 måneders events fra samtlige kalendere for at finde én UID — `icloud-calendar.ts:1040-1051`. Fix: CalDAV calendar-query på UID. *Mellem.*

### Screens
- **M53.** Frosne `new Date()`-timestamps også i MemoryScreen (:73 — forfalden-markering virker aldrig), NotificationsScreen (:32) og ChatScreen (:60-62). Løses sammen med H24 via fælles `useNow`. *Lille.*
- **M54.** MemoryScreen: privacy-kritiske sletninger uden fejlhåndtering (unhandled rejections; wipe-kæden kan knække halvt) — `MemoryScreen.tsx:148-151, 164-185`. *Lille.*
- **M55.** InboxDetail: udkast-genereringens `error`-state ignoreres — knappen "gør ingenting" ved fejl — `InboxDetailScreen.tsx:43, 54-62`. *Lille.*
- **M56.** Inbox: hele mail-listen i én ScrollView uden virtualisering (100+ blur-kort) — `InboxScreen.tsx:175, 415-482`. Fix: SectionList/FlashList eller caps. *Mellem.*
- **M57.** Inbox: `Wrapper`-komponenttype oprettes inline pr. render → remount af sektions-headers — `InboxScreen.tsx:329-339`. *Lille.*
- **M58.** Chat: tvungen scroll-til-bund ved enhver indholdsændring hiver læsende bruger ned — `ChatScreen.tsx:193-205`. Fix: kun auto-scroll nær bunden. *Lille.*
- **M59.** Chat: ingen send-knap — kun return-tasten som også lukker keyboardet; ingen linjeskift muligt — `ChatScreen.tsx:754-783`. *Lille.*
- **M60.** Falske tomme tilstande under fetch/fejl i MemoryScreen og FactReview ("Vi fandt ikke noget" ved netværksfejl) — `MemoryScreen.tsx:102-107`, `OnboardingFactReviewScreen.tsx:128-130`. Fix: loading + fejl-state med retry. *Mellem.*
- **M61.** IcloudSetup: email/password trimmes ikke før validering (klassisk paste-whitespace-fejl i højfrikticions-flow) — `IcloudSetupScreen.tsx:156-163`. *Lille.*
- **M62.** Settings: signaturen (potentielt med base64-billede) persisteres til AsyncStorage ved hvert tastetryk — `SettingsScreen.tsx:989-1000`. Fix: debounce/persist på blur (commit() findes allerede). *Lille.*
- **M63.** "Copy JWT (dev)"-knap er ikke bag `__DEV__` — kun gated på den udtrådte medstifters e-mail — `SettingsScreen.tsx:2250-2278`. Fix: `__DEV__ &&` + ryd hardcodet personmail. *Lille.*
- **M64.** Onboarding: auto-advance-timeout uden cleanup — "tilbage" efterfulgt af spøgelses-fremryk — `OnboardingFlowScreen.tsx:681-688`. *Lille.*
- **M65.** Onboarding: OAuth-fejl i kilde-toggles sluges stumt — inkl. admin-consent-casen som Settings håndterer — `OnboardingFlowScreen.tsx:1173-1183`. Fix: genbrug Settings-håndteringen. *Mellem.*
- **M66.** A11y: mail-rækker, dagsceller, valg-kort, SentRow m.fl. mangler roller/labels/checked-state — `InboxScreen.tsx:274`, `CalendarScreen.tsx:699-712`, `OnboardingFlowScreen.tsx:479, 585, 759` m.fl. *Mellem.*
- **M67.** SentMail: `reload` uden unmount-guard — kort datableed ved kontoskifte — `SentMailScreen.tsx:33-38`. *Lille.*

### Komponenter
- **M68.** `dismissProposedAction`-resultat ignoreres — "Spring over" fejler stille (og orphan-draft ryddes ikke) — `ProposedActionCard.tsx:54-59`. *Lille.*
- **M69.** Stone-mascottens timere/RAF-tweens kører evigt på alle permanente TabPane-faner (usynlige inkl.) — `Stone.tsx:44-88` + `TabPane.tsx:20-42`. Fix: pausér ved usynlighed eller Reanimated shared values. *Mellem.*
- **M70.** `Section`-komponent defineret inde i BriefModals render → remount af alle sektioner pr. render — `BriefModal.tsx:71-128`. *Lille.*
- **M71.** accessibilityLabels misbrugt som test-id'er — VoiceOver læser "undo", "mail.archive-auto", UUID'er op — `AgentActionCard.tsx:90,105`, `ProposedActionCard.tsx:69-81` m.fl. Fix: `testID` + danske labels. *Lille.*
- **M72.** Touch targets 26–32 pt uden hitSlop på policy-pills, revert-knapper og primærknapper — `AgentActionPolicySection.tsx:118` m.fl. *Lille.*
- **M73.** SwipeableMailRow: arkivér/slet utilgængelige for VoiceOver (ingen accessibilityActions); `Dimensions.get` ved module load — `SwipeableMailRow.tsx:41, 61-142`. *Mellem.*
- **M74.** Tre næsten identiske bottom-sheet-implementeringer (~450 dublerede linjer) — `ProposalDetailModal`/`AgentActionDetailModal`/`OpenLoopsModal`. Fix: fælles `BottomSheetOverlay`. *Mellem.*
- **M75.** Dubleret datoformatering og kort-styles på tværs (DANISH_MONTHS ×2, kort-styles ×3, fuldskærms-header ×5) — fix: delte utils/primitives. *Mellem.*
- **M76.** Død kode: `WhatsNewModal` (med forældet indhold), `LiquidToggle`, `Pill` importeres ingen steder — slet eller genaktivér bevidst. *Lille.*
- **M77.** TrustPromotions "Fjern": intet pending/fejl-feedback/dobbelt-tap-værn på et tillidsfølsomt toggle — `TrustPromotionsSection.tsx:12-34`. *Lille.*
- **M78.** OfflineBanner/StatusBarScrim hardcoder status bar-højde (48/54 pt) — forkert på Dynamic Island-enheder — `OfflineBanner.tsx:32`, `StatusBarScrim.tsx:6`. *Lille.*
- **M79.** AgentActionPolicySection: fetch-fejl ignoreres (viser defaults som var de brugerens politik) + setState efter unmount — `AgentActionPolicySection.tsx:40-54`. *Lille.*

### Papir
- **M80.** Dobbelttryk på stop kan fyre `onStop` to gange — `PapirRecord.tsx:72-81`. Fix: `stoppingRef`. *Lille.*
- **M81.** Uhåndteret promise-rejection i PapirRecords mount-effekt — "Lytter…" uden optagelse — `PapirRecord.tsx:33-45`. *Lille.*
- **M82.** Ingen timeout på transskriberings-upload/ekstraktion (kombineret med K7 = evig hængning) — `transcribe.ts:37-47`, `PapirTranscription.tsx:92-115`. *Lille–Mellem.*
- **M83.** Hilsen uden navn renderer "Godmorgen,." — `PapirHome.tsx:160`. *Lille.*
- **M84.** Hardcodet dato-/indholdsdata der ser dynamisk ud (briefing-eyebrow, WEEK-strip, "9 nye mails", DEMO_EVENTS, "Online") — flere filer. *Mellem.*
- **M85.** Lokal state og scrollposition mistes ved tab-/segment-skift; `done` bor i to usynkroniserede TaskRow-kopier — `PapirShell.tsx:47-55` m.fl. *Mellem.*
- **M86.** DayTimeline håndterer ikke virkelige data: events uden for 7–22 (negativ top/overflow), overlap tegnes oveni, `key={i}` — `DayTimeline.tsx:10-11, 91-101`. *Mellem.*
- **M87.** Kontrast under WCAG: `ink4` ≈ 2,0:1 (inaktive nav-labels 10px), `ink3` ≈ 3,0:1 for 11-12px tekst — `tokens.ts:21-22`. *Lille–Mellem.*
- **M88.** A11y-huller i skærm-lokale komponenter (TaskRow uden checkbox-rolle/state, SegmentedControl uden selected, IconButton 38pt/Chip 32pt uden hitSlop) — design-systemets primitives er ellers pænt dækket. *Mellem.*
- **M89.** Android hardware-back håndteres ikke i shellens hjemmelavede navigation (minimerer appen midt i optagelse) — ingen `BackHandler` i `src/screens/papir/`. *Lille.*

### Config/tooling
- **M90.** Testdækning: 0 tests af `hooks.ts` (5.956 linjer inkl. hele chat-maskineriet — K3 bor præcis i en utestet fejlsti); 0 tests af Papir; kun 2 skærm- og 1 komponenttest. Prioritér chat-fejlstierne. *Stor.*
- **M91.** Ingen crash-rapportering trods tidligere prod-OTA-crash; døde `@sentry/react-native`/`native-base`-referencer i jest-config — `package.json:79`. Fix: Sentry med expo-plugin. *Mellem.*
- **M92.** `AskZolvaIntentTests.swift` kompileres/køres aldrig (ikke i pluginets SOURCES; intet test-target) — `plugins/voice-intents/`. *Lille.*
- **M93.** `JetBrainsMono_500Medium` bruges i OnboardingFlow men indlæses aldrig — stille systemfont-fallback — `OnboardingFlowScreen.tsx:59` vs `App.tsx:126-127`. *Lille.*

---

## 🟢 Lave fund

### Auth & app-kerne
- **L1.** App.tsx-effekter afhænger af hele `user`-objektet → re-kører ved hvert token-refresh (~hver time) — `App.tsx:285, 374`. Fix: afledte primitiva i deps.
- **L2.** Font-load-fejl ignoreres → potentiel evig orange splash — `App.tsx:109-129, 549-553`. Fix: `loaded || error` passerer gaten.
- **L3.** `pendingVerifiers`-entry lækker hvis browser-åbning kaster — `microsoft-oauth.ts:141-151`.
- **L4.** Produktions-logging af fejl-bodies uden `__DEV__`-gate — `DeleteAccountScreen.tsx:477`, `auth.ts:364-529` spredte steder.
- **L5.** Død kode: `scheduleReminderNotification`, `reminderIdentifier`, `nudgeIdentifier`, `persistOnboardingState` har ingen callers — `notifications.ts:237-268`, `onboarding-persist.ts:165-173`.

### Edge functions
- **L6.** delete-account: iCloud app-password kan ikke revokeres programmatisk — informér brugeren om manuel fjernelse; slet creds-tabellerne eksplicit for retry-konsistens — `delete-account/index.ts:144-150`.
- **L7.** reminders-fire kan double-pushe ved overlappende ticks (ingen atomisk claim før push) — `reminders-fire/index.ts:44-94`. Fix: `UPDATE … RETURNING` før push.
- **L8.** microsoft-oauth-exchange: `redirect_uri` valideres ikke mod allowliste (Microsoft/PKCE afbøder) — `microsoft-oauth-exchange/index.ts:64-72`.
- **L9.** JWKS-JWT-verifikation duplikeret ×3; kun `widget-action/jwt.ts` validerer issuer+audience — `icloud-creds-link:18-61`, `icloud-creds-revoke:19-51`. Fix: `_shared/jwt.ts`.
- **L10.** onboarding-backfill: 150s-cap efterlader jobs i 'running' (kendt limitation; 5-min stale-clear afbøder) — tilføj reaper.
- **L11.** imap-proxy: global `unhandledrejection`-swallow fanger ALT i isolatet — indsnævr til kendte imapflow-mønstre — `imap-proxy/index.ts:49-58`.
- **L12.** `ilike` med uescaped `%`/`_` i trust-optælling (adresser med underscore inflaterer count) — `agent-approve/index.ts:216-222`.
- **L13.** Chat-kvote/rate-limit forbruges før validering og refunderes ikke ved upstream-5xx — `chat-run/index.ts:111-171, 268-276`.
- **L14.** agent-approve: crash mellem claim og udfald strander rækken i `approved` (hverken claimbar eller fejlet) — tilføj sweep.
- **L15.** agent-tick bruger-sti: intet `agent_enabled`-tjek (kører mod brugerens eksplicitte fravalg) og ingen rate limit — `agent-tick/index.ts:45-66`.
- **L16.** daily-brief composer: from/subject ufenced (kan diktere brief-punkter i Zolvas stemme) — `daily-brief/compose.ts:86`.
- **L17.** Duplikeret infrastruktur: `authenticatedUserId` ×4, `selectAgentEnabledUsers` ×3, `copenhagenDay` ×4, `sendChatPush` ×2, 429-blok ×4 — K2 er præcis denne fejlklasse; saml i `_shared/`.
- **L18.** Død kode i action-kataloget: action-typer uden dispatch (`mail.send_new`, `cal.rsvp` …), inert declined-filter (reader hardcoder `response_status: 'none'`, markeret TODO).
- **L19.** CORS/OPTIONS håndteres ingen steder — korrekt for native-only i dag; kræver fælles helper hvis web kommer til.

### Database
- **L20.** `icloud_proxy_calls` CHECK-constraint på `op` + fail-open rate-limit = ny op glemt i CHECK kører ubegrænset (er sket 2×) — drop CHECK eller fejl-luk på 23514.
- **L21.** `agent_events`/`agent_runs`/`user_agent_budget` har ingen retention-sweep — `agent_runs` vokser med cron × brugere; `v_agent_recent_runs` mangler index på ren `started_at`.
- **L22.** `purge_tenant_data` sletter ikke `consent_events` (delete-account gør) — tilføj for tenant-stien.
- **L23.** Cron-templates antager CEST — 1 times drift over DST-skift (fact-decay "07:00 UTC ~09:00" er 08:00 om vinteren).

### Klient-datalag
- **L24.** `rowToReminder` fabrikerer `doneAt` som `created_at` — `reminders.ts:34`.
- **L25.** `fetchWithTimeout` ignorerer et allerede-aborteret upstream-signal — `network-errors.ts:24`.
- **L26.** `setHidden` i calendar-visibility: read-modify-write-race ved hurtige toggles — `calendar-visibility.ts:76-87`.
- **L27.** `registerPresenceListener`: delt modul-variabel — dobbelt registrering lækker første listener — `presence.ts:32-47`.
- **L28.** Død kode: `usePendingProposalCount`, `initMemoryStore` — ingen callers.
- **L29.** `buildProfilePreamble`s demo-check virker kun via `as never`-cast; typen udelukker feltet der læses — `profile.ts:161-164`.
- **L30.** sent-mails hydrate kan re-populere cache med gammel brugers data efter kontoskifte (memory-retention, ingen kryds-visning) — `sent-mails.ts:41-62`.
- **L31.** `useInboxCounts.loading` kan hænge på `true` ved early-returns — `hooks.ts:1404-1419`.
- **L32.** 3× duplikeret integrations-label-liste; `anyMail`/`anyComposeMail` identiske — `hooks.ts:3550-3573` m.fl.
- **L33.** Fejltekst til modellen udelader "google" som gyldig provider — `hooks.ts:4816`.
- **L34.** Notifikations-hooks re-renderer hvert 30 s uanset ændringer — `hooks.ts:3489-3518`.
- **L35.** `shortDate` i chat-tools viser UTC — `chat-tools.ts:658-660`.
- **L36.** gmail `stripHtml`: entity-dekodning i forkert rækkefølge (dobbelt-dekodning) + `fromCharCode` knækker emoji — `gmail.ts:686-693`. Samme rækkefølge-fejl i `icloud-calendar.ts:642-648` og `microsoft-graph.ts:580-585`.
- **L37.** `extractFirstJsonObject` håndterer ikke top-level arrays — `claude.ts:245-267`.
- **L38.** `saveSignature`-overloads via `any`; `image`-feltet fra disk valideres ikke — `mail-signature/storage.ts:109-113, 54`.
- **L39.** Manglende picker-asset-dimensioner → 400×400-forvrængning — `mail-signature/image.ts:38-41`.
- **L40.** Debouncet profil-extractor DROPPER payload når en kørsel er i gang (facts uddrages aldrig) — `profile-extractor.ts:167-174`.
- **L41.** Demo `timeAgoLabel` viser "0d" for gårsdagens mails — `demo.ts:87-89`.
- **L42.** Kalendernavne/hrefs entity-dekodes ikke ("Børn &amp; Co") — `icloud-calendar.ts:494, 511`.
- **L43.** `escapeIcsText`: CR droppes før newline-escaping — lone-CR klistrer linjer sammen — `icloud-calendar.ts:892-899`.
- **L44.** Duplikeret 404-gren i `caldavFetch`; 412-retry-løftet i kommentar indfries aldrig — `icloud-calendar.ts:568-571, 882`.
- **L45.** `hasOtherAttendees`-semantik inkonsistent Graph vs Google (Graph tæller brugeren selv med — gater pre-meeting-alerts) — `microsoft-graph.ts:558` vs `google-calendar.ts:153-156`.
- **L46.** `getFileContent` (Drive+OneDrive) downloader hele filen før 12k-truncation — OOM-risiko; hent `size` og afvis store filer — `google-drive.ts:310-314`, `onedrive.ts:138-141`.
- **L47.** 3× duplikeret fil-mapping i google-drive; "exact match first"-kommentar holdes ikke — `google-drive.ts:86-255`.

### Screens
- **L48.** TodayScreen: dødt "over-dark"-scroll-tracking kører pr. frame (`darkYRef` sættes aldrig) — `TodayScreen.tsx:384-422`; ryd også `onOverDarkChange`-kæden i App.tsx.
- **L49.** TodayScreen: døde dark-variant-styles (`light` altid true); `accessibilityLabel` brugt som testID ("today-quiet-card" læses op) — `:883-919, 793`.
- **L50.** Inbox: ubrugte imports (`formatClock`/`formatToday`), ubrugt frossen `today`, tom StyleSheet — `InboxScreen.tsx:20, 64, 497`.
- **L51.** Calendar: `coveredHours` wrapper events over midnat tilbage til morgentimerne — `CalendarScreen.tsx:154-166`.
- **L52.** Calendar: inkonsistent Haptics-fejlhåndtering (3 af 4 steder uden `.catch`/platform-gate) — `:208-299`.
- **L53.** Duplikeret kode på tværs af skærme: pull-to-dismiss-PanResponder ×2, dag-gruppering/relativ-tid ×3, to forskellige Stone-imports på tværs af 10+ skærme.
- **L54.** OnboardingBackfill: kommentar siger "Drive isn't backfilled", koden tilføjer Drive-kilder — `OnboardingBackfillScreen.tsx:45-59`.
- **L55.** Skærm-testdækning: eksportér de rene helpers (groupByDay, classifyForBrief, formatDue …) og unit-test dem — det er dér midnats-fejlene bor.

### Komponenter & Papir
- **L56.** Rå/tekniske fejlbeskeder i UI ("http 500", engelske exception-tekster) — `AgentActionCard.tsx:79`, `CalendarPickerSheet.tsx:308` m.fl.
- **L57.** Hardcodede farver udenom begge temaer (~10 filer; `'#FBFBFA'`, `'#A24'` ×4, iOS-systemfarver i SwipeableMailRow) — dokumentér bevidste undtagelser.
- **L58.** DrivePickerModal: alle ikke-http(s)-schemes (inkl. `javascript:`) whitelistes i navigation-gate — `DrivePickerModal.tsx:181`.
- **L59.** Stone: haptik ved tap selv når dekorativ; ingen a11y-markering som dekorativ — `Stone.tsx:90-102`.
- **L60.** Småting: `detailFor(row)` ×2 pr. render; `onEmpty` mangler i deps; `Dimensions.get` i render (MessageActionMenu); gammel Animated-API i Skeleton; `Record<…, ReturnType<typeof require>>` = any.
- **L61.** Papir: waveform re-renderer hele optageskærmen 8-10×/sekund på JS-tråden — flyt til Reanimated — `PapirRecord.tsx:54-60`.
- **L62.** Papir død kode: `startedRef`, ubrugte imports (`Card` bruges ingen steder i kodebasen, `papirSpace`, `papirShadow`), ubrugte tokens (`tabFade`, `navHide`, `gradientTo`), `''`-konvention aldrig sat, ternary med identiske grene.
- **L63.** Papir: hardcodede hex-farver i strid med tokens-filens egen regel (`#FFFFFF` ×8, `#C9C4B6`, ad-hoc radii) — sweep + lint-regel.
- **L64.** ScaleButton fyrer haptik på press-in — haptiske tik ved scroll henover rækker; fyrer også uden onPress — `ScaleButton.tsx:74-81`.
- **L65.** Papir: ustabile/kollisionsudsatte keys (`key={m.from}`, `key={title}`, `key={i}`) — bliver reelle bugs når data wires.
- **L66.** PapirPreviewRoot: font-fejl ignoreret (blank skærm for evigt), module-level `console.log`, hele Papir-træet bundles i prod uanset flag (importeres ubetinget) — `PapirPreviewRoot.tsx:23-28`, `index.ts:6`.
- **L67.** `transcribe.ts`: hardcodet `audio/m4a`-mimetype — udled af filendelse — `transcribe.ts:42`.

### Config
- **L68.** Supabase anon-key duplikeret i `.env` OG hardcodet i `app.json` infoPlist — rotation kræver begge + rebuild; lad `app.config.js` injicere fra env.
- **L69.** Versions-drift: `package.json` 0.1.0 vs `app.json` 1.0.1; `deno.lock` i repo-roden; `--passWithNoTests` kan skjule fejlkonfigureret jest; Android `versionCode: 1` (bevidst, ikke udgivet).

---

## Anbefalet rækkefølge

**Fase 0 — stop blødningen (samme dag):**
1. K2 (`railsOk` i agent-approve — brugere mister mails NU) + prod-verifikation af executed-rækker
2. K3 (én linje, gør typecheck grøn)
3. K1 (gate PAPIR_PREVIEW)
4. H40 (CI: typecheck + test + prod-config-guard — låser fase 0 fast)

**Fase 1 — sikkerhed & datatab (denne uge):**
5. H4 + M38 (mail-header-injektion, begge sider)
6. H5 (SSRF/credential-forwarding i widget-action)
7. K6 + H13 + H15 (iCloud-kalender datatab)
8. H10 + H11 (reminders datatab/sentinel)
9. K5 + M29 (fælles edge-kald-helper → fastlåste knapper)
10. H2 (keychain-oprydning ved kontosletning)
11. M21 (verificér dashboard-fix i prod!)

**Fase 2 — økonomi & kvoter:** H6, H7, M8, H9, H8.

**Fase 3 — UX-bugs i den skibede app:** H24/M53, H25, H28, H29, H3/K4, H16, H18, H19–H21, M60.

**Fase 4 — performance:** H17, H26, H27, M56, M69, M35.

**Fase 5 — Papir-branchen (før videre redesign-arbejde):** K7, K8-matrix, H33–H38, M80–M89.

**Løbende:** H39 (lint), H41/H32 (theme-konsolidering), M74/M43/L17 (dedup), M66/M71/H30 (a11y-sweep), M90 (tests af chat-fejlstier), M91 (Sentry).

---

## Klassifikation: to-app-kontekst (tilføjet 2026-07-05)

Projektet består af **to apps side om side**: den eksisterende produktionsapp (komplet forretningslogik — mail, kalender, chat, memory, agent, onboarding, premium, indstillinger) og **Papir** (nyt UI/IA under opbygning oven på samme backend). Papir skal ikke ende som en separat app; målet er 100 % feature-paritet i det nye UI, før den gamle UI udfases.

Derfor er hvert fund herunder mærket med **App** og **Kategori**, så reelle fejl ikke forveksles med funktionalitet der endnu ikke er flyttet over.

**Kategorier:** `Reel bug` (fungerer forkert i eksisterende implementering) · `Manglende impl.` (findes endnu ikke i Papir) · `Placeholder` (bevidst statisk/mockup) · `Feature-paritet` (findes i gammel app, ikke flyttet over) · `Designvalg` (bevidst anderledes struktur).

**Bærende regel:** Alt i `src/lib`, `src/components`, `src/screens/` (ekskl. `papir/`), `supabase/functions`, `migrations`, config → **Gammel app / Reel bug**. Kun afvigelser herfra begrundes udførligt.

### Hovedkonklusion

- **~150 af fundene rammer den gamle, kørende app** og er reelle bugs uanset Papir. Din advarsel ("antag ikke at manglende Papir-funktion er en bug") gælder dem *ikke* — de skal rettes.
- **K8 er selve din pointe:** samtlige Papir-skærme som statiske mockups er **ikke** en bug, men Feature-paritet/Placeholder. Rapporten er allerede enig og foreslår en paritets-matrix frem for et "fix".
- **Vigtig nuance:** stemmeflowet i Papir (`record → transcribe → actions`) og Home-greeting *er* allerede wiret. Fund i den kode (K7, H33–H35, M80–M83, L61, L67) er derfor **reelle bugs**, ikke placeholders.
- **K1 rammer begge apps** og er kritisk: `PAPIR_PREVIEW=true` kobler hele den rigtige app fra ved merge/OTA. Ikke et designvalg.

### 🔴 Kritiske

| ID | Sev | App | Kategori | Begrundelse |
|---|---|---|---|---|
| K1 | 🔴 | Begge | Reel bug | Committet flag i entrypoint kobler hele produktionsappen fra; en OTA ville skibe Papir-prototypen uden login til alle. Rammer begge apps. |
| K2 | 🔴 | Gammel | Reel bug | Edge function markerer mails som sendt uden at sende. Kernefunktion brudt i drift siden 10. juni. |
| K3 | 🔴 | Gammel | Reel bug | `runTurn` returnerer streng hvor `TurnResult` kræves; rød typecheck i chat-maskineriet. |
| K4 | 🔴 | Gammel | Reel bug | OAuth-reconnect muterer auth-state før browser; annullér logger bruger ud. |
| K5 | 🔴 | Gammel | Reel bug | Agent-knapper (Send/Fortryd/Spring over) fryser i spinner ved netværksfejl. |
| K6 | 🔴 | Gammel | Reel bug | iCloud `updateEvent` sletter RRULE/deltagere/alarmer — stille datatab. |
| K7 | 🔴 | **Papir** | **Reel bug** | Transskriptionsflowet *er* wiret; tilbage-knappen er reelt død under loading. Ikke placeholder — defekt i eksisterende Papir-kode. |
| K8 | 🔴 | **Papir** | **Feature-paritet / Placeholder** | Samtlige Papir-skærme statiske mockups. **Forventet for fasen — ikke en bug.** Kræver paritets-matrix (gammel→Papir) og wiring til eksisterende hooks, ikke et "fix". |

### 🟠 Høje

| ID | Sev | App | Kategori | Begrundelse |
|---|---|---|---|---|
| H1 | 🟠 | Gammel | Reel bug | `initializing`-race i auth/App.tsx. |
| H2 | 🟠 | Gammel | Reel bug | Kontosletning rydder ikke keychain (provider-tokens + iCloud app-password). |
| H3 | 🟠 | Gammel | Reel bug | AuthSheet viser aldrig login-fejl. |
| H4 | 🟠 | Gammel | Reel bug | CRLF/mail-header-injektion i Gmail-udkast (sikkerhed). |
| H5 | 🟠 | Gammel | Reel bug | SSRF + iCloud-credential-forwarding i widget-action (sikkerhed). |
| H6 | 🟠 | Gammel | Reel bug | Ubegrænset input på LLM-proxies → omkostningsrisiko. |
| H7 | 🟠 | Gammel | Reel bug | Chat-kvote kan omgås via `claude-proxy` → paywall udløses aldrig. |
| H8 | 🟠 | Gammel | Reel bug | Advisory lock over connection pool i poll-mail. |
| H9 | 🟠 | Gammel | Reel bug | RLS UPDATE-policies uden kolonnebegrænsning (agent/trust-integritet). |
| H10 | 🟠 | Gammel | Reel bug | Reminder-migrering sletter lokale data uden insert-tjek. |
| H11 | 🟠 | Gammel | Reel bug | Sentinel-dato 2099 lækker som reel `dueAt`. |
| H12 | 🟠 | Gammel | Reel bug | Widget-snapshot last-writer-wins sletter andre kilders data. |
| H13 | 🟠 | Gammel | Reel bug | iCloud recurrence-guard tæller forekomster før vinduet. |
| H14 | 🟠 | Gammel | Reel bug | Manglende pagination — events cappet til 50. |
| H15 | 🟠 | Gammel | Reel bug | Gentagelser der overlapper vinduets start droppes (iCloud). |
| H16 | 🟠 | Gammel | Reel bug | Chat-svar markeres aldrig "besvaret" for Gmail/Outlook. |
| H17 | 🟠 | Gammel | Reel bug | Ingen delt cache → refetch-storme (perf). |
| H18 | 🟠 | Gammel | Reel bug | `useDaySchedule`: to events samme time — sidste vinder (datatab). |
| H19 | 🟠 | Gammel | Reel bug | Kalenderliste til modellen sorteres alfabetisk, ikke kronologisk. |
| H20 | 🟠 | Gammel | Reel bug | iCloud-skrivninger i chat ignorerer integrations-toggle. |
| H21 | 🟠 | Gammel | Reel bug | Konfliktbesked sender UTC-tider til modellen (DST-fejl). |
| H22 | 🟠 | Gammel | Reel bug | Signatur-sanitizer: uafsluttet tag udskrives råt (sikkerhed). |
| H23 | 🟠 | Gammel | Reel bug | Signatur-import: prompt modsiger sanitizer-allowlist. |
| H24 | 🟠 | Gammel | Reel bug | TodayScreen: frosset ur/forældet "i dag"-data. |
| H25 | 🟠 | Gammel | Reel bug | Pull-to-refresh-spinner i Inbox lukker straks. |
| H26 | 🟠 | Gammel | Reel bug | CalendarScreen renderer 53 ugesider eagert (perf). |
| H27 | 🟠 | Gammel | Reel bug | ChatScreen re-parser alle bobler pr. tastetryk (perf). |
| H28 | 🟠 | Gammel | Reel bug | InboxDetail: tilbage kasserer uafsendt svar uden bekræftelse. |
| H29 | 🟠 | Gammel | Reel bug | TextInput i ProposalDetailModal dækkes af tastaturet. |
| H30 | 🟠 | Gammel | Reel bug | Tab-barens faner usynlige for VoiceOver (a11y). |
| H31 | 🟠 | Gammel | Reel bug | Swipe-gestus vælger forkert fane (`locationX`). |
| H32 | 🟠 | Gammel | Reel bug (design-gæld) | To temasystemer blandet; en gemt direction kan gøre komponenter ulæselige. Reel defekt-risiko, ikke bevidst valg. |
| H33 | 🟠 | **Papir** | **Reel bug** | Race conditions i optageflowet — flowet *er* wiret, kan crashe på Android. |
| H34 | 🟠 | **Papir** | **Reel bug** | Optagelse stoppes ikke ved annullér; iOS audio-session efterlades i optage-mode. Reel defekt i wiret kode. |
| H35 | 🟠 | **Papir** | **Reel bug** | Fejlet transskription viser opdigtet DEMO-indhold som brugerens optagelse — farligt, "Gem note" ville gemme fremmed indhold. |
| H36 | 🟠 | **Papir** | **Reel bug** (ufærdig UI) | Ingen safe-area-håndtering; kolliderer med Dynamic Island. Genuin defekt der vil skibe, men del af igangværende Papir-polish. |
| H37 | 🟠 | **Papir** | **Reel bug** | Push-"stakken" har dybde 1 — navigationen er hjemmelavet og eksisterer; back lander forkert. |
| H38 | 🟠 | **Papir** | **Placeholder / Manglende impl.** | Døde `ScaleButton`-affordances uden `onPress` (hero, Noter, Alle, Premium). **Ikke en bug** — features ikke wiret endnu. Bør wires ifm. paritet. |
| H39 | 🟠 | Begge | Reel bug (proces) | Ingen ESLint/lint-script — manglende sikkerhedsnet for begge apps. |
| H40 | 🟠 | Begge | Reel bug (proces) | Ingen CI — sådan kunne K1/K2/K3 ligge committet. |
| H41 | 🟠 | Begge | Designvalg (m. gæld) | Tre parallelle theme-systemer er *bevidst* side-by-side, men uden udfasningsplan. Ikke en bug; kræver exit-plan ifm. Papir-migreringen. |

### 🟡 Mellem

| ID | Sev | App | Kategori | Begrundelse |
|---|---|---|---|---|
| M1–M4 | 🟡 | Gammel | Reel bug | Auth/app-kerne: push-token, iCloud-event-bus, SecureStore-migrering, session-blob-størrelse. |
| M5–M9 | 🟡 | Gammel | Reel bug | Edge/integrationer: imap credential-orakel, poll-mail UUID, trust-decide service-role, RevenueCat env-filter, drive-picker CSP. |
| M10–M16 | 🟡 | Gammel | Reel bug | Edge/AI: prompt-injektion (M10–M11), manglende timeouts (M12), agent-undo/sweep/budget/claim (M13–M16). |
| M17–M21 | 🟡 | Gammel | Reel bug | Database: FK/cascade, skema-drift i purge, redundant index, search_path, `agent_claim_events`-fix (M21 = **verificér i prod**). |
| M22–M52 | 🟡 | Gammel | Reel bug | Klient-datalag: UTC-datoer, ignorerede fejl, kontoskifte-races, dedup, serielle fan-outs, parsing. Alt i eksisterende app. |
| M53–M67 | 🟡 | Gammel | Reel bug | Classic screens: frosne timestamps, tomme-tilstande, virtualisering, a11y, onboarding-OAuth-fejl, JWT-knap bag co-founder-mail. |
| M68–M79 | 🟡 | Gammel | Reel bug | Komponenter: ignorerede resultater, evige timere, remounts, a11y, dublerede bottom-sheets, status-bar-højde. |
| M80 | 🟡 | **Papir** | **Reel bug** | Dobbelttryk på stop fyrer `onStop` ×2 — wiret optageflow. |
| M81 | 🟡 | **Papir** | **Reel bug** | Uhåndteret rejection i mount-effekt — "Lytter…" uden optagelse. |
| M82 | 🟡 | **Papir** | **Reel bug** | Ingen timeout på transskriberings-upload (m. K7 = evig hængning). |
| M83 | 🟡 | **Papir** | **Reel bug** | "Godmorgen,." uden navn — Home-greeting *er* nu wiret til rigtige data, så tom-navn-grenen er en reel edge-case. |
| M84 | 🟡 | **Papir** | **Placeholder / Mockup** | Hardcodet data der ser dynamisk ud ("9 nye mails", DEMO_EVENTS, "Online"). **Bevidst statisk — ikke bug.** Erstattes ved wiring. |
| M85 | 🟡 | **Papir** | **Reel bug** (struktur) | Lokal state/scroll mistes ved tab-skift; `done` i to usynkroniserede kopier. Strukturel defekt i den hjemmelavede shell, der består efter data-wiring. |
| M86 | 🟡 | **Papir** | **Manglende impl.** | DayTimeline håndterer ikke virkelige data (overflow/overlap/`key={i}`). Endnu ikke wiret; bliver reel bug når data kobles på. |
| M87 | 🟡 | **Papir** | **Reel bug** (a11y) | Kontrast under WCAG i aktive Papir-tokens. |
| M88 | 🟡 | **Papir** | **Reel bug** (a11y) | A11y-huller i Papir-skærmlokale komponenter (TaskRow/SegmentedControl/Chip). |
| M89 | 🟡 | **Papir** | **Reel bug** | Android hardware-back ikke håndteret i shellen (minimerer app midt i optagelse). |
| M90 | 🟡 | Begge | Reel bug (proces) | 0 tests af `hooks.ts` og Papir. |
| M91 | 🟡 | Begge | Reel bug (proces) | Ingen crash-rapportering trods tidligere prod-OTA-crash. |
| M92–M93 | 🟡 | Gammel | Reel bug | Voice-intents-test kompileres aldrig; manglende font i onboarding. |

### 🟢 Lave

| ID | Sev | App | Kategori | Begrundelse |
|---|---|---|---|---|
| L1–L23 | 🟢 | Gammel | Reel bug / oprydning | Auth, edge functions, database: token-refresh-deps, død kode (L5), rate-limit, search_path, retention, DST-drift (L23 = bevidst kendt drift). |
| L24–L47 | 🟢 | Gammel | Reel bug / oprydning | Klient-datalag: sentinel-felter, entity-dekodning, dubletter, apostrof/OData, mimetype. |
| L48–L55 | 🟢 | Gammel | Reel bug / oprydning | Classic screens: død scroll-tracking, ubrugte imports, midnats-helpers, testbarhed. |
| L56–L60 | 🟢 | Gammel | Reel bug / oprydning | Komponenter: rå fejltekster, hardcodede farver, javascript:-scheme-gate, RAF/deps. |
| L61 | 🟢 | **Papir** | **Reel bug** (perf) | Waveform re-renderer optageskærmen 8–10×/s på JS-tråden — wiret flow. |
| L62 | 🟢 | **Papir** | Reel bug (oprydning) | Død kode/ubrugte imports & tokens i Papir. |
| L63 | 🟢 | **Papir** | **Designvalg-afvigelse** | Hardcodede hex i strid med tokens-filens egen regel. Konsistens/kode-kvalitet, ikke funktionel bug. |
| L64 | 🟢 | Papir/design | Reel bug | `ScaleButton` fyrer haptik på press-in og uden `onPress` (bruges i Papir). |
| L65 | 🟢 | **Papir** | **Manglende impl.** (latent) | Ustabile keys (`key={m.from}`/`key={i}`) — bliver reelle bugs når data wires. |
| L66 | 🟢 | Begge | Reel bug | PapirPreviewRoot ignorerer font-fejl; hele Papir-træet bundles i prod uanset flag (jf. K1). |
| L67 | 🟢 | **Papir** | **Reel bug** | `transcribe.ts` hardcoder `audio/m4a`-mimetype — wiret flow. |
| L68–L69 | 🟢 | Begge | Reel bug / oprydning | Config: anon-key-duplikering, versions-drift. |

### Opsummering pr. kategori

| Kategori | Antal (ca.) | Hvor |
|---|---|---|
| **Reel bug** | ~155 | Overvejende gammel app; + wiret Papir-kode (stemmeflow, greeting, shell) |
| **Manglende impl.** | 3 | M86, L65, (H38 delvist) — Papir |
| **Placeholder / Mockup** | 3 | K8, M84, H38 — Papir |
| **Feature-paritet** | 1 (paraply) | K8 — dækker hele Papir-skærmfladen |
| **Designvalg** | 2 | H41 (theme-side-by-side), L63 (hardcodede hex) |

**Handlingsanbefaling uændret:** Ret reelle bugs i den gamle app først (rapportens Fase 0–4), da de rammer kørende brugere. Papirs Feature-paritet/Placeholder-fund (K8-paraplyen) håndteres som *migreringsarbejde* via en paritets-matrix — men de **wirede** Papir-bugs (K7, H33–H35, M80–M83) bør rettes sammen med Fase 5, fordi de allerede kan ramme brugere via stemmeflowet.
