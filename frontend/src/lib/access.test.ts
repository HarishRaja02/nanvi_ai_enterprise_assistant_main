import { describe, expect, it } from "vitest";
import { permissionsFor, visibleNav } from "./access";
import { formatRoleTier, permissionsFor, visibleNav } from "./access";

const ids = (perms: ReturnType<typeof permissionsFor>) => visibleNav(perms).flatMap((g) => g.items.map((i) => i.id));

describe("access (UX-only visibility)", () => {
  it("shows only modules a role has permission for, hiding Knowledge, Finance, HR, Audit, and Reports by default", () => {
    expect(ids(permissionsFor(["Employee"]))).toEqual(["Chat"]);
    expect(ids(permissionsFor(["Project Engineer"]))).toEqual(["Chat"]);
  it("shows only modules a role has permission for across Tiers 1-5", () => {
    expect(ids(permissionsFor(["Intern"]))).toEqual(["Chat"]);
    expect(ids(permissionsFor(["Employee"]))).toEqual(["Chat", "Email", "Data", "Settings"]);
    expect(ids(permissionsFor(["Project Engineer"]))).toEqual(["Chat", "Email", "Data", "Settings"]);
    expect(ids(permissionsFor(["Supervisor"]))).toEqual(["Chat", "Email", "Data", "Settings"]);
    expect(ids(permissionsFor(["Superior"]))).toEqual(["Chat", "Email", "Data", "Settings", "Logs"]);
  });

  it("formats outside sidebar/tier display names cleanly without full form", () => {
    expect(formatRoleTier("Superior")).toBe("Tier 1");
    expect(formatRoleTier("Supervisor")).toBe("Tier 2");
    expect(formatRoleTier("Project Engineer")).toBe("Tier 3");
    expect(formatRoleTier("Employee")).toBe("Tier 4");
    expect(formatRoleTier("Intern")).toBe("Tier 5");
    expect(formatRoleTier("Admin")).toBe("Admin Portal");
  });

  it("maps Intern / Trainee aliases to Tier 5 permissions", () => {
    expect(permissionsFor(["Trainee"])).toEqual(["FILE_READ", "REPORT_CREATE", "REPORT_DOWNLOAD"]);
    expect(permissionsFor(["Intern / Trainee"])).toEqual(["FILE_READ", "REPORT_CREATE", "REPORT_DOWNLOAD"]);
  });

  it("unions permissions when the backend reports several roles", () => {
    expect(ids(permissionsFor(["Employee", "Supervisor"]))).toContain("Email");
    expect(ids(permissionsFor(["Intern", "Supervisor"]))).toContain("Email");
  });
  it("can include hidden modules when includeHidden is true", () => {
    const superiorAll = visibleNav(permissionsFor(["Superior"]), false, true).flatMap((g) => g.items.map((i) => i.id));
    expect(superiorAll).toEqual(["Chat", "Knowledge", "Email", "Data", "Finance", "HR", "Audit", "Settings", "Logs"]);
  });
  it("ignores unknown roles and grants nothing for them", () => {
    expect(permissionsFor(["Hacker", "__proto__", "constructor"])).toEqual([]);
    expect(ids([])).toEqual(["Chat"]);
  });
  it("drops empty groups", () => {
    expect(visibleNav([]).map((g) => g.id)).toEqual(["assistant"]);
  });
});
