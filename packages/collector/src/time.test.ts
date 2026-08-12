import { describe, expect, it } from "vitest";
import { parseAoTimestamp, withinWindow } from "./time.ts";

describe("parseAoTimestamp", () => {
  it("parses the Go time.Time format AO actually writes", () => {
    const parsed = parseAoTimestamp("2026-07-07 06:58:31.825841 +0000 UTC");
    expect(parsed?.toISOString()).toBe("2026-07-07T06:58:31.825Z");
  });

  it("parses the second-precision variant on pr.created_at_provider", () => {
    const parsed = parseAoTimestamp("2026-07-07 07:00:03 +0000 UTC");
    expect(parsed?.toISOString()).toBe("2026-07-07T07:00:03.000Z");
  });

  it("honours a non-UTC offset instead of assuming zero", () => {
    const parsed = parseAoTimestamp("2026-08-12 11:30:00 +0530 IST");
    expect(parsed?.toISOString()).toBe("2026-08-12T06:00:00.000Z");
  });

  it("accepts ISO-8601 in case a newer AO build changes format", () => {
    const parsed = parseAoTimestamp("2026-08-12T05:41:23.269Z");
    expect(parsed?.toISOString()).toBe("2026-08-12T05:41:23.269Z");
  });

  it("returns null rather than an Invalid Date for empty or junk input", () => {
    expect(parseAoTimestamp("")).toBeNull();
    expect(parseAoTimestamp(null)).toBeNull();
    expect(parseAoTimestamp("not a timestamp")).toBeNull();
  });
});

describe("withinWindow", () => {
  const from = new Date("2026-08-12T00:00:00Z");
  const to = new Date("2026-08-13T23:59:59Z");

  it("includes timestamps inside the window", () => {
    expect(withinWindow(parseAoTimestamp("2026-08-12 10:00:00 +0000 UTC"), from, to)).toBe(true);
  });

  it("excludes timestamps outside it", () => {
    expect(withinWindow(parseAoTimestamp("2026-07-07 10:00:00 +0000 UTC"), from, to)).toBe(false);
  });

  it("excludes unparseable timestamps instead of counting them", () => {
    expect(withinWindow(null, from, to)).toBe(false);
  });
});
