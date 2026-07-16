// src/lib/demo-data.ts
//
// The full demo universe for demo@zolva.dk — a coherent, months-of-usage
// dataset around one persona:
//
//   Frederik Lund, 38 — partner i konsulenthuset Lundgreen & Partner
//   (digital strategi, København). Leder et team på fem: Sofia Wang
//   (produktkonsulent), Jonas Krogh (seniorkonsulent, nær ven), Louise Berg
//   (praktikant) m.fl. Managing partner: Maria Bergmann. Største kunde:
//   Lunar (Mette Halling, marketingchef; Anders Brix, indkøb). Privat:
//   gift med Signe, børnene Alma (7) og Villum (4), padel med Mikkel Holm.
//
// Everything here is CLIENT-SIDE ONLY. The demo session never talks to
// Supabase or provider APIs — data-layer functions short-circuit on
// DEMO_USER_ID, so demo content can never mix with real users' data.
// "Nulstil" = log ud og ind igen (resetDemoData() runs on every demo login).
import type {
  ChatMessage,
  ChatMessageRow,
  Fact,
  FactCategory,
  FeedEntry,
  Note,
  Observation,
  Reminder,
} from './types';
import type { Brief, BriefSections } from './briefs';
import type { NetworkFollowup, NetworkInteraction, NetworkPerson } from './network-store';
import type { AgentActionRow } from './agent-feed';
import type { ProposedActionRow } from './agent-proposals';
import type { CommitmentRow } from './agent-commitments';
import type { TrustOfferRow } from './trust-offers';

export const DEMO_USER_ID = 'demo-user-00000000-0000-4000-8000-000000000000';

export function isDemoUserId(userId: string | null | undefined): boolean {
  return userId === DEMO_USER_ID;
}

// ─── date helpers ──────────────────────────────────────────────────────────

function dayAt(offsetDays: number, h = 0, m = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, m, 0, 0);
  return d;
}

function iso(offsetDays: number, h = 0, m = 0): string {
  return dayAt(offsetDays, h, m).toISOString();
}

function minutesAgoIso(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

// ─── calendar ──────────────────────────────────────────────────────────────

export type DemoDayEvent = {
  id: string;
  title: string;
  sub: string;
  location?: string;
  description?: string;
  attendees?: Array<{ name: string; email?: string }>;
  tone: 'sage' | 'clay' | 'mist';
  color: string;
  hour: number;
  min: number;
  durationMin: number;
  allDay?: boolean;
};

type DayseedInput = Omit<DemoDayEvent, 'id' | 'sub' | 'tone' | 'color'> &
  Partial<Pick<DemoDayEvent, 'sub' | 'tone' | 'color'>>;

// Google Calendar palette so demo events look native.
const COLORS = ['#0B8043', '#F4511E', '#F6BF26', '#3F51B5', '#8E24AA', '#039BE5', '#D50000'];
const TONES: DemoDayEvent['tone'][] = ['sage', 'clay', 'mist'];

function fin(dayKey: number, idx: number, e: DayseedInput): DemoDayEvent {
  const durLabel = e.allDay ? 'Hele dagen' : `${e.durationMin} min`;
  return {
    tone: TONES[(idx + Math.abs(dayKey)) % TONES.length],
    color: COLORS[(idx * 3 + Math.abs(dayKey)) % COLORS.length],
    sub: e.location ? `${e.location} · ${durLabel}` : durLabel,
    ...e,
    id: `d-ev-${dayKey}-${idx}`,
  };
}

const TEAM = {
  sofia: { name: 'Sofia Wang', email: 'sw@lundgreen.dk' },
  jonas: { name: 'Jonas Krogh', email: 'jk@lundgreen.dk' },
  louise: { name: 'Louise Berg', email: 'lb@lundgreen.dk' },
  maria: { name: 'Maria Bergmann', email: 'mb@lundgreen.dk' },
  mette: { name: 'Mette Halling', email: 'mette.halling@lunar.dk' },
  anders: { name: 'Anders Brix', email: 'anders.brix@lunar.dk' },
  katrine: { name: 'Katrine Foss', email: 'katrine@pleo.io' },
  mikkel: { name: 'Mikkel Holm' },
  signe: { name: 'Signe Lund' },
};

// Recurring weekday rhythm. dow: 0=Sunday … 6=Saturday.
function recurringFor(dow: number): DayseedInput[] {
  const out: DayseedInput[] = [];
  if (dow >= 1 && dow <= 5 && dow !== 3) {
    out.push({
      title: 'Stand-up',
      hour: 9, min: 15, durationMin: 15,
      location: 'Teams',
      description: 'Daglig synk med teamet. Hurtige opdateringer, ingen beslutninger.',
      attendees: [TEAM.sofia, TEAM.jonas, TEAM.louise],
    });
  }
  if (dow === 2 || dow === 4) {
    out.push({ title: 'Løbetur', hour: 6, min: 30, durationMin: 45, location: 'Søerne' });
  }
  if (dow === 1) {
    out.push({
      title: 'Ugeplan med teamet',
      hour: 10, min: 0, durationMin: 45,
      location: 'Mødelokale 2',
      attendees: [TEAM.sofia, TEAM.jonas, TEAM.louise],
    });
    out.push({ title: 'Fokusblok · Q3-tilbud', hour: 13, min: 0, durationMin: 120, location: 'Kontoret' });
  }
  if (dow === 3) {
    out.push({
      title: 'Pipeline-møde',
      hour: 9, min: 0, durationMin: 60,
      location: 'Mødelokale 1',
      description: 'Gennemgang af nye leads og igangværende tilbud.',
      attendees: [TEAM.maria, TEAM.jonas],
    });
  }
  if (dow === 4) {
    out.push({ title: '1:1 med Louise', hour: 14, min: 0, durationMin: 30, location: 'Kontoret', attendees: [TEAM.louise] });
  }
  if (dow === 5) {
    out.push({ title: 'Ugeafslutning + fredagsbar', hour: 15, min: 0, durationMin: 90, location: 'Køkkenet' });
  }
  if (dow >= 1 && dow <= 5) {
    out.push({ title: 'Hente Alma og Villum', hour: 16, min: 30, durationMin: 30, location: 'Skolen/børnehaven' });
  }
  if (dow === 6) {
    out.push({ title: 'Svømning med Alma', hour: 10, min: 0, durationMin: 60, location: 'DGI-byen' });
    out.push({ title: 'Padel med Mikkel', hour: 14, min: 0, durationMin: 90, location: 'Padel Club CPH', attendees: [TEAM.mikkel] });
  }
  if (dow === 0) {
    out.push({ title: 'Middag hos mor og far', hour: 17, min: 30, durationMin: 150, location: 'Virum', attendees: [TEAM.signe] });
  }
  return out;
}

// One-off highlights keyed by day offset from today. These override/extend
// the weekday rhythm and give the near future a story: kundemøder, workshop,
// Berlin-tur, fødselsdag, deadline.
const SPECIALS: Record<number, DayseedInput[]> = {
  [-7]: [{ title: 'Kundemøde · GreenMobility', hour: 10, min: 0, durationMin: 90, location: 'Landgreven 3', description: 'Afsluttende leverance-gennemgang.' }],
  [-4]: [{ title: 'Workshop · Lunar onboarding-flow', hour: 9, min: 0, durationMin: 180, location: 'Lunar HQ, Hack Kampmanns Plads', attendees: [TEAM.mette, TEAM.anders, TEAM.sofia] }],
  [-1]: [{ title: 'Middag med Signe', hour: 19, min: 0, durationMin: 120, location: 'Restaurant Silo' }],
  0: [
    {
      title: 'Kundemøde · Lunar',
      hour: 11, min: 0, durationMin: 60,
      location: 'Lunar HQ, 2. sal',
      description: 'Gennemgang af Q3-oplæg. Mette vil se det færdige tilbud, og vi tager en runde om leverancetider. Husk at printe kontraktudkastet.',
      attendees: [TEAM.mette, TEAM.anders],
    },
    { title: 'Frokost med Jonas', hour: 13, min: 0, durationMin: 45, location: 'Café Norden, Østergade 61', attendees: [TEAM.jonas] },
    { title: '1:1 med Sofia', hour: 15, min: 30, durationMin: 30, location: 'Mødelokale 2', description: 'Opfølgning på onboarding af Louise + retro-format.', attendees: [TEAM.sofia] },
  ],
  1: [
    { title: 'Workshop · Q3-kampagne', hour: 9, min: 0, durationMin: 180, location: 'Lunar HQ', description: 'Kreativ workshop med Lunars marketing-team.', attendees: [TEAM.mette, TEAM.sofia] },
    { title: 'Tandlæge', hour: 15, min: 30, durationMin: 45, location: 'Tandklinikken Østerbro' },
  ],
  2: [
    { title: 'Fly til Berlin · SK 677', hour: 7, min: 35, durationMin: 85, location: 'CPH Terminal 3', description: 'Boardingkort i SAS-appen. Husk opladeren.' },
    { title: 'Nordic Digital Summit', hour: 12, min: 0, durationMin: 0, allDay: true, location: 'Station Berlin' },
    { title: 'Middag med Katrine (Pleo)', hour: 19, min: 30, durationMin: 120, location: 'Restaurant Katz Orange, Berlin', attendees: [TEAM.katrine] },
  ],
  3: [
    { title: 'Nordic Digital Summit · dag 2', hour: 9, min: 0, durationMin: 0, allDay: true, location: 'Station Berlin' },
    { title: 'Fly hjem · SK 682', hour: 18, min: 40, durationMin: 80, location: 'BER Terminal 1' },
  ],
  5: [
    { title: 'Almas fødselsdag 🎂', hour: 0, min: 0, durationMin: 0, allDay: true },
    { title: 'Fødselsdagsbrunch', hour: 10, min: 0, durationMin: 120, location: 'Hjemme', attendees: [TEAM.signe] },
  ],
  7: [{ title: 'DEADLINE · Q3-tilbud til Lunar', hour: 0, min: 0, durationMin: 0, allDay: true }],
  9: [{ title: 'Partnermøde', hour: 13, min: 0, durationMin: 120, location: 'Mødelokale 1', description: 'Halvårsstatus og pipeline for efteråret.', attendees: [TEAM.maria] }],
  12: [{ title: 'Sommerfest · Lundgreen & Partner', hour: 15, min: 0, durationMin: 300, location: 'Terrassen + Kødbyen' }],
};

/** All demo events for a given calendar day (recurring rhythm + specials). */
export function demoEventsForDay(date: Date): DemoDayEvent[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const offset = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const dow = target.getDay();

  // On days with a big special block (Berlin, workshop) drop the office
  // rhythm so the day doesn't double-book.
  const specials = SPECIALS[offset] ?? [];
  const dropRecurring = specials.some((s) => s.allDay || s.durationMin >= 180);
  const seeds = [...(dropRecurring ? [] : recurringFor(dow)), ...specials];
  seeds.sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.hour * 60 + a.min - (b.hour * 60 + b.min)));
  return seeds.map((s, i) => fin(offset, i, s));
}

