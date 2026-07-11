# Hvordan bliver Zolva en rigtig personlig assistent — ikke bare en AI-chat?

*Analyse udarbejdet 2026-07-11. Grundlag: gennemlæsning af agent-tick, agent-reflect, agent-commitments, prompt.ts (agent-værktøjer), trust.ts, daily-brief, profile-extractor.ts og PapirAgent.tsx.*

---

## 1. Kernediagnosen

En chat venter. En assistent **kommer til dig**. Forskellen ligger i fire egenskaber:

1. **Initiativ** — den handler før du spørger.
2. **Hukommelse med konsekvens** — det den ved, ændrer det den gør (ikke bare det den siger).
3. **Kontinuitet** — den samler tråde op over dage og uger ("du lovede Mette i tirsdags…").
4. **Ansvar** — den ejer opgaver til de er lukket, ikke kun til beskeden er sendt.

Det stærke ved Zolvas nuværende arkitektur: **fundamentet for alle fire findes allerede.** `agent-tick` (triage med `mail_draft_reply`/`mail_send_reply`/`cal_create_event`, `supabase/functions/_shared/agent/prompt.ts`), `agent-reflect` (mødeforberedelse 120 min før, quiet-hours-bevidst), `agent-commitments` (løftesporing i sendte mails med reconcile — "stop med at minde mig om ting jeg har gjort"), `trust.ts` (tillids-eskalering pr. modtager efter 3 godkendelser), og `facts`-tabellen med decay og `follow_up_at`. Problemet er ikke evner — det er at **det meste af intelligensen er usynlig eller kun udløses reaktivt**, og at værdifuld data ligger ubrugt (`tone`, `ai_usage_events`, `agent_runs`, onboardingens "vision", `work_preferences.work-end`).

Strategien: gør det usynlige synligt, luk kredsløbene (møde → notat → løfte → opfølgning), og lad tilliden vokse ad en eksplicit stige.

---

## 2. Brugerens dag — hvor kan Zolva komme først?

| Tidspunkt | Brugerens tilstand | Zolvas mulighed i dag | Hullet |
|---|---|---|---|
| **06.30–08** | Orienterer sig, let stresset | Morgenbrief (kalender, 3 mails, løfter, vejr) | Briefen *fortæller* — den *har ikke arbejdet* i nat |
| **08–09** | Transport | Intet | Afgangstid, forberedelse til første møde |
| **09–12** | Møder | Reflect-nudge 120 min før (kun push, kun Pro) | Ingen prep-kort i appen; intet efter mødet |
| **12–14** | Indbakke-pres | "Svar klar"-badges, triage-forslag | Forslag skal findes ét ad gangen; ingen batch-gennemgang |
| **14–17** | Dyb arbejdstid | Middagsbrief | Ingen beskyttelse af fokus, ingen "du har en ledig lomme til det du lovede" |
| **~17** | Fyraften | Intet (aftenbrief kommer senere) | Ingen "løse ender inden du lukker" — selvom `work_preferences` kender arbejdstidens slutning |
| **Aften** | Privat | Aftenbrief | Burde handle om *i morgen*, ikke i dag |
| **Nat** | Sover | Intet (quiet hours stopper alt) | Natten er gratis arbejdstid for agenten |

Livscyklussen: **Dag 1** har allerede "first win"-briefen (`daily-brief/force.ts`). **Uge 1** mangler en grund til at forstå hvad agenten kan. **Måned 1** burde bevise hukommelse. **Måned 6** burde føles som en kollega der kender ens år.

---

## 3. Idékatalog (32 idéer)

Format: **Navn** — hvor i rejsen · hvorfor · Wow / Kompleksitet · bygger på.

### A. Morgenen: "Mens du sov"

**1. Nat-arbejdet i briefen** — morgen. I nat kørte `agent-tick` alligevel; lad morgenbriefen rapportere resultatet: *"3 mails kom i nat. 2 var nyhedsbreve. Til Mettes spørgsmål har jeg lagt et svar klar — godkend med ét tryk."* Adfærdsrationale: at vågne op til *udført* arbejde er den stærkeste assistent-følelse der findes; briefen går fra avis til medarbejder. **Wow: høj / Kompleksitet: lav** — `daily-brief/index.ts` (`assembleInputs`) skal bare læse nattens `proposed_actions` + `agent_actions` og linke til Agent-skærmen (`PapirAgent.tsx`).

