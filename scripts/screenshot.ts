import { chromium, type Page } from "playwright";

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `shots/${name}.png` });
  const status = await page.textContent("#status");
  const sub = await page.textContent("#sub");
  console.log(`${name.padEnd(14)} status="${status}"  sub="${sub}"`);
}

/** Waits for an act to finish, sampling the stage as it goes. */
async function watch(page: Page, tag: string, budgetMs: number): Promise<void> {
  const started = Date.now();
  let shot = 0;
  // The previous act's terminal status is still on screen when this one starts.
  // Passed as a string so this file does not need DOM lib types.
  await page.waitForFunction(
    `!/^landed ·|gave up/.test(document.getElementById("status").textContent)`,
    undefined,
    { timeout: 10_000 },
  );
  for (;;) {
    await page.waitForTimeout(2000);
    const status = (await page.textContent("#status")) ?? "";
    const elapsed = Date.now() - started;
    if (elapsed > shot * 15000) {
      await shoot(page, `${tag}-${String(shot * 15).padStart(2, "0")}s`);
      shot += 1;
    }
    if (/^landed ·|gave up|failed|error/.test(status)) {
      await page.waitForTimeout(2500);
      await shoot(page, `${tag}-final`);
      return;
    }
    if (elapsed > budgetMs) {
      await shoot(page, `${tag}-timeout`);
      return;
    }
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  await page.goto("http://localhost:4321", { waitUntil: "networkidle" });
  await shoot(page, "00-idle");

  await page.click("#launch");
  await watch(page, "act1", 150_000);

  await page.click("#harden");
  await watch(page, "act2", 150_000);

  await browser.close();
}

void main();