// ─── mails ─────────────────────────────────────────────────────────────────

export type DemoMailSeed = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  minutesAgo: number;
  unread: boolean;
  aiDraft: string | null;
  tier: 0 | 1 | 2 | 3;
  body: string;
};

export const DEMO_MAIL_SEEDS: DemoMailSeed[] = [
  {
    id: 'd-m-1',
    from: 'Mette Halling',
    subject: 'Q3-kampagne — kan vi få tilbuddet inden onsdag?',
    preview: 'Ledelsen er klar til at rykke, men de vil se pris og leveranceplan…',
    minutesAgo: 8, unread: true, tier: 0,
    aiDraft:
      'Hej Mette,\n\nTak for opfølgningen — og godt at høre, at ledelsen er klar.\n\nI får det samlede tilbud med pris og leveranceplan senest onsdag kl. 12. Jeg tager de sidste leverancetider med fra mødet i dag kl. 11.\n\nBedste hilsner\nFrederik',
    body:
      'Hej Frederik,\n\nTak for et godt oplæg i sidste uge. Ledelsen er klar til at rykke på Q3-kampagnen, men de vil se det konkrete tilbud med pris og leveranceplan, før vi kan skrive under.\n\nKan du sende det inden onsdag? Så kan jeg nå at få det med på styregruppemødet torsdag morgen.\n\nVi ses kl. 11!\n\nMvh\nMette Halling\nMarketing Lead, Lunar',
  },
  {
    id: 'd-m-2',
    from: 'Anders Brix',
    subject: 'Re: Samarbejdsaftale — én rettelse i §4',
    preview: 'Kontrakten ser fin ud fra vores side. Én enkelt rettelse…',
    minutesAgo: 34, unread: true, tier: 0,
    aiDraft:
      'Hej Anders,\n\nGodt at høre. Jeg ringer i morgen formiddag mellem 9 og 10, så tager vi §4 dér — det lyder som en lille ting.\n\nBedste hilsner\nFrederik',
    body:
      'Hej Frederik,\n\nKontrakten ser fin ud fra vores side. Én enkelt rettelse i §4 om opsigelsesvarsel — vi vil gerne have 60 dage i stedet for 30.\n\nKan vi tage det over en kort snak i morgen?\n\nVenlig hilsen\nAnders Brix\nProcurement, Lunar',
  },
  {
    id: 'd-m-3',
    from: 'Katrine Foss',
    subject: 'Opfølgning fra i fredags — næste skridt?',
    preview: 'Rigtig godt at møde dig til morgenmaden hos DI. Som lovet…',
    minutesAgo: 95, unread: true, tier: 1,
    aiDraft: null,
    body:
      'Hej Frederik,\n\nRigtig godt at møde dig til morgenmaden hos DI i fredags. Som lovet vil jeg gerne tage en snak om, hvordan I kunne hjælpe os med onboarding-flowet i Q4.\n\nJeg er i Berlin til Nordic Digital Summit i næste uge — er du der også? Ellers finder vi en dag i København.\n\nBedste hilsner\nKatrine Foss\nHead of Growth, Pleo',
  },
  {
    id: 'd-m-4',
    from: 'Sofia Wang',
    subject: 'Retro på torsdag + Louises case',
    preview: 'To ting: Jeg har booket mødelokalet til retroen torsdag 14…',
    minutesAgo: 180, unread: true, tier: 1,
    aiDraft: null,
    body:
      'Hej Frederik,\n\nTo ting:\n\n1) Jeg har booket mødelokalet til retroen torsdag kl. 14. Louise deltager for første gang, så jeg tænker vi kører det korte format.\n\n2) Louises casebeskrivelse til hjemmesiden er næsten klar — hun venter kun på dit ok til at nævne GreenMobility ved navn. Må hun det?\n\nSofia',
  },
  {
    id: 'd-m-5',
    from: 'Maria Bergmann',
    subject: 'Agenda til partnermødet',
    preview: 'Vedhæftet agenda til partnermødet. Vigtigste punkt er pipeline…',
    minutesAgo: 260, unread: true, tier: 1,
    aiDraft: null,
    body:
      'Kære Frederik,\n\nVedhæftet agenda til partnermødet i næste uge. Vigtigste punkt er pipeline for efteråret — tag gerne en status med på både Lunar-forlængelsen og Pleo-dialogen.\n\nOg så skal vi lande datoen for strategiseminaret i september.\n\nBedste hilsner\nMaria',
  },
  {
    id: 'd-m-6',
    from: 'Billy Regnskab',
    subject: 'Faktura #4021 fra Nygaard Foto er klar til godkendelse',
    preview: 'Der ligger en ny leverandørfaktura til godkendelse: 12.400 kr…',
    minutesAgo: 350, unread: true, tier: 2,
    aiDraft: null,
    body:
      'Hej Frederik,\n\nDer ligger en ny leverandørfaktura til godkendelse i Billy:\n\nLeverandør: Nygaard Foto ApS\nBeløb: 12.400,00 kr. inkl. moms\nVedrører: Fotoproduktion, Lunar Q3-kampagne\nForfald: om 8 dage\n\nGodkend eller afvis direkte i Billy.\n\nBilly Regnskab',
  },
  {
    id: 'd-m-7',
    from: 'AULA · Almas skole',
    subject: 'Husk: forældremøde 2.A på tirsdag kl. 17',
    preview: 'Kære forældre i 2.A. Husk forældremødet på tirsdag…',
    minutesAgo: 420, unread: true, tier: 2,
    aiDraft: null,
    body:
      'Kære forældre i 2.A,\n\nHusk forældremødet på tirsdag kl. 17.00 i klasselokalet. Vi skal bl.a. tale om lejrskolen i september og vælge nye forældrerepræsentanter.\n\nKaffe og kage — tilmelding ikke nødvendig.\n\nVenlig hilsen\nHenriette, klasselærer 2.A',
  },
  {
    id: 'd-m-8',
    from: 'SAS',
    subject: 'Din rejse til Berlin — check-in åbner i morgen',
    preview: 'SK 677 København–Berlin. Check-in åbner 24 timer før afgang…',
    minutesAgo: 600, unread: true, tier: 3,
    aiDraft: null,
    body:
      'Kære Frederik Lund,\n\nDin rejse nærmer sig.\n\nSK 677 København (CPH) → Berlin (BER)\nAfgang 07.35 · Ankomst 09.00\nSæde 11C · SAS Go Smart\n\nCheck-in åbner 24 timer før afgang i SAS-appen.\n\nGod rejse!\nSAS',
  },
  {
    id: 'd-m-9',
    from: 'Mikkel Holm',
    subject: 'Padel lørdag — 14 eller 15?',
    preview: 'Banen er ledig både 14 og 15. Taberen giver kaffe bagefter…',
    minutesAgo: 1300, unread: false, tier: 1,
    aiDraft: null,
    body:
      'Hej makker,\n\nBanen er ledig både kl. 14 og 15 på lørdag. Hvad passer bedst? Taberen giver kaffe bagefter — så du kan lige så godt tage pungen med.\n\nMikkel',
  },
  {
    id: 'd-m-10',
    from: 'Louise Berg',
    subject: 'Udkast til GreenMobility-casen',
    preview: 'Her er mit første udkast til casebeskrivelsen. Vær sød at være ærlig…',
    minutesAgo: 1500, unread: false, tier: 1,
    aiDraft: null,
    body:
      'Hej Frederik,\n\nHer er mit første udkast til casebeskrivelsen om GreenMobility-projektet. Vær sød at være ærlig — jeg vil hellere rette det nu end efter det er online.\n\nOg tak for snakken i torsdags, den hjalp!\n\nLouise',
  },
  {
    id: 'd-m-11',
    from: 'Jonas Krogh',
    subject: 'Re: Fokusblok — flyttet analyse-delen',
    preview: 'Har flyttet analyse-delen til vores fælles drev. Kig på fane 2…',
    minutesAgo: 1650, unread: false, tier: 1,
    aiDraft: null,
    body:
      'Hej,\n\nHar flyttet analyse-delen af Q3-tilbuddet til vores fælles drev. Kig især på fane 2 — jeg tror vi undervurderer volumen på deres app-push.\n\nVi tager det over frokosten.\n\nJonas',
  },
  {
    id: 'd-m-12',
    from: 'GreenMobility',
    subject: 'Tak for et fantastisk samarbejde',
    preview: 'Nu hvor projektet er afleveret, vil vi bare sige tak…',
    minutesAgo: 2900, unread: false, tier: 1,
    aiDraft: null,
    body:
      'Kære Frederik og team,\n\nNu hvor projektet er afleveret, vil vi bare sige tak for et fantastisk samarbejde. Den nye bookingflow har allerede løftet konverteringen med 14 %.\n\nVi vender helt sikkert tilbage i efteråret.\n\nBedste hilsner\nThomas Winther\nCPO, GreenMobility',
  },
  {
    id: 'd-m-13',
    from: 'Danløn',
    subject: 'Lønkørsel juli er gennemført',
    preview: 'Lønkørslen for juli er gennemført. 6 lønsedler er afsendt…',
    minutesAgo: 4100, unread: false, tier: 3,
    aiDraft: null,
    body:
      'Hej,\n\nLønkørslen for juli er gennemført. 6 lønsedler er afsendt til e-Boks, og beløbet hæves fra erhvervskontoen d. 28.\n\nDanløn',
  },
  {
    id: 'd-m-14',
    from: 'Børsen Morgenbriefing',
    subject: 'Dagens vigtigste erhvervsnyheder',
    preview: 'Renten holdes i ro, dansk fintech henter milliardinvestering…',
    minutesAgo: 4500, unread: false, tier: 3,
    aiDraft: null,
    body:
      'Godmorgen,\n\nDagens vigtigste historier: Nationalbanken holder renten i ro, dansk fintech henter milliardinvestering, og detailhandlen melder om fremgang for tredje kvartal i træk.\n\nLæs mere på borsen.dk\n\nBørsen',
  },
  {
    id: 'd-m-15',
    from: 'DSB',
    subject: 'Kvittering — Orange til Aarhus',
    preview: 'Tak for dit køb. København H → Aarhus H, afgang 06.26…',
    minutesAgo: 5700, unread: false, tier: 3,
    aiDraft: null,
    body:
      'Kære kunde,\n\nTak for dit køb.\n\nKøbenhavn H → Aarhus H\nOrange, 1 voksen: 199 kr.\nAfgang 06.26 · Spor 5\n\nGod rejse!\nDSB',
  },
  {
    id: 'd-m-16',
    from: 'LinkedIn',
    subject: 'Din opdatering nåede 4.812 visninger',
    preview: 'Dit opslag om GreenMobility-casen klarer sig godt…',
    minutesAgo: 6900, unread: false, tier: 3,
    aiDraft: null,
    body:
      'Hej Frederik,\n\nDit opslag om GreenMobility-casen klarer sig godt: 4.812 visninger, 87 reaktioner og 12 kommentarer.\n\nSe hvem der har set det på LinkedIn.\n\nLinkedIn',
  },
];