**2. Morgenens "godkend alt på 1 minut"** — morgen. Ét kort i Home/brief: "3 svar klar" → swipe-flow (send / spring over / redigér) i stedet for at finde forslag enkeltvis. Rationale: batch-beslutninger er kognitivt billige; enkeltafbrydelser er dyre. **Wow: mellem / Kompleksitet: mellem** — `proposed_actions` + eksisterende approve/dismiss i `src/lib/agent-proposals.ts`.

**3. Afgangstids-vagt** — før første møde med lokation. Reflect kender `location` og `start`; tilføj rejsetid (Apple Maps/Google ETA) og nudge: *"Kør 8.12, så når du mødet kl. 9 på Østerbro."* **Wow: høj / Kompleksitet: mellem** (ekstern ETA-API) — `agent-reflect/index.ts` + `reflect-events.ts`.

**4. Vejr der handler, ikke rapporterer** — morgen. Per-bruger-lokation (allerede markeret som "v2 follow-up" ved `DEFAULT_LAT/LNG` i `daily-brief/index.ts:80`) + kun nævne vejr når det ændrer en beslutning ("regn kl. 14 hvor du skal ud"). **Wow: lav / Kompleksitet: lav.**

**5. "Ledig lomme til dit løfte"** — morgen/middag. Kryds dagens commitments med kalenderen via `free-slots.ts`: *"Du lovede Mette kontrakten fredag — du har 45 min ledige kl. 10.15. Skal jeg blokere dem?"* Rationale: assistenter forbinder *hvad* med *hvornår*; det er den del brugeren selv glemmer. **Wow: høj / Kompleksitet: mellem** — `free-slots.ts` + `commitments` + `cal_create_event` (proposal-flowet findes).

### B. Møder: luk kredsløbet

**6. Prep-kort i appen (ikke kun push)** — 2 timer før møde. `agent-reflect` laver i dag kun en `nudge_push`, hvis indhold forsvinder med notifikationen. Gem i stedet et prep-kort: seneste mailtråd med deltagerne (via `mail_search`/`mail_get_body` som reflect allerede kalder), åbne løkker med samme personer, sidste mødenotat/optagelse. Vis på Home og i Plan. **Wow: høj / Kompleksitet: mellem** — reflect skriver til `notification_feed`/ny `prep_cards`, klient renderer.

**7. Post-møde opsamling** — når kalenderbegivenheden slutter. Push: *"Mødet med Nordea er slut — vil du indtale en hurtig opsamling?"* → dyb-link til `PapirRecord` → `PapirTranscription` udtrækker allerede actions. Rationale: fangst-øjeblikket er de første 5 minutter efter mødet; det er dér løfter fordamper. **Wow: høj / Kompleksitet: lav-mellem** — genbrug reflect-sweepets kalenderlæsning, trig på `end` i stedet for `start`.

**8. Transkript → hukommelse** — efter optagelse. Verificeret hul: transkripter fodrer ikke `facts` automatisk. Kør `runExtractor` (`src/lib/profile-extractor.ts`) over transkriptets action-liste, så mødeløfter får `follow_up_at` og lander i briefen og `agent-memory-followups`-sweepet. **Wow: mellem (men compounding-kritisk) / Kompleksitet: lav** — infrastrukturen findes 100 %.

**9. Konflikt-vagten** — når ny invitation lander. Ved kalender-overlap: proaktivt forslag *"Dit 13-møde kolliderer med tandlægen. Skal jeg foreslå 14.30 i stedet?"* med `cal_update_event` + `mail_draft_reply`. **Wow: høj / Kompleksitet: mellem** — triage-reglerne i `prompt.ts` pkt. 5 kalder allerede `cal_list_events` ±2 t; udvid med konflikt-gren.

