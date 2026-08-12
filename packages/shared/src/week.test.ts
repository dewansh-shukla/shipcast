import { describe, expect, it } from "vitest";
import {
  isCurrentWeek,
  previousWeek,
  weekKeyFor,
  weekStart,
  weekWindowFor,
  weekWindowFromKey,
} from "./week.ts";

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("weekStart", () => {
  it("returns Monday for a midweek day", () => {
    expect(weekStart(at("2026-08-13")).toISOString().slice(0, 10)).toBe("2026-08-10");
  });

  it("treats Sunday as the end of its week, not the start", () => {
    expect(weekStart(at("2026-08-16")).toISOString().slice(0, 10)).toBe("2026-08-10");
  });

  it("returns Monday unchanged", () => {
    expect(weekStart(at("2026-08-10")).toISOString().slice(0, 10)).toBe("2026-08-10");
  });
});

describe("weekKeyFor", () => {
  it("keys the hackathon week", () => {
    expect(weekKeyFor(at("2026-08-13"))).toBe("2026-W33");
  });

  it("puts early January in the previous year when the week belongs there", () => {
    // 2027-01-01 is a Friday, so its ISO week started 2026-12-28.
    expect(weekKeyFor(at("2027-01-01"))).toBe("2026-W53");
  });

  it("pads single-digit weeks", () => {
    expect(weekKeyFor(at("2026-01-08"))).toMatch(/^2026-W0\d$/);
  });

  /**
   * Week 1 is the week containing the first Thursday, which means a year
   * opening on a Friday, Saturday or Sunday starts counting in what is still
   * the previous year's final week. Anchoring the count on January 1st rather
   * than January 4th shifts every week of such a year up by one, and the board
   * then has no `W01` at all.
   */
  it("numbers the first week W01 when the year opens on a Friday", () => {
    // 2027-01-01 is a Friday, so ISO week 1 runs 2027-01-04 to 2027-01-10.
    expect(weekKeyFor(at("2027-01-04"))).toBe("2027-W01");
    expect(weekKeyFor(at("2027-01-10"))).toBe("2027-W01");
    expect(weekKeyFor(at("2027-01-11"))).toBe("2027-W02");
  });

  it("numbers the first week W01 when the year opens on a Saturday", () => {
    // 2028-01-01 is a Saturday; week 1 runs 2028-01-03 to 2028-01-09.
    expect(weekKeyFor(at("2028-01-03"))).toBe("2028-W01");
  });

  it("numbers the first week W01 when the year opens on a Sunday", () => {
    // 2023-01-01 is a Sunday; week 1 runs 2023-01-02 to 2023-01-08.
    expect(weekKeyFor(at("2023-01-02"))).toBe("2023-W01");
  });

  it("still starts on January 1st when that day is already in week 1", () => {
    // 2025-01-01 is a Wednesday, so it belongs to week 1 itself.
    expect(weekKeyFor(at("2025-01-01"))).toBe("2025-W01");
    expect(weekKeyFor(at("2026-01-01"))).toBe("2026-W01");
  });
});

describe("weekWindowFor", () => {
  it("spans Monday to Sunday inclusive", () => {
    expect(weekWindowFor(at("2026-08-13"))).toEqual({
      key: "2026-W33",
      from: "2026-08-10",
      to: "2026-08-16",
    });
  });
});

describe("weekWindowFromKey", () => {
  it("round-trips a key", () => {
    expect(weekWindowFromKey("2026-W33")).toEqual(weekWindowFor(at("2026-08-13")));
  });

  it("rejects malformed keys", () => {
    expect(weekWindowFromKey("2026-33")).toBeNull();
    expect(weekWindowFromKey("W33")).toBeNull();
    expect(weekWindowFromKey("2026-W00")).toBeNull();
  });

  it("rejects a week 53 the year does not have", () => {
    expect(weekWindowFromKey("2026-W53")).not.toBeNull();
    expect(weekWindowFromKey("2025-W53")).toBeNull();
  });

  /** A key the board can be linked to must resolve, in every year. */
  it("resolves W01 in a year that opens on a Friday", () => {
    expect(weekWindowFromKey("2027-W01")).toEqual({
      key: "2027-W01",
      from: "2027-01-04",
      to: "2027-01-10",
    });
  });
});

describe("previousWeek", () => {
  it("steps back one week", () => {
    expect(previousWeek(weekWindowFor(at("2026-08-13"))).key).toBe("2026-W32");
  });

  it("crosses a year boundary", () => {
    expect(previousWeek(weekWindowFor(at("2026-01-05"))).key).toBe("2026-W01");
  });
});

describe("isCurrentWeek", () => {
  it("is true within the same week", () => {
    expect(isCurrentWeek(weekWindowFor(at("2026-08-10")), at("2026-08-16"))).toBe(true);
  });

  it("is false once the reset has happened", () => {
    expect(isCurrentWeek(weekWindowFor(at("2026-08-10")), at("2026-08-17"))).toBe(false);
  });
});