// ─── facts (memory) ────────────────────────────────────────────────────────

function mkFact(
  idx: number,
  daysBack: number,
  category: FactCategory,
  text: string,
  status: 'confirmed' | 'pending' = 'confirmed',
  source = 'chat',
): Fact {
  const created = dayAt(-daysBack, 10 + (idx % 8), (idx * 7) % 60);
  return {
    id: `demo-fact-${idx}`,
    userId: DEMO_USER_ID,
    text,
    normalizedText: text.toLowerCase(),
    category,
    status,
    source,
    createdAt: created,
    confirmedAt: status === 'confirmed' ? new Date(created.getTime() + 3_600_000) : null,
    rejectedAt: null,
    rejectionTtl: null,
    expiresAt: null,
  };
}

// 19 confirmed ("gemte facts") + 3 pending til review — spredt over ~5 måneder.
export function seedDemoFacts(): Fact[] {
  return [
    mkFact(1, 148, 'role', 'Frederik er partner i Lundgreen & Partner og leder et team på fem.'),
    mkFact(2, 145, 'relationship', 'Signe er Frederiks ægtefælle.'),
    mkFact(3, 141, 'relationship', 'Alma (7) og Villum (4) er Frederiks børn.'),
    mkFact(4, 132, 'preference', 'Foretrækker korte mails uden lange indledninger og hilsner.'),
    mkFact(5, 126, 'relationship', 'Maria Bergmann er managing partner og Frederiks nærmeste sparringspartner.'),
    mkFact(6, 118, 'preference', 'Lægger helst møder før kl. 15, så han kan hente børnene 16.30.'),
    mkFact(7, 110, 'relationship', 'Mikkel Holm er Frederiks bedste ven — de spiller padel lørdag. Mikkel arbejder i Nordea.'),
    mkFact(8, 100, 'preference', 'Løber tirsdag og torsdag morgen kl. 6.30 — book aldrig møder dér.'),
    mkFact(9, 94, 'relationship', 'Sofia Wang er produktkonsulent på Frederiks team og kører onboarding af Louise.'),
    mkFact(10, 88, 'relationship', 'Jonas Krogh er seniorkonsulent, medansvarlig på Lunar-kontoen og en nær ven.'),
    mkFact(11, 80, 'project', 'Lunar er største kunde — Q3-kampagnen er årets vigtigste leverance.'),
    mkFact(12, 74, 'relationship', 'Mette Halling er marketingchef hos Lunar og primær kontakt.'),
    mkFact(13, 66, 'preference', 'Tager toget frem for fly indenrigs — arbejdsro på strækningen.'),
    mkFact(14, 55, 'project', 'GreenMobility-projektet blev afleveret i juli med 14 % konverteringsløft.'),
    mkFact(15, 46, 'relationship', 'Louise Berg er praktikant til september — skal have feedback hurtigt og direkte.'),
    mkFact(16, 38, 'preference', 'Morgenbriefing kl. 7 — gerne med vejret først.'),
    mkFact(17, 25, 'project', 'Pleo-dialogen (Katrine Foss) er det vigtigste nye lead til Q4.'),
    mkFact(18, 12, 'commitment', 'Q3-tilbuddet til Lunar skal sendes senest onsdag kl. 12.'),
    mkFact(19, 6, 'preference', 'Fredag eftermiddag holdes fri for møder — bruges til opsamling.'),
    // Pending review:
    mkFact(20, 2, 'other', 'Villum starter til svømning i august.', 'pending'),
    mkFact(21, 1, 'commitment', 'Frederik skal booke sommerhus i uge 32.', 'pending'),
    mkFact(22, 0, 'relationship', 'Signe har fødselsdag den 3. august.', 'pending'),
  ];
}

// ─── chat ──────────────────────────────────────────────────────────────────

// Live chat screen: yesterday evening + this morning, so the conversation
// feels warm the moment the demo opens.
export function seedDemoChatHistory(): ChatMessage[] {
  const y = (h: number, m: number) => dayAt(-1, h, m).toISOString();
  const t = (h: number, m: number) => dayAt(0, h, m).toISOString();
  return [
    { id: 'dc-1', from: 'user', text: 'Hvordan ser min dag ud i morgen?', createdAt: y(21, 42) },
    { id: 'dc-2', from: 'zolva', text: 'I morgen har du 5 ting. Vigtigst: kundemødet med Lunar kl. 11.00 — Mette forventer at se det færdige Q3-tilbud. Du har frokost med Jonas 13.00 og 1:1 med Sofia 15.30. Jeg har holdt formiddagen fri fra 9.30, så du kan forberede dig.', createdAt: y(21, 42) },
    { id: 'dc-3', from: 'user', text: 'Kan du lave et udkast til svar til Anders om kontrakten?', createdAt: y(21, 44) },
    { id: 'dc-4', from: 'zolva', text: 'Klar. Udkast: "Hej Anders, godt at høre. Jeg ringer i morgen mellem 9 og 10, så tager vi §4 dér — 60 dages varsel er ok fra vores side, hvis prisreguleringen i §7 står uændret." Vil du have den lagt i kladder?', createdAt: y(21, 45) },
    { id: 'dc-5', from: 'user', text: 'Ja, læg den i kladder. Og mind mig om at ringe til ham.', createdAt: y(21, 46) },
    { id: 'dc-6', from: 'zolva', text: 'Udkastet ligger i kladder, og jeg minder dig om opkaldet i morgen kl. 9.00. Sov godt.', createdAt: y(21, 46) },
    { id: 'dc-7', from: 'user', text: 'Godmorgen. Hvad venter der i dag?', createdAt: t(7, 12) },
    { id: 'dc-8', from: 'zolva', text: 'Godmorgen Frederik. 3 mails venter på dig — vigtigst er Mette, der beder om Q3-tilbuddet inden onsdag. Kalenderen: stand-up 9.15, Lunar kl. 11, frokost med Jonas 13, 1:1 med Sofia 15.30. Og husk: ring til Anders kl. 9.', createdAt: t(7, 12) },
    { id: 'dc-9', from: 'user', text: 'Svar Mette at hun får tilbuddet onsdag inden kl. 12.', createdAt: t(7, 15) },
    { id: 'dc-10', from: 'zolva', text: 'Jeg har lagt et udkast klar til Mette: kort bekræftelse på onsdag kl. 12 med en linje om, at leverancetiderne kommer med fra mødet i dag. Du finder det under Agent — klar til at sende med ét tryk.', createdAt: t(7, 16) },
    { id: 'dc-11', from: 'user', text: 'Perfekt. Opsummer lige Louises udkast til GreenMobility-casen.', createdAt: t(7, 20) },
    { id: 'dc-12', from: 'zolva', text: 'Louises case er solid: god struktur (udfordring → løsning → resultat), og hun fremhæver de 14 % konverteringsløft. To ting mangler: et citat fra Thomas hos GreenMobility, og dit ok til at nævne kunden ved navn — det spurgte Sofia også om i går.', createdAt: t(7, 21) },
  ];
}

