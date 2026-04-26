// Minimal ambient type shim for ical.js@1.5.0 — the upstream package ships no
// .d.ts and there is no @types/ical.js. Only the surface area used by
// src/lib/icloud-calendar.ts is declared. Extend as needed if more APIs land.

declare module 'ical.js' {
  type Jcal = [string, unknown[], unknown[]];

  namespace ICAL {
    class Time {
      isDate: boolean;
      toJSDate(): Date;
    }

    class Property {
      getParameter(name: string): string | undefined;
    }

    class Component {
      constructor(jcal: Jcal);
      getAllSubcomponents(name: string): Component[];
      getFirstSubcomponent(name: string): Component | null;
      getFirstProperty(name: string): Property | null;
      getFirstPropertyValue(name: string): unknown;
    }

    interface OccurrenceDetails {
      item: Event;
      startDate: Time;
      endDate: Time;
    }

    interface RecurExpansion {
      next(): Time | null;
    }

    class Event {
      constructor(component: Component);
      uid: string;
      summary: string;
      location: string;
      description: string;
      startDate: Time;
      endDate: Time;
      isRecurring(): boolean;
      iterator(): RecurExpansion;
      getOccurrenceDetails(time: Time): OccurrenceDetails;
    }

    class Timezone {
      constructor(component: Component);
    }

    namespace TimezoneService {
      function has(tzid: string): boolean;
      function register(tzid: string, tz: Timezone): void;
    }

    function parse(input: string): Jcal;
  }

  export default ICAL;
}