**10. Afslåede møder filtreres fra** — kvalitet. `mapCalEvent` i `agent-reflect/index.ts:76` har en TODO: `response_status` er altid `'none'`, så reflect forbereder dig potentielt på møder du har afslået. Færdiggør læseren. **Wow: lav (men fravær af pinlighed) / Kompleksitet: lav.**

### C. Indbakken: fra triage til ejerskab

**11. Rykker-udkast, ikke bare rykker-nudge** — når `owed_to_you`-løkke er moden. `agent-commitments` sender i dag en templated nudge; lad den i stedet lægge en venlig rykker-mail klar som proposal: *"Karl har ikke svaret i 5 dage — jeg har skrevet en rykker. Send?"* **Wow: høj / Kompleksitet: lav-mellem** — `MEMORY_FOLLOWUP_TOOLS` i `prompt.ts` beviser mønstret (nudge→draft→send i samme sweep); genbrug i commitment-nudge-fasen.

**12. VIP-læring** — løbende. Lær hvilke afsendere brugeren altid svarer hurtigt (data: `mail_events` + svar i sent) → foreslå som fact: *"Skal jeg altid markere mails fra din revisor som Haster?"* Fodrer Inbox-tiers og push-prioritet. **Wow: mellem / Kompleksitet: mellem** — `facts` category=`relationship`/`preference` + Inbox-tiering.

**13. Ubesvaret VIP-alarm** — middag. Hvis en mail fra en lært VIP ligger ubesvaret > brugerens normale svartid: én diskret linje i middagsbriefen (ikke push). **Wow: mellem / Kompleksitet: lav** oven på #12.

**14. Nyhedsbrevs-digest** — fredag. *"Skal jeg samle dine nyhedsbreve i ét ugentligt resumé?"* Inbox har allerede Nyhedsbreve-tieret; agenten opsummerer ugens høst i ét kort. Rationale: fjerner dårlig samvittighed over ulæst. **Wow: mellem / Kompleksitet: mellem.**

**15. Dokument-forudseenhed** — under triage. Når en tråd nævner et dokument, kalder agenten allerede `drive_search`; lad forslaget inkludere *"…og jeg fandt 'Tilbud_Nordea_v3' i dit Drive — vedhæft?"* **Wow: høj ("det havde jeg ikke selv tænkt på") / Kompleksitet: mellem** — `drive.ts` findes, vedhæftnings-flowet er nyt.

### D. Eftermiddag og aften: afslutning og forberedelse

**16. Fyraftens-checket** — `work_preferences` kender arbejdstidens slutning (i dag ubrugt til dette). 30 min før: *"Inden du lukker: du lovede Mette kontrakten, og Karl venter stadig. Vil du have svarudkast til begge?"* Rationale: løse ender leveret **mens du stadig kan handle** er guld; kl. 21 er de bare stress. **Wow: høj / Kompleksitet: lav** — samme cron-mønster som `daily-brief`, inputs findes (`commitments`, `proposed_actions`).

**17. Aftenbriefen vender fremad** — aften. Omskriv `compose.ts`-prompten for `evening`: i morgen først (første møde, hvad kræver forberedelse, hvad du har lovet), i dag som én linje. **Wow: mellem / Kompleksitet: lav** (prompt-ændring).

**18. Fokus-værn** — når kalenderen gror til. Registrér dage med >X timers møder og foreslå at blokere fokus-tid via `free-slots.ts` inden andre tager lommerne. **Wow: mellem / Kompleksitet: mellem.**

### E. Compounding: uge, måned, halvår

**19. Ugens regnskab** — fredag eftermiddag/søndag aften. *"Denne uge: 23 mails håndteret (8 skrev jeg udkast til), 2 løfter holdt, 1 åben. Du godkendte alle mine svar til Mette — skal jeg sende dem selv fremover?"* Data findes ubrugt: `ai_usage_events`, `agent_actions`, `commitments`, `trust`-slots. Rationale: compounding-værdi skal *fortælles* for at føles; det er også den naturlige rampe til trust-offers. **Wow: høj / Kompleksitet: mellem.**