// Server-side archive (Historik → Samtaler): snippets spread over ~3 months.
type ArchiveSeed = { daysBack: number; turns: Array<[user: string, zolva: string]> };

const CHAT_ARCHIVE_SEEDS: ArchiveSeed[] = [
  { daysBack: 84, turns: [
    ['Hjælp mig med at skrive en pæn afvisning til det der leadbureau.', 'Selvfølgelig: "Tak for henvendelsen — vi har ikke behov lige nu, men jeg gemmer jeres info til efteråret." Kort og venligt, uden at åbne en dialog.'],
    ['Perfekt, send den.', 'Sendt. Jeg har arkiveret tråden.'],
  ]},
  { daysBack: 77, turns: [
    ['Brainstorm: navne til vores nye rapportformat til kunderne.', 'Fem bud: Kompasset, Månedslyset, Statuspapiret, Nordlys-rapporten og Overblikket. "Kompasset" matcher jeres sprog om retning og strategi bedst.'],
  ]},
  { daysBack: 70, turns: [
    ['Opsummer mødet med GreenMobility fra i dag.', 'Kort: I landede scope for fase 2 (bookingflow), Thomas vil have ugentlige demoer, og deadline blev rykket til uge 27. Jeg har oprettet opfølgning på demo-kadencen.'],
    ['Læg demoerne i kalenderen hver fredag kl. 10.', 'Oprettet: "Demo · GreenMobility" fredage kl. 10.00 frem til uge 27.'],
  ]},
  { daysBack: 63, turns: [
    ['Hvad gav jeg i gave til Signe sidste år? Kan du huske det?', 'Det har jeg ikke gemt — men du nævnte i marts, at hun ønskede sig keramikkurset hos Ler & Vand. Skal jeg gemme det som gaveidé?'],
    ['Ja tak.', 'Gemt under noter: "Gaveidé Signe — keramikkursus hos Ler & Vand".'],
  ]},
  { daysBack: 56, turns: [
    ['Find den billigste måde at komme til Aarhus på tirsdag morgen.', 'Orange-billet 06.26 fra København H, 199 kr. — du er fremme 09.14. Alternativt 07.26 til 249 kr. Skal jeg holde øje med prisfald?'],
    ['Tag den tidlige.', 'Købt-påmindelse oprettet — DSB åbner Orange-salg for din dato i morgen kl. 8.'],
  ]},
  { daysBack: 49, turns: [
    ['Skriv et LinkedIn-opslag om GreenMobility-resultatet.', 'Udkast: "14 % flere gennemførte bookinger. Det var målet GreenMobility satte — her er hvordan vi kom derhen…" med tre korte læringer og en tak til teamet. Vil du have det mere personligt eller mere fagligt?'],
    ['Mere personligt.', 'Opdateret — nu åbner det med Louises første kundemøde og lander på resultatet til sidst.'],
  ]},
  { daysBack: 42, turns: [
    ['Hvornår er der sommerferie i Almas skole?', 'Skolen holder sommerferie fra 28. juni til 10. august ifølge AULA-beskeden fra maj. I har sommerhus-ugen (32) inde i den periode.'],
  ]},
  { daysBack: 35, turns: [
    ['Jeg skal bruge en agenda til pipeline-mødet.', 'Forslag: 1) Lunar-forlængelse (10 min), 2) Pleo-dialog status (10), 3) Nye leads fra DI-morgenmaden (10), 4) Kapacitet august (15), 5) Evt. Skal jeg dele den med Maria og Jonas?'],
    ['Ja, del den.', 'Delt med Maria og Jonas — lagt i invitationen til onsdag kl. 9.'],
  ]},
  { daysBack: 28, turns: [
    ['Hvad skal jeg sige nej til i denne uge? Kalenderen er smadret.', 'Tre kandidater: netværksmødet torsdag (ingen agenda), leverandørdemoen onsdag (kan tages af Jonas) og statusmødet fredag (kan klares på mail). Det frigiver 3,5 time.'],
    ['Aflys demoen og giv den til Jonas.', 'Gjort — Jonas har accepteret, og du er taget af invitationen.'],
  ]},
  { daysBack: 21, turns: [
    ['Villum har fødselsdag i børnehaven på fredag. Hvad gør man?', 'Traditionen i Myretuen er flagstang, sange og noget spiseligt til ca. 20 børn — de fleste tager frugtspyd eller boller med. Skal jeg lægge en påmindelse torsdag aften om at forberede det?'],
    ['Ja, og skriv boller på indkøbslisten.', 'Påmindelse oprettet torsdag kl. 19, og "boller + rosiner" er på listen.'],
  ]},
  { daysBack: 14, turns: [
    ['Opsummer alle åbne punkter med Lunar.', 'Tre åbne punkter: 1) Q3-tilbud (deadline onsdag), 2) §4-rettelsen i kontrakten (Anders venter på opkald), 3) workshop-datoen for kreativ-sporet. Alt andet er lukket.'],
  ]},
  { daysBack: 7, turns: [
    ['Skriv en tak-mail til Thomas for det pæne opslag om casen.', 'Udkast klar: kort tak, glæde over de 14 %, og en dør på klem til fase 3 i efteråret. Vil du se den før afsendelse?'],
    ['Send den bare.', 'Sendt til Thomas. Jeg har noteret "fase 3-interesse" på GreenMobility.'],
  ]},
  { daysBack: 3, turns: [
    ['Hvad er status på mine løfter?', 'To åbne: Q3-tilbuddet til Mette (onsdag) og opkaldet til Anders om §4. Louise venter desuden på din feedback på casen — den har ligget 2 dage.'],
    ['Så minder du mig om Louise i morgen tidlig.', 'Klart — påmindelse i morgen kl. 8.30: "Giv Louise feedback på GreenMobility-casen".'],
  ]},
];

export function seedDemoChatArchive(): ChatMessageRow[] {
  const rows: ChatMessageRow[] = [];
  let i = 0;
  for (const conv of CHAT_ARCHIVE_SEEDS) {
    let minute = 0;
    for (const [u, z] of conv.turns) {
      const base = dayAt(-conv.daysBack, 9 + (i % 9), (i * 11) % 50);
      rows.push({
        id: `demo-cm-${i}-u`, userId: DEMO_USER_ID, clientId: `demo-cm-${i}-u`,
        role: 'user', content: u, createdAt: new Date(base.getTime() + minute * 60_000),
      });
      rows.push({
        id: `demo-cm-${i}-a`, userId: DEMO_USER_ID, clientId: `demo-cm-${i}-a`,
        role: 'assistant', content: z, createdAt: new Date(base.getTime() + minute * 60_000 + 40_000),
      });
      minute += 2;
      i += 1;
    }
  }
  // Append the live history so Samtaler matches what the chat screen shows.
  for (const m of seedDemoChatHistory()) {
    rows.push({
      id: m.id, userId: DEMO_USER_ID, clientId: m.id,
      role: m.from === 'user' ? 'user' : 'assistant',
      content: m.text,
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
    });
  }
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return rows;
}

