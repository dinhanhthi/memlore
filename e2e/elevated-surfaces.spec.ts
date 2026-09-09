import { expect, test, type Page } from '@playwright/test'

async function expectTokenBackground(page: Page, selector: string, token: string) {
  const expected = await page.evaluate((cssToken) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = `var(${cssToken})`
    document.body.append(probe)
    const background = getComputedStyle(probe).backgroundColor
    probe.remove()
    return background
  }, token)

  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe(expected)
}

test('selected tab and idle entry cards use the selected-tab surface', async ({ page }) => {
  await page.goto('/?scenario=logged-in')
  await page.getByRole('navigation').getByRole('button', { name: 'Entries', exact: true }).click()

  await expectTokenBackground(page, '[data-tab-id][aria-selected="true"]', '--color-selected-tab')
  await expectTokenBackground(page, '[role="button"].group.border-b', '--entry-card-idle-bg')
})
