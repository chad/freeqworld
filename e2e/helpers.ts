import type { Page } from '@playwright/test'

let userCounter = 0

export function uniqueName(prefix = 'tester'): string {
  return `${prefix}-${Date.now() % 100000}-${userCounter++}`
}

export const TOWN_A = '/?server=http://localhost:8787'
export const TOWN_B = '/?server=http://localhost:8788'

/** Enter the world as a named guest; resolves once the landing card is gone and the world is joined. */
export async function enterAsGuest(page: Page, name: string, url = TOWN_A): Promise<void> {
  await page.goto(url)
  await page.getByTestId('name-input').fill(name)
  await page.getByTestId('enter-guest').click()
  await page.getByTestId('landing').waitFor({ state: 'hidden' })
  // the member list only lists us once the authenticated welcome arrived
  await page.getByTestId('member-list').filter({ hasText: name }).waitFor()
}

export async function hookState(page: Page): Promise<{ channel: string; town: string; did: string; x: number; y: number; members: string[]; remotes: number; backend: string; sparks: number }> {
  return page.evaluate(() => (window as any).__fimp.state())
}

export async function hookJoin(page: Page, channel: string): Promise<void> {
  await page.evaluate((ch) => (window as any).__fimp.join(ch), channel)
}

export async function hookTeleport(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(([tx, ty]) => (window as any).__fimp.teleport(tx, ty), [x, y])
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('msg-input').fill(text)
  await page.getByTestId('send-btn').click()
}