// Keyword-routed demo replies so a live presenter can type naturally and get
// a plausible answer, whatever they ask.
const DEMO_REPLY_ROUTES: Array<{ match: RegExp; reply: string }> = [
  { match: /mail|svar|skriv til|udkast/i, reply: 'Jeg har lagt et udkast klar: kort, venligt og med en tydelig næste handling. Du finder det under Agent — sig til, hvis tonen skal justeres.' },
  { match: /opsummer|resum|referat|møde/i, reply: 'Kort opsummering: Lunar er klar til at rykke på Q3, tilbuddet skal med til styregruppen torsdag, og eneste udestående på kontrakten er §4 om opsigelsesvarsel. Jeg har noteret to opfølgninger.' },
  { match: /kalender|flyt|book|mød/i, reply: 'Klaret — jeg har opdateret kalenderen og sendt opdaterede invitationer til deltagerne. Du har stadig fri bane før kl. 9 i morgen.' },
  { match: /rejse|fly|tog|berlin|hotel/i, reply: 'Din Berlin-tur er på plads: SK 677 onsdag 7.35, hotel ved Rosenthaler Platz, og middagen med Katrine fra Pleo er bekræftet 19.30. Check-in åbner i morgen — jeg minder dig om det.' },
  { match: /brainstorm|idé|ideer|forslag/i, reply: 'Tre hurtige vinkler: 1) gør casen til fortællingen om Louises første projekt, 2) lad tallene tale — 14 % løft på 8 uger, 3) afslut med hvad I ville gøre anderledes. Vil du have jeg folder en af dem ud?' },
  { match: /i dag|min dag|venter|overblik|status/i, reply: 'Overblik: 3 mails venter (Mette er vigtigst), kundemøde med Lunar kl. 11, frokost med Jonas 13, 1:1 med Sofia 15.30. To åbne løfter: Q3-tilbuddet og opkaldet til Anders.' },
  { match: /husk|påmind|glem/i, reply: 'Noteret — jeg minder dig om det i morgen kl. 8.30 og lægger det i dine åbne opgaver.' },
  { match: /tak/i, reply: 'Velbekomme. Jeg siger til, hvis der lander noget vigtigt inden mødet.' },
];

const DEMO_REPLY_FALLBACKS = [
  'Godt spørgsmål — jeg har kigget i din kalender og dine mails: intet dér blokerer. Vil du have, at jeg folder det ud som en note?',
  'Det klarer jeg. Jeg vender tilbage med et udkast om et øjeblik — du får besked her i chatten.',
  'Forstået. Jeg har noteret det og kobler det på Q3-forløbet, så det ikke forsvinder.',
];

let demoReplyFallbackIdx = 0;

export function demoChatReply(text: string): string {
  for (const r of DEMO_REPLY_ROUTES) {
    if (r.match.test(text)) return r.reply;
  }
  const reply = DEMO_REPLY_FALLBACKS[demoReplyFallbackIdx % DEMO_REPLY_FALLBACKS.length];
  demoReplyFallbackIdx += 1;
  return reply;
}

// ─── briefs ────────────────────────────────────────────────────────────────

function briefSections(kind: Brief['kind']): BriefSections {
  if (kind === 'morning') {
    return {
      calendar: [
        '9.15 Stand-up med teamet (15 min)',
        '11.00 Kundemøde hos Lunar — Q3-oplægget (60 min)',
        '13.00 Frokost med Jonas på Café Norden',
        '15.30 1:1 med Sofia — onboarding af Louise',
      ],
      mails: [
        'Mette (Lunar) beder om Q3-tilbuddet inden onsdag — udkast ligger klar.',
        'Anders vil vende §4 i kontrakten — ring mellem 9 og 10.',
        'Katrine fra Pleo følger op på DI-morgenmaden — varmt lead.',
      ],
      followups: [
        'Q3-tilbuddet skal afsted senest onsdag kl. 12.',
        'Louise venter på feedback på GreenMobility-casen (2 dage).',
      ],
      focus: ['Landing af Q3-tilbuddet er ugens vigtigste opgave — alt andet kan vente.'],
      weather: ['Letskyet, 15° i morgentimerne og op til 21° i eftermiddag. Tør cykelvej.'],
    };
  }
  if (kind === 'midday') {
    return {
      calendar: ['13.00 Frokost med Jonas', '15.30 1:1 med Sofia', '16.30 Hente Alma og Villum'],
      mails: ['2 nye siden i morges — ingen haster. Fakturaen fra Nygaard Foto venter på godkendelse.'],
      followups: ['Ring til Anders om §4, hvis det ikke er sket endnu.'],
      focus: ['Brug vinduet 14.00–15.30 på leverancetiderne til tilbuddet.'],
      weather: ['21° og tørt resten af dagen.'],
    };
  }
  return {
    calendar: ['I morgen: workshop hos Lunar 9.00 og tandlæge 15.30.'],
    mails: ['Alle vigtige mails er besvaret. 3 nyhedsbreve arkiveret automatisk.'],
    followups: ['Q3-tilbud: leverancetider på plads efter dagens møde — mangler kun prisafsnit.'],
    focus: ['God dag: Lunar-mødet gik godt, og Mette er positiv. I morgen handler om workshoppen.'],
    weather: ['I morgen: overskyet, 19°, mulighed for byger sidst på dagen.'],
  };
}

const BRIEF_HEADLINES: Record<Brief['kind'], string[]> = {
  morning: [
    'Travl formiddag — Lunar kl. 11 er dagens vigtigste.',
    'Rolig start. Én ting haster: tilbuddet til Mette.',
    'Fire aftaler og to åbne løfter — her er planen.',
    'Løbetur, stand-up og fri bane efter 14.',
    'Dagen er front-loaded — eftermiddagen er din.',
    'To kundemøder i dag. Jeg har lagt forberedelsen klar.',
  ],
  midday: [
    'Formiddagen gik som planlagt — to ting til i eftermiddag.',
    'Status: mails under kontrol, ét løfte mangler.',
    'Eftermiddagen er let — godt vindue til fokusarbejde.',
  ],
  evening: [
    'Dagen er lukket pænt ned. I morgen: workshop kl. 9.',
    'Alt vigtigt besvaret. To ting venter i morgen tidlig.',
    'God dag — Q3 rykkede sig. Sov godt.',
  ],
};

const BRIEF_TONES: Array<Brief['tone']> = ['busy', 'calm', 'calm', 'heads-up', 'calm', 'busy'];

export function demoTodayBrief(): Brief {
  const h = new Date().getHours();
  const kind: Brief['kind'] = h < 11 ? 'morning' : h < 16 ? 'midday' : 'evening';
  const genHour = kind === 'morning' ? 7 : kind === 'midday' ? 12 : 17;
  return {
    id: `demo-brief-today-${kind}`,
    kind,
    headline: BRIEF_HEADLINES[kind][0],
    body: [],
    sections: briefSections(kind),
    weather: { tempC: 18, highC: 21, lowC: 13, conditionLabel: 'Letskyet' },
    tone: kind === 'morning' ? 'busy' : 'calm',
    generatedAt: dayAt(0, genHour, 0),
    readAt: null,
  };
}

export function demoBriefHistory(kind: Brief['kind'], limit = 30): Brief[] {
  const out: Brief[] = [];
  const genHour = kind === 'morning' ? 7 : kind === 'midday' ? 12 : 17;
  for (let d = 0; d < Math.min(limit, 28); d++) {
    const dow = dayAt(-d).getDay();
    if (dow === 0 || dow === 6) continue; // briefs kun på hverdage — ligner ægte brug
    const headlines = BRIEF_HEADLINES[kind];
    out.push({
      id: `demo-brief-${kind}-${d}`,
      kind,
      headline: headlines[d % headlines.length],
      body: [],
      sections: d === 0 ? briefSections(kind) : null,
      weather: null,
      tone: BRIEF_TONES[d % BRIEF_TONES.length],
      generatedAt: dayAt(-d, genHour, 0),
      readAt: d === 0 ? null : dayAt(-d, genHour + 1, 12),
    });
  }
  return out;
}

// ─── agent (proposals, actions, commitments, trust) ────────────────────────

function seedProposals(): ProposedActionRow[] {
  return [
    {
      id: 'demo-prop-1',
      action_type: 'mail.send_reply',
      payload: { to: 'mette.halling@lunar.dk', subject: 'Re: Q3-kampagne — kan vi få tilbuddet inden onsdag?' },
      preview: {
        title: 'Svar til Mette Halling · Lunar',
        body: 'Hej Mette. I får det samlede tilbud med pris og leveranceplan senest onsdag kl. 12 — leverancetiderne tager jeg med fra mødet i dag. Bedste hilsner, Frederik',
      },
      status: 'pending',
      created_at: minutesAgoIso(6),
      expires_at: iso(1, 8, 0),
    },
    {
      id: 'demo-prop-2',
      action_type: 'cal.create_event',
      payload: { title: 'Forberedelse · Lunar-mødet' },
      preview: {
        title: 'Bloker 9.45–10.45 til forberedelse',
        body: 'Du har kundemøde med Lunar kl. 11. Jeg foreslår en times forberedelse lige efter stand-up, så tallene fra Jonas er friske.',
      },
      status: 'pending',
      created_at: minutesAgoIso(48),
      expires_at: iso(0, 11, 0),
    },
  ];
}