**20. "Zolva sparede dig X minutter"** — i ugerapporten + Profile. Groft estimat pr. handlingstype (udkast ≈ 4 min, kalenderaftale ≈ 2 min). **Wow: mellem / Kompleksitet: lav** — ren aggregering af `agent_actions`/`ai_usage_events`.

**21. Vision-genbesøget** — måned 1 og kvartalsvist. Onboarding indsamler pain points og "vision" — og bruger dem aldrig igen (verificeret hul). *"Da du startede, sagde du at ubesvarede mails stressede dig. Siden da har jeg lagt 31 svar klar."* Rationale: beviser at Zolva *husker hvorfor du kom* — den reneste "det havde jeg ikke selv tænkt på"-følelse. **Wow: høj / Kompleksitet: lav** — data ligger der allerede.

**22. Årshjulet** — løbende. `profile-extractor.ts` har allerede `DEADLINE_RE` (forny/udløb/bilsyn/forsikring/abonnement/frist) og 14-dages varsel via `computeFollowUpAt`. Udvid: (a) gør deadline-facts tilbagevendende (bilsyn er årligt), (b) fang kvitterings-/fornyelsesmails i triage med `commitment_record`-lignende værktøj. Efter 6 måneder kender Zolva dit år bedre end du selv. **Wow: høj / Kompleksitet: mellem.**

**23. Mærkedage** — løbende. `relationship`-facts med dato ("Marias fødselsdag 3/9") + `follow_up_at`: *"Maria har fødselsdag på torsdag."* **Wow: mellem (høj følelsesmæssigt) / Kompleksitet: lav.**

**24. Person-hukommelse** — ved skrivning/møde. Aggregér facts + commitments + tråde pr. modpart: åbner du en tråd med Mette, viser et diskret kort "du skylder hende kontrakten; hun svarede sidst om budgettet". **Wow: høj / Kompleksitet: høj** — signaturfunktion-kandidat.

**25. Stil-tvillingen** — løbende. Lær brugerens skrivestil fra sendte mails (hilsen, længde, formalitet, typiske vendinger — evt. pr. modtager) og fodr den ind i `mail_draft_reply`-prompten. Rationale: udkast der lyder som *dig* er forskellen på at redigere og at trykke send — det løfter godkendelsesraten og dermed hele trust-stigen. **Wow: høj / Kompleksitet: mellem** — en stil-profil i `facts`/egen tabel, injiceret i `SYSTEM_PROMPT`-tonen (`prompt.ts` har allerede TONE-regler at bygge på).

**26. Brief-tid der lærer** — uge 2+. Hvis briefen konsekvent først åbnes 8.40 men sendes 7.00: *"Du læser typisk briefen ved 8.30 — skal jeg flytte den?"* Data: `briefs.delivered_at` + åbnings-tidspunkt. **Wow: lav / Kompleksitet: lav** — respektfuld selv-kalibrering.

### F. Livscyklus og følelsen af menneske

**27. Progressivt samtykke i uge 1** — dag 2–7. Én ny evne pr. dag som et spørgsmål, ikke en feature-tour: dag 2 *"Må jeg holde øje med løfter i dine sendte mails?"*, dag 3 *"Må jeg forberede dig på møder?"* Rationale: initiativ man har sagt ja til, irriterer ikke; det er trust-stigen som onboarding. **Wow: mellem / Kompleksitet: mellem** — toggles findes (`agent_enabled`, `memory_enabled`), mangler kun sekvensering.

**28. Skygge-agenten** — free/lite-brugere. Agenten kører triage i skyggetilstand (kun trace, ingen handling — `agent_runs` gemmer allerede traces) og viser bagefter: *"I går ville jeg have svaret 3 mails og oprettet 1 møde for dig."* Rationale: den mest overbevisende paywall er at se det udførte arbejde man ikke fik. **Wow: høj / Kompleksitet: mellem** — kommerciel motor og produktdemo i ét.

