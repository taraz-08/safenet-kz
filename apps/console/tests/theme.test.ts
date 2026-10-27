import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { parseTheme, resolveTheme, themeBootstrap } from "../src/lib/theme";

function firstPaint(saved: string | null, systemDark: boolean, blockedStorage = false) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, classList: { toggle: (_name: string, enabled: boolean) => { darkClass = enabled; } } };
  let darkClass = false;
  let addressBar = "";
  runInNewContext(themeBootstrap, {
    localStorage: { getItem: () => { if (blockedStorage) throw new Error("Storage denied"); return saved; } },
    matchMedia: () => ({ matches: systemDark }),
    document: { documentElement: root, querySelector: () => ({ setAttribute: (_key: string, value: string) => { addressBar = value; } }) },
  });
  return { theme: root.dataset.theme, scheme: root.style.colorScheme, darkClass, addressBar };
}

test("first paint honors an explicit choice even when the operating system disagrees", () => {
  assert.deepEqual(firstPaint("light", true), { theme: "light", scheme: "light", darkClass: false, addressBar: "#f3f6f8" });
  assert.deepEqual(firstPaint("dark", false), { theme: "dark", scheme: "dark", darkClass: true, addressBar: "#10161e" });
});

test("absent, reset and damaged preferences follow the operating system before hydration", () => {
  for (const saved of [null, "system", "", "invalid", '<script>alert("unsafe")</script>']) {
    for (const systemDark of [true, false]) {
      const expected = systemDark ? "dark" : "light";
      assert.equal(firstPaint(saved, systemDark).theme, expected);
      assert.equal(resolveTheme(parseTheme(saved), systemDark), expected);
    }
  }
});

test("private-mode storage failure leaves a usable system theme", () => {
  assert.equal(firstPaint("light", true, true).theme, "dark");
  assert.equal(firstPaint("dark", false, true).theme, "light");
});