function seedAgentActions(): AgentActionRow[] {
  const mk = (
    idx: number, minsAgo: number, type: AgentActionRow['action_type'],
    payload: Record<string, unknown>, reversible = false, reversed = false,
  ): AgentActionRow => ({
    id: `demo-act-${idx}`,
    action_type: type,
    payload,
    executed_at: minutesAgoIso(minsAgo),
    reversible,
    reverse_token: reversible ? { kind: 'demo' } : null,
    reversed_at: reversed ? minutesAgoIso(minsAgo - 10) : null,
  });
  return [
    mk(1, 12, 'mail.archive', { subject: 'Dagens vigtigste erhvervsnyheder', from: 'Børsen' }, true),
    mk(2, 55, 'mail.label', { subject: 'Faktura #4021 fra Nygaard Foto', to: 'Økonomi' }, true),
    mk(3, 130, 'mail.draft_reply', { subject: 'Re: Samarbejdsaftale — §4', to: 'anders.brix@lunar.dk' }),
    mk(4, 26 * 60, 'mail.send_reply', { subject: 'Re: Padel lørdag — 14 eller 15?', to: 'Mikkel Holm' }, true),
    mk(5, 29 * 60, 'cal.create_event', { title: 'Ring til Anders om §4 (9.00)' }, true),
    mk(6, 47 * 60, 'mail.archive', { subject: 'Din opdatering nåede 4.812 visninger', from: 'LinkedIn' }, true),
    mk(7, 52 * 60, 'mail.summarize', { subject: 'Udkast til GreenMobility-casen', from: 'Louise Berg' }),
    mk(8, 3 * 24 * 60, 'mail.flag_important', { subject: 'Opfølgning fra i fredags — næste skridt?', from: 'Katrine Foss' }),
    mk(9, 4 * 24 * 60, 'mail.draft_reply', { subject: 'Re: Agenda til partnermødet', to: 'mb@lundgreen.dk' }),
    mk(10, 5 * 24 * 60, 'cal.update_event', { title: 'Retro flyttet til torsdag 14.00' }, true, true),
    mk(11, 6 * 24 * 60, 'mail.archive', { subject: 'Lønkørsel juli er gennemført', from: 'Danløn' }, true),
    mk(12, 7 * 24 * 60, 'mail.send_new', { subject: 'Tak for et stærkt samarbejde', to: 'Thomas Winther' }),
  ];
}

function seedCommitments(): CommitmentRow[] {
  const mk = (
    idx: number, direction: CommitmentRow['direction'], counterparty: string,
    summary: string, dueOffsetDays: number | null, daysOld: number,
  ): CommitmentRow => ({
    id: `demo-loop-${idx}`,
    direction,
    counterparty,
    summary,
    due_at: dueOffsetDays === null ? null : iso(dueOffsetDays, 12, 0),
    due_inferred: dueOffsetDays !== null,
    thread_id: `demo-thread-${idx}`,
    provider: 'google',
    status: 'open',
    created_at: iso(-daysOld, 9, 30),
    nudged_at: null,
    resolved_at: null,
  });
  return [
    mk(1, 'you_owe', 'Mette Halling', 'Sende Q3-tilbud med pris og leveranceplan', 2, 4),
    mk(2, 'you_owe', 'Louise Berg', 'Give feedback på GreenMobility-casen', 1, 2),
    mk(3, 'owed_to_you', 'Katrine Foss', 'Vender tilbage med datoforslag til Q4-snak', null, 3),
    mk(4, 'owed_to_you', 'Anders Brix', 'Sender revideret kontrakt efter §4-snakken', 3, 1),
  ];
}

function seedTrustOffers(): TrustOfferRow[] {
  return [
    {
      id: 'demo-trust-1',
      action_type: 'mail.send_reply',
      recipient: 'mette.halling@lunar.dk',
      approval_count: 3,
      status: 'pending',
      created_at: minutesAgoIso(90),
      decided_at: null,
    },
    {
      id: 'demo-trust-2',
      action_type: 'mail.archive',
      recipient: 'nyhedsbreve',
      approval_count: 11,
      status: 'accepted',
      created_at: iso(-9, 10, 0),
      decided_at: iso(-9, 10, 5),
    },
  ];
}

// ─── observations ──────────────────────────────────────────────────────────

export function demoObservationList(): Observation[] {
  return [
    { id: 'd-o-1', text: 'Mette venter på Q3-tilbuddet — jeg har lagt et svar klar, og selve tilbuddet mangler kun prisafsnittet.', cta: 'Se udkastet', mood: 'thinking', action: { kind: 'mailDraft', mailId: 'd-m-1' } },
    { id: 'd-o-2', text: 'Du har fri bane 9.45–10.45. Godt vindue til at forberede Lunar-mødet.', cta: 'Bloker tiden', mood: 'calm' },
    { id: 'd-o-3', text: 'Louises case har ventet på din feedback i 2 dage — hun spurgte pænt igen via Sofia.', cta: 'Åbn mailen', mood: 'thinking', action: { kind: 'openMail', mailId: 'd-m-10' } },
    { id: 'd-o-4', text: 'Check-in til Berlin åbner i morgen kl. 7.35. Jeg minder dig om det.', cta: 'Ok', mood: 'happy' },
  ];
}

export function demoObservationHistory(): Array<Observation & { generatedAt: Date; sourceDate: string }> {
  const texts: Array<[number, string, string, Observation['mood']]> = [
    [1, 'Du svarede alle vigtige mails inden kl. 10 i går — det er tredje dag i træk.', 'Fortsæt', 'happy'],
    [2, 'Pipeline-mødet onsdag mangler stadig en agenda.', 'Lav agenda', 'thinking'],
    [3, 'Anders har ikke fået svar om §4 endnu — tråden er 2 dage gammel.', 'Ring nu', 'thinking'],
    [5, 'Din fredag er mødefri, som du foretrækker.', 'Ok', 'calm'],
    [6, 'Tre nyhedsbreve arkiveret automatisk i nat.', 'Se dem', 'calm'],
    [8, 'GreenMobility-casen fik flot respons på LinkedIn — 4.812 visninger.', 'Se opslag', 'happy'],
    [10, 'Du har booket møder hver morgen kl. 9 i næste uge — overvej en fri morgen.', 'Se ugen', 'thinking'],
  ];
  return texts.map(([d, text, cta, mood], i) => ({
    id: `demo-obs-h-${i}`,
    text, cta, mood,
    generatedAt: dayAt(-d, 8, 15),
    sourceDate: dayAt(-d).toISOString().slice(0, 10),
  }));
}

// ─── sent mails (lokal log over hvad Zolva har sendt) ──────────────────────

export function demoSentMailRecords(): Array<{
  id: string;
  sentAt: string;
  provider: 'google' | 'microsoft' | 'icloud';
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyToId?: string;
}> {
  const mk = (
    idx: number, minsAgo: number, provider: 'google' | 'microsoft',
    to: string, subject: string, body: string, replyToId?: string,
  ) => ({
    id: `demo-sm-${idx}`,
    sentAt: minutesAgoIso(minsAgo),
    provider,
    to: [to],
    subject,
    body,
    replyToId,
  });
  return [
    mk(1, 45, 'google', 'anders.brix@lunar.dk', 'Re: Samarbejdsaftale — én rettelse i §4',
      'Hej Anders,\n\nGodt at høre. Jeg ringer i morgen formiddag mellem 9 og 10, så tager vi §4 dér.\n\nBedste hilsner\nFrederik', 'd-m-2'),
    mk(2, 26 * 60, 'google', 'mikkel.holm@nordea.dk', 'Re: Padel lørdag — 14 eller 15?',
      'Kl. 14 — og du skal ikke regne med gratis kaffe.\n\nFrederik', 'd-m-9'),
    mk(3, 2 * 24 * 60, 'google', 'thomas.winther@greenmobility.com', 'Tak for et stærkt samarbejde',
      'Hej Thomas,\n\nTusind tak for de fine ord — og tillykke med de 14 %. Døren står åben til fase 3 i efteråret.\n\nBedste hilsner\nFrederik'),
    mk(4, 3 * 24 * 60, 'microsoft', 'mb@lundgreen.dk', 'Agenda · pipeline-mødet onsdag',
      'Hej Maria,\n\nAgenda: 1) Lunar-forlængelse, 2) Pleo-status, 3) nye leads fra DI, 4) kapacitet august, 5) evt.\n\nFrederik'),
    mk(5, 4 * 24 * 60, 'google', 'sw@lundgreen.dk', 'Re: Retro på torsdag',
      'Hej Sofia,\n\nTorsdag 14 er godt — kør det korte format. Og ja, Louise må gerne nævne GreenMobility ved navn.\n\nFrederik', 'd-m-4'),
    mk(6, 5 * 24 * 60, 'google', 'katrine@pleo.io', 'Godt at møde dig — lad os tage den i Berlin',
      'Hej Katrine,\n\nI lige måde! Jeg er også til Nordic Digital Summit — skal vi sige middag onsdag aften?\n\nBedste hilsner\nFrederik', 'd-m-3'),
    mk(7, 6 * 24 * 60, 'microsoft', 'lb@lundgreen.dk', 'Din case er rigtig god',
      'Hej Louise,\n\nStærkt udkast — strukturen sidder. Jeg sender detaljeret feedback i morgen, men du er tæt på.\n\nFrederik'),
    mk(8, 8 * 24 * 60, 'google', 'aula@skole.dk', 'Re: Forældremøde 2.A',
      'Hej Henriette,\n\nVi kommer begge to. Tak for kaffen på forhånd.\n\nVh Frederik (Almas far)'),
  ];
}

// ─── notification feed ─────────────────────────────────────────────────────

/** Seedet notifikationsfeed, så Notifikationer-skærmen ser levende ud.
 * Lever kun i hukommelsen — nulstilles ved næste demo-login. */