**29. Stilhed med signatur** — dage uden noget vigtigt. I dag: `empty-skipped` = briefen udebliver tavst, og brugeren ved ikke om Zolva sov. Send i stedet én linje: *"Ikke noget vigtigt i dag — jeg siger til."* Rationale: tavshed skal *betyde* tryghed, ikke tvivl; det er dét der gør at man tør slå notifikationer til. **Wow: lav pr. gang, høj kumulativt / Kompleksitet: lav** (`daily-brief/index.ts:318`).

**30. Micro-anerkendelse** — når sidste løse ende lukkes. *"Det var den sidste — du er ajour."* Én sætning, aldrig konfetti. **Wow: lav / Kompleksitet: lav** — `PapirAgent`s "Alt er roligt"-empty-state udvidet med kontekst.

**31. Fortryd-læring** — når brugeren reverter. `revertAgentAction`/`revertTrustOffer` findes, men agenten lærer intet af det. Registrér revert som negativ feedback: sænk tilliden for den slot, og spørg én gang *"Skal jeg holde mig fra at [handle] for [modtager]?"* → `preference`-fact. Rationale: en assistent der mærker efter når den har trådt forkert, føles menneskelig. **Wow: mellem / Kompleksitet: lav-mellem.**

**32. Widget: dagen på homescreen** — hele dagen. Næste begivenhed + "2 svar klar" + næste løfte. Proaktivitet **uden** push — brugeren kigger selv. iOS-widget-stubs findes allerede i `targets/widget/` og `widget-action`-funktionen findes. **Wow: mellem / Kompleksitet: mellem.**

---

## 4. Irritationsgrænsen: hvornår må Zolva tage initiativ?

Zolva har allerede de rigtige instinkter i koden — quiet hours (`quiet-hours.ts`, respekteret af reflect *og* commitments så dedup ikke brændes om natten), nudge-ratelimit (én pr. emne pr. dag via idem-key), "vær konservativ, i tvivl gør intet" i alle system-prompter, og 14-dages suppression af afviste facts. Det skal ophøjes til eksplicitte principper:

### De seks regler

1. **Initiativ skal kunne handles på i ét tryk.** Enhver proaktiv besked bærer en handling (Send / Udskyd / Vis) — og altid en tredje: **"Ikke denne slags igen"** (per-`action_kind`-mute, gemt som `preference`-fact). Muten *er* feedback-kanalen; uden den er eneste udvej at slå alt fra.
2. **Push-budget: maks. 3 proaktive pushes/dag** ud over brief og eksplicitte reminders. Alt derudover samles i næste brief eller `notification_feed`. Kanalhierarki efter hast: **push** (tidskritisk, i dag) → **brief-linje** (vigtigt, denne uge) → **kort i appen** (rart at vide) → **stilhed**.
3. **Kontekst-respekt.** Kalenderen ved hvornår brugeren sidder i møde — ingen ikke-akutte pushes midt i et møde; batch dem til mødet slutter (samme sweep-data som reflect). Weekend = kun det brugeren aktivt har bedt om.
4. **Konfidens-tærskler som i hukommelsen.** `profile-extractor.ts` har allerede mønstret: 0.6 = foreslå, 0.85 = auto-confirm. Generalisér til handlinger: lav konfidens → sig intet; mellem → foreslå; høj → gør (hvis tilliden tillader det).
5. **Fejl koster tillid — automatisk.** Et revert sænker slot-tilliden (idé 31). En assistent der bliver ved efter at være blevet rettet, opleves som påtrængende; en der justerer sig, opleves som lyttende.
6. **Stilhed skal være meningsfuld** (idé 29): brugeren skal kunne stole på at "ingen besked = intet vigtigt".

### Tillids-stigen (byg på `trust.ts`)

Koden har allerede kernen: 3 godkendelser af samme (handlingstype, modtager) → trust-offer → `auto`-politik pr. modtager, med revert. Udvid den til en eksplicit fire-trins stige **pr. handlingsfamilie**:

| Trin | Adfærd | Findes i dag? |
|---|---|---|
| 1. **Observér** | Skyggetilstand — vis hvad Zolva *ville* have gjort (idé 28) | `agent_runs`-traces findes, ingen UI |
| 2. **Foreslå** | Proposal-kort, brugeren godkender | ✅ `proposed_actions` + `PapirAgent` |
| 3. **Gør og fortæl** | Handler selv, rapporterer i "Udført" med Fortryd | ✅ for mail.send_reply pr. modtager efter trust-offer |
| 4. **Gør stille** | Handler selv, nævnes kun i ugerapporten | Findes ikke — kræver måneders fejlfri historik |

