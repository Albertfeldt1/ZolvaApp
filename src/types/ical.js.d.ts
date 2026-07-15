// Minimal ambient type shim for ical.js@1.5.0 - the upstream package ships no
// .d.ts and there is no @types/ical.js. Only the surface area used by
// src/lib/icloud-calendar.ts is declared. Extend as needed if more APIs land.

declare module 'ical.js' {
  type Jcal = [string, unknown[], unknown[]];

  namespace ICAL {
    interface TimeData {
      year?: number;
      month?: number;
      day?: number;
      hour?: number;
      minute?: number;
      second?: number;
      isDate?: boolean;
    }

    class Time {
      constructor(data?: TimeData);
      isDate: boolean;
      toJSDate(): Date;
      static fromJSDate(date: Date, useUTC?: boolean): Time;
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
      hasProperty(name: string): boolean;
      updatePropertyWithValue(name: string, value: unknown): Property;
      removeAllProperties(name: string): boolean;
      toString(): string;
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