export function demoFeedEntries(): FeedEntry[] {
  const mk = (
    id: string, type: FeedEntry['type'], title: string, body: string,
    minsAgo: number, payload: FeedEntry['payload'], read: boolean,
  ): FeedEntry => ({
    id, type, title, body,
    firesAt: new Date(Date.now() - minsAgo * 60_000),
    createdAt: new Date(Date.now() - minsAgo * 60_000),
    readAt: read ? new Date(Date.now() - (minsAgo - 5) * 60_000) : null,
    payload,
  });
  return [
    mk('demo-nf-1', 'newMail', 'Ny mail fra Mette Halling', 'Q3-kampagne — kan vi få tilbuddet inden onsdag?', 8,
      { type: 'newMail', provider: 'google', messageId: 'd-m-1' }, false),
    mk('demo-nf-2', 'agent_proposal', 'Zolva har et forslag', 'Svar til Mette ligger klar til godkendelse.', 6,
      { type: 'agent_proposal', action_id: 'demo-prop-1' }, false),
    mk('demo-nf-3', 'calendarPreAlert', 'Om 30 min: Kundemøde · Lunar', 'Lunar HQ, 2. sal — husk kontraktudkastet.', 25,
      { type: 'calendarPreAlert', eventId: 'd-ev-0-1' }, false),
    mk('demo-nf-4', 'brief', 'Din morgenbriefing er klar', 'Travl formiddag — Lunar kl. 11 er dagens vigtigste.', 60 * 3,
      { type: 'brief', briefId: 'demo-brief-today-morning' }, true),
    mk('demo-nf-5', 'reminder', 'Påmindelse: Ring til Anders om §4', 'Du bad mig minde dig om det kl. 9.', 60 * 4,
      { type: 'reminder', reminderId: 'd-r-1' }, true),
    mk('demo-nf-6', 'newMail', 'Ny mail fra Katrine Foss', 'Opfølgning fra i fredags — næste skridt?', 95,
      { type: 'newMail', provider: 'google', messageId: 'd-m-3' }, true),
  ];
}

// ─── reminders (opgaver) & notes ───────────────────────────────────────────

export function demoReminderList(): Reminder[] {
  const mk = (
    idx: number, text: string, dueOffset: [number, number, number] | null,
    status: 'pending' | 'done', createdDaysAgo: number, doneDaysAgo?: number,
  ): Reminder => ({
    id: `d-r-${idx}`,
    text,
    dueAt: dueOffset ? dayAt(dueOffset[0], dueOffset[1], dueOffset[2]) : null,
    status,
    createdAt: dayAt(-createdDaysAgo, 9, 0),
    doneAt: status === 'done' ? dayAt(-(doneDaysAgo ?? 0), 16, 0) : null,
    firedAt: null,
    scheduledForTz: null,
  });
  return [
    mk(1, 'Ring til Anders om §4 i kontrakten', [0, 9, 0], 'pending', 1),
    mk(2, 'Godkend faktura #4021 (Nygaard Foto)', [0, 16, 0], 'pending', 0),
    mk(3, 'Send Q3-tilbud til Mette', [2, 12, 0], 'pending', 3),
    mk(4, 'Giv Louise feedback på GreenMobility-casen', [1, 8, 30], 'pending', 2),
    mk(5, 'Køb fødselsdagsgave til Alma', [3, 17, 0], 'pending', 4),
    mk(6, 'Check-in til Berlin-flyet', [1, 7, 35], 'pending', 0),
    mk(7, 'Book sommerhus uge 32', null, 'pending', 5),
    mk(8, 'Svar AULA om forældremødet', null, 'pending', 1),
    mk(9, 'Send agenda til partnermødet', [-1, 12, 0], 'done', 3, 1),
    mk(10, 'Bekræft padel med Mikkel', [-1, 18, 0], 'done', 2, 1),
    mk(11, 'Aflever regnskabsbilag til Camilla', [-2, 12, 0], 'done', 4, 2),
    mk(12, 'Forny rejsekort', null, 'done', 6, 3),
  ];
}

export function demoNoteList(): Note[] {
  const mk = (
    idx: number, text: string, category: Note['category'], daysAgo: number,
    extras?: Partial<Note>,
  ): Note => ({
    id: `d-n-${idx}`,
    text,
    category,
    createdAt: dayAt(-daysAgo, 10 + idx, (idx * 13) % 55),
    ...extras,
  });
  return [
    mk(1, 'Lunar-mødet: Mette vil se effektmåling pr. kanal. Anders spurgte til GDPR-flowet — send ham databehandleraftalen. Leverancetider: kreativ uge 30, medieplan uge 31.', 'note', 0, { title: 'Noter fra Lunar-mødet', source: 'voice', durationSec: 154 }),
    mk(2, 'Idé: fast "Kompasset"-rapport til alle kunder hver måned — auto-genereret udkast, 20 min manuel finpudsning. Kan blive vores differentiator.', 'idea', 2),
    mk(3, 'Gaveidé Signe — keramikkursus hos Ler & Vand (hun nævnte det i marts).', 'info', 5),
    mk(4, 'Husk at sende tak-mail til Lunar efter Q3-underskrift.', 'task', 1),
    mk(5, 'Strategiseminar september: mulige steder — Kokkedal Slot, Comwell Borupgaard. Maria foretrækker nord for byen.', 'note', 6),
    mk(6, 'Villum: svømmehold starter uge 33, husk badevinger og 20 kr. til skab.', 'info', 3),
    mk(7, 'Tanker efter 1:1 med Sofia: hun er klar til mere kundeansvar — foreslå hende som lead på Pleo, hvis det lander.', 'note', 4, { title: 'Efter 1:1 med Sofia', source: 'voice', durationSec: 87 }),
    mk(8, 'Bog-tip fra Jonas: "The Pyramid Principle" — køb til Louise.', 'idea', 8),
  ];
}

// ─── netværk ────────────────────────────────────────────────────────────────
//
// Frederik Lunds netværk: kolleger, Lunar-kontakter og én pending person så
// "Ny person fundet — behold?"-flowet kan demonstreres uden AI-kald.

function seedDemoNetworkPeople(): NetworkPerson[] {
  const mk = (
    idx: number,
    name: string,
    p: Partial<NetworkPerson>,
    daysAgo: number,
  ): NetworkPerson => ({
    id: `d-np-${idx}`,
    userId: DEMO_USER_ID,
    name,
    normalizedName: name.toLowerCase(),
    company: null,
    role: null,
    relation: null,
    industry: null,
    howWeMet: null,
    location: null,
    email: null,
    phone: null,
    linkedin: null,
    traits: [],
    interests: [],
    projects: [],
    notes: null,
    summary: null,
    status: 'confirmed',
    metThroughPersonId: null,
    userEditedFields: [],
    source: 'demo',
    lastContactedAt: dayAt(-daysAgo, 11, 0),
    createdAt: dayAt(-daysAgo - 30, 9, 0),
    updatedAt: dayAt(-daysAgo, 11, 0),
    ...p,
  });
  return [
    mk(1, 'Mette Halling', {
      company: 'Lunar', role: 'Marketingchef', relation: 'kunde', industry: 'fintech',
      howWeMet: 'Gennem Lunar-samarbejdet', location: 'København',
      email: 'mette.halling@lunar.app',
      interests: ['effektmåling', 'AI i marketing'],
      projects: ['Lunar Q3-kampagnen'],
      summary: 'Din vigtigste kontakt hos Lunar — vil se effektmåling pr. kanal.',
    }, 0),
    mk(2, 'Anders Brix', {
      company: 'Lunar', role: 'Indkøb', relation: 'kunde', industry: 'fintech',
      howWeMet: 'Lunar-mødet om Q3-kampagnen',
      interests: ['GDPR og databehandling'],
      projects: ['Lunar Q3-kampagnen'],
      summary: 'Lunars indkøber — afventer databehandleraftalen fra dig.',
    }, 0),
    mk(3, 'Sofia Wang', {
      company: 'Lundgreen & Partner', role: 'Produktkonsulent', relation: 'kollega',
      interests: ['produktstrategi', 'kundeansvar'],
      projects: ['Pleo (mulig lead)'],
      summary: 'Din produktkonsulent — klar til mere kundeansvar efter jeres 1:1.',
    }, 4),
    mk(4, 'Jonas Krogh', {
      company: 'Lundgreen & Partner', role: 'Seniorkonsulent', relation: 'kollega og nær ven',
      interests: ['faglitteratur', 'strukturering af analyser'],
      summary: 'Seniorkonsulent og din nære ven — anbefalede "The Pyramid Principle".',
    }, 8),
    mk(5, 'Mikkel Holm', {
      relation: 'ven', howWeMet: 'Padel-makker gennem flere år',
      interests: ['padel'],
      summary: 'Din faste padel-makker — I spiller typisk onsdag aften.',
    }, 1),
    mk(6, 'Kasper', {
      company: 'Nordfin', role: 'Forretningsudvikler', relation: 'ny kontakt',
      howWeMet: 'Netværksmiddag i Børssalen', traits: ['høj', 'lyst hår'],
      interests: ['AI i kundeservice'],
      summary: 'Mødt til netværksmiddag — talte om AI i kundeservice, ville gerne mødes igen.',
      status: 'pending', source: 'voice-note',
    }, 2),
  ];
}