Konkrete udvidelser: (a) trust-offers for **kalenderfamilien** ("Du har godkendt 5 kalenderaftaler uændret — skal jeg oprette dem selv?") — `shouldOfferPromotion` er allerede slot-generisk; (b) trust-offers **nævnt i ugerapporten** hvor konteksten ("du godkendte alt denne uge") gør spørgsmålet naturligt; (c) eskalering er altid **tilbudt, aldrig taget** — Zolva spørger om mere ansvar som en dygtig ny medarbejder ville.

---

## 5. Prioritering

### 🔥 Høj effekt / lav indsats — gør først
| # | Idé | Hvorfor først |
|---|---|---|
| 1 | Nat-arbejdet i morgenbriefen | Størst assistent-følelse pr. udviklingstime; ren læsning af eksisterende tabeller |
| 16 | Fyraftens-checket | `work_preferences` + commitments findes; helt nyt dagligt touchpoint |
| 11 | Rykker-udkast i commitment-sweep | Mønstret findes i `MEMORY_FOLLOWUP_TOOLS`; løfter nudge → handling |
| 8 | Transkript → facts | Lukker det største hukommelses-hul med eksisterende `runExtractor` |
| 21 | Vision-genbesøget | Ubrugt onboarding-data → ren "den husker mig"-magi |
| 29 + 30 | Stilheds-signal + micro-anerkendelse | Småt, men bygger den tryghed al proaktivitet hviler på |
| 10 + 31 | Declined-filter + revert-læring | Fjerner de pinlige fejl der koster mest tillid |

### 🚀 Høj effekt / høj indsats — planlæg
- **6. Prep-kort i appen** — reflect fra push-kanon til forberedelses-motor
- **25. Stil-tvillingen** — løfter godkendelsesraten og dermed hele trust-stigen
- **19. Ugens regnskab** — compounding-fortællingen + naturlig trust-rampe
- **28. Skygge-agenten** — produktdemo, paywall-motor og trin 1 på stigen i ét
- **24. Person-hukommelse** — den dybe differentiering på 6-måneders sigt
- **3. Afgangstids-vagt** — kræver ekstern ETA-integration, men rammer hverdagen hver dag

### ✨ Små detaljer med stor oplevet værdi
Dokument-forudseenhed i svar-forslag (15) · "Sparede dig X min" (20) · Brief-tid der lærer (26) · Mærkedage (23) · "Ikke denne slags igen"-mute på alle nudges · Post-møde-prompten (7).

### 🌟 Signaturfunktioner — det Zolva kan blive kendt for
1. **"Mens du sov"** (1+2): morgenbriefen som rapport over udført natarbejde med ét-tryks-godkendelse. Ingen mail-app gør dette.
2. **Løfte-vagten** (11+16+22): `agent-commitments` er allerede teknisk unik (sporing *begge* veje med reconcile) — gør den til et synligt løfte: *"Zolva glemmer aldrig hvad du har lovet — eller hvad andre skylder dig."*
3. **Stil-tvillingen** (25): udkast der lyder som dig, ikke som en robot. Den følbare forskel på "AI-funktion" og "min assistent".
4. **Tillids-stigen** (28 + trust-udvidelser): observér → foreslå → gør-og-fortæl → gør stille, altid tilbudt, aldrig taget. Selve *relationen* som produkt — og den ærligste vej til autonomi på markedet.
5. **Ugens regnskab** (19+20): den ugentlige fortælling der gør compounding-værdien synlig og bærer både retention og opsalg.

**Den røde tråd:** Zolva skal ikke chatte mere — den skal **rapportere mere af det arbejde den allerede kan udføre**, bede om ansvar i små, tilbudte trin, og lade hukommelsen få konsekvenser i handlinger. Chatten bliver så det man *også* kan gøre — ikke det produktet *er*.