function seedDemoNetworkFollowups(): NetworkFollowup[] {
  const mk = (
    idx: number, personId: string, text: string,
    dueAt: Date | null, doneAt: Date | null,
  ): NetworkFollowup => ({
    id: `d-nf-${idx}`,
    userId: DEMO_USER_ID,
    personId,
    text,
    dueAt,
    doneAt,
    source: 'demo',
    createdAt: dayAt(-3, 10, 0),
  });
  return [
    mk(1, 'd-np-1', 'Send effektmåling pr. kanal til Mette', dayAt(1, 9, 0), null),
    mk(2, 'd-np-2', 'Send databehandleraftalen til Anders', dayAt(-1, 12, 0), null),
    mk(3, 'd-np-3', 'Foreslå Sofia som lead på Pleo', null, null),
    mk(4, 'd-np-4', 'Køb "The Pyramid Principle" til Louise', null, dayAt(-2, 15, 0)),
    mk(5, 'd-np-6', 'Aftal kaffe med Kasper efter sommerferien', dayAt(20, 9, 0), null),
  ];
}

function seedDemoNetworkInteractions(): NetworkInteraction[] {
  const mk = (
    idx: number, personId: string, kind: NetworkInteraction['kind'],
    summary: string, daysAgo: number, h = 11,
  ): NetworkInteraction => ({
    id: `d-ni-${idx}`,
    userId: DEMO_USER_ID,
    personId,
    kind,
    summary,
    occurredAt: dayAt(-daysAgo, h, 0),
    sourceRef: `demo:${idx}`,
  });
  return [
    mk(1, 'd-np-1', 'meeting', 'Lunar-mødet: Mette vil se effektmåling pr. kanal før Q3-underskrift.', 0, 10),
    mk(2, 'd-np-1', 'mail', 'Mette sendte feedback på kampagneoplægget — overvejende positiv.', 3, 14),
    mk(3, 'd-np-2', 'meeting', 'Anders spurgte til GDPR-flowet — du lovede at sende databehandleraftalen.', 0, 10),
    mk(4, 'd-np-3', 'note', '1:1 med Sofia: hun er klar til mere kundeansvar.', 4, 13),
    mk(5, 'd-np-4', 'chat', 'Jonas anbefalede "The Pyramid Principle" til Louises onboarding.', 8, 9),
    mk(6, 'd-np-5', 'calendar', 'Padel med Mikkel — du vandt 2-1.', 1, 18),
    mk(7, 'd-np-6', 'voice', 'Talenote fra netværksmiddagen: Kasper fra Nordfin, talte om AI i kundeservice.', 2, 21),
  ];
}

// ─── mutable demo stores (agent + facts) ───────────────────────────────────
//
// A tiny in-memory store so approve/dismiss/revert feel real in demo mode.
// Reset on every demo sign-in via resetDemoData().

let demoNetworkPeople: NetworkPerson[] = seedDemoNetworkPeople();
let demoNetworkFollowups: NetworkFollowup[] = seedDemoNetworkFollowups();
let demoNetworkInteractions: NetworkInteraction[] = seedDemoNetworkInteractions();

export function getDemoNetworkPeople(): NetworkPerson[] {
  return [...demoNetworkPeople];
}

export function getDemoNetworkFollowups(): NetworkFollowup[] {
  return [...demoNetworkFollowups];
}

export function getDemoNetworkInteractions(): NetworkInteraction[] {
  return [...demoNetworkInteractions];
}

export function addDemoNetworkPerson(person: NetworkPerson): void {
  demoNetworkPeople = [person, ...demoNetworkPeople];
}

export function updateDemoNetworkPerson(
  personId: string,
  patch: Record<string, unknown>,
  opts: { byUser: boolean },
): boolean {
  const p = demoNetworkPeople.find((x) => x.id === personId);
  if (!p) return false;
  const target = p as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    target[key] = value;
  }
  if (typeof patch.name === 'string') p.normalizedName = patch.name.toLowerCase();
  if (opts.byUser) {
    p.userEditedFields = Array.from(new Set([...p.userEditedFields, ...Object.keys(patch)]));
  }
  p.updatedAt = new Date();
  return true;
}

export function setDemoNetworkPersonStatus(personId: string, status: 'confirmed'): boolean {
  const p = demoNetworkPeople.find((x) => x.id === personId);
  if (!p) return false;
  p.status = status;
  p.updatedAt = new Date();
  return true;
}

export function deleteDemoNetworkPerson(personId: string): void {
  demoNetworkPeople = demoNetworkPeople.filter((x) => x.id !== personId);
  demoNetworkFollowups = demoNetworkFollowups.filter((x) => x.personId !== personId);
  demoNetworkInteractions = demoNetworkInteractions.filter((x) => x.personId !== personId);
}

export function addDemoNetworkFollowup(followup: NetworkFollowup): void {
  demoNetworkFollowups = [followup, ...demoNetworkFollowups];
}

export function setDemoNetworkFollowupDone(followupId: string, done: boolean): boolean {
  const f = demoNetworkFollowups.find((x) => x.id === followupId);
  if (!f) return false;
  f.doneAt = done ? new Date() : null;
  return true;
}

export function addDemoNetworkInteraction(interaction: NetworkInteraction): void {
  demoNetworkInteractions = [interaction, ...demoNetworkInteractions];
}

let demoFacts: Fact[] = seedDemoFacts();
let demoProposals: ProposedActionRow[] = seedProposals();
let demoActions: AgentActionRow[] = seedAgentActions();
let demoCommitments: CommitmentRow[] = seedCommitments();
let demoTrust: TrustOfferRow[] = seedTrustOffers();

const demoAgentListeners = new Set<() => void>();
// Modules with their own demo caches (fx sent-mails) registrerer sig her,
// så et nyt demo-login også nulstiller dem.
const demoResetListeners = new Set<() => void>();

export function onDemoReset(listener: () => void): () => void {
  demoResetListeners.add(listener);
  return () => { demoResetListeners.delete(listener); };
}

function notifyDemoAgent(): void {
  demoAgentListeners.forEach((l) => {
    try { l(); } catch {}
  });
}

export function subscribeDemoAgent(listener: () => void): () => void {
  demoAgentListeners.add(listener);
  return () => { demoAgentListeners.delete(listener); };
}

export function resetDemoData(): void {
  demoFacts = seedDemoFacts();
  demoNetworkPeople = seedDemoNetworkPeople();
  demoNetworkFollowups = seedDemoNetworkFollowups();
  demoNetworkInteractions = seedDemoNetworkInteractions();
  demoProposals = seedProposals();
  demoActions = seedAgentActions();
  demoCommitments = seedCommitments();
  demoTrust = seedTrustOffers();
  demoReplyFallbackIdx = 0;
  notifyDemoAgent();
  demoResetListeners.forEach((l) => {
    try { l(); } catch {}
  });
}

export function getDemoFacts(status?: Fact['status']): Fact[] {
  return status ? demoFacts.filter((f) => f.status === status) : [...demoFacts];
}

export function setDemoFactStatus(factId: string, status: 'confirmed' | 'rejected'): boolean {
  const f = demoFacts.find((x) => x.id === factId);
  if (!f) return false;
  f.status = status;
  if (status === 'confirmed') f.confirmedAt = new Date();
  else f.rejectedAt = new Date();
  return true;
}

export function deleteDemoFact(factId: string): boolean {
  const before = demoFacts.length;
  demoFacts = demoFacts.filter((x) => x.id !== factId);
  return demoFacts.length !== before;
}

export function addDemoFact(fact: Fact): void {
  demoFacts = [fact, ...demoFacts];
}

export function getDemoProposals(): ProposedActionRow[] {
  return [...demoProposals];
}

export function getDemoAgentActions(): AgentActionRow[] {
  return [...demoActions];
}

export function getDemoCommitments(): CommitmentRow[] {
  return demoCommitments.filter((c) => c.status === 'open');
}

export function getDemoTrustOffers(): TrustOfferRow[] {
  return [...demoTrust];
}

/** Approve/dismiss a demo proposal. Approving a mail proposal also appends a
 * matching executed action so the log tells a consistent story. */
export function decideDemoProposal(actionId: string, decision: 'approved' | 'dismissed'): boolean {
  const p = demoProposals.find((x) => x.id === actionId);
  if (!p || p.status !== 'pending') return false;
  demoProposals = demoProposals.filter((x) => x.id !== actionId);
  if (decision === 'approved') {
    demoActions = [
      {
        id: `demo-act-from-${actionId}`,
        action_type: p.action_type as AgentActionRow['action_type'],
        payload: p.payload,
        executed_at: new Date().toISOString(),
        reversible: p.action_type.startsWith('mail.'),
        reverse_token: { kind: 'demo' },
        reversed_at: null,
      },
      ...demoActions,
    ];
  }
  notifyDemoAgent();
  return true;
}

export function revertDemoAction(actionId: string): boolean {
  const a = demoActions.find((x) => x.id === actionId);
  if (!a || !a.reversible || a.reversed_at) return false;
  a.reversed_at = new Date().toISOString();
  notifyDemoAgent();
  return true;
}

export function decideDemoTrustOffer(offerId: string, status: 'accepted' | 'dismissed'): boolean {
  const t = demoTrust.find((x) => x.id === offerId);
  if (!t || t.status !== 'pending') return false;
  t.status = status;
  t.decided_at = new Date().toISOString();
  notifyDemoAgent();
  return true;
}

export function revertDemoTrustOffer(offerId: string): boolean {
  const t = demoTrust.find((x) => x.id === offerId);
  if (!t || t.status !== 'accepted') return false;
  t.status = 'reverted';
  notifyDemoAgent();
  return true;
}
