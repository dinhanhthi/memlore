/**
 * Google Drive recovery-wizard E2E.
 *
 * Runs against the web preview harness (`pnpm web:dev`) with mocked Tauri
 * invoke/events — no live Google OAuth required.
 *
 * Setup (once):
 *   pnpm add -D @playwright/test
 *   pnpm exec playwright install chromium
 *
 * Run:
 *   pnpm exec playwright test e2e/sync-recovery.spec.ts
 */
import { test, expect, type Page, type Locator } from '@playwright/test'

const TRIAGE_TEST_IDS = [
  'gdrive-recovery-triage-sync_stuck',
  'gdrive-recovery-triage-device_wrong',
  'gdrive-recovery-triage-cloud_wrong',
  'gdrive-recovery-triage-stop_syncing',
] as const

async function openScenario(page: Page, id: string): Promise<void> {
  await page.goto(`/?scenario=${id}`)
  await expect(
    page
      .getByTestId('gdrive-recovery-wizard-open')
      .or(page.getByTestId('gdrive-recovery-progress'))
      .first(),
  ).toBeVisible({ timeout: 20_000 })
}

function wizard(page: Page): Locator {
  return page.getByTestId('gdrive-recovery-wizard')
}

async function openWizard(page: Page): Promise<void> {
  const trigger = page.getByTestId('gdrive-recovery-wizard-open')
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(wizard(page)).toBeVisible()
}

/**
 * Recovery blocks the card CTA (`disabled={actionsDisabled}`). React still
 * holds the same `openWizard()` handler — invoke it so tests can prove the
 * panel banner stays mounted while the wizard opens and closes.
 */
async function openWizardWhileActionsBlocked(page: Page): Promise<void> {
  await page.getByTestId('gdrive-recovery-wizard-open').evaluate((el) => {
    const propsKey = Object.keys(el).find((key) => key.startsWith('__reactProps$'))
    const props = propsKey
      ? (el as unknown as Record<string, { onClick?: (event: Event) => void }>)[propsKey]
      : undefined
    if (!props?.onClick) {
      throw new Error('gdrive-recovery-wizard-open has no React onClick')
    }
    props.onClick(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await expect(wizard(page)).toBeVisible()
}

async function triageOrder(root: Locator): Promise<string[]> {
  return root.evaluate(
    (el, testIds) => {
      const nodes = testIds
        .map((id) => el.querySelector(`[data-testid="${id}"]`))
        .filter((node): node is Element => node != null)
      nodes.sort((a, b) => {
        const pos = a.compareDocumentPosition(b)
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
        return 0
      })
      return nodes.map((node) => node.getAttribute('data-testid') ?? '')
    },
    [...TRIAGE_TEST_IDS],
  )
}

async function expectTriageLabelsPresent(root: Locator): Promise<void> {
  for (const id of TRIAGE_TEST_IDS) {
    const btn = root.getByTestId(id)
    await btn.scrollIntoViewIfNeeded()
    await expect(btn).toBeVisible()
    expect((await btn.innerText()).trim().length).toBeGreaterThan(0)
  }
}

/** Wait until a cancel-safe replace job has torn down after leaving confirm. */
async function expectRecoveryBannerAbsent(page: Page): Promise<void> {
  await expect(page.getByTestId('gdrive-recovery-progress')).toHaveCount(0)
}

test.describe('Google Drive sync recovery UX', () => {
  test('connected state exposes Sync Now and the recovery card; no wizard or old disclosure', async ({
    page,
  }) => {
    await openScenario(page, 'gdrive-settings-collapsed')

    await expect(
      page.getByTestId('sync-status').getByRole('button', { name: /Sync now/i }),
    ).toBeVisible()
    await expect(page.getByTestId('gdrive-recovery-wizard-open')).toBeVisible()
    await expect(wizard(page)).toHaveCount(0)
    await expect(page.getByTestId('gdrive-sync-help-trigger')).toHaveCount(0)
  })

  test('wizard opens at triage in DOM order; Esc closes and restores focus', async ({ page }) => {
    await openScenario(page, 'gdrive-settings-collapsed')
    const trigger = page.getByTestId('gdrive-recovery-wizard-open')
    await openWizard(page)

    expect(await triageOrder(wizard(page))).toEqual([...TRIAGE_TEST_IDS])
    for (const id of TRIAGE_TEST_IDS) {
      await expect(wizard(page).getByTestId(id)).toBeVisible()
    }

    await page.keyboard.press('Escape')
    await expect(wizard(page)).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('network error does not auto-open the wizard; error CTA opens triage', async ({ page }) => {
    await openScenario(page, 'gdrive-sync-error-network')
    await expect(wizard(page)).toHaveCount(0)
    const fromError = page.getByTestId('gdrive-open-sync-help')
    await expect(fromError).toBeVisible()
    await fromError.click()
    await expect(wizard(page)).toBeVisible()
    expect(await triageOrder(wizard(page))).toEqual([...TRIAGE_TEST_IDS])
  })

  test('each triage choice lands on the matching step; Back returns one step', async ({ page }) => {
    await openScenario(page, 'gdrive-settings-collapsed')
    await openWizard(page)
    const dialog = wizard(page)

    await dialog.getByTestId('gdrive-recovery-triage-sync_stuck').click()
    await expect(page.getByTestId('gdrive-recovery-primary')).toHaveText(/^Reset$/)
    await page.getByTestId('gdrive-recovery-back').click()
    await expect(dialog.getByTestId('gdrive-recovery-triage-sync_stuck')).toBeVisible()

    await dialog.getByTestId('gdrive-recovery-triage-device_wrong').click()
    await expect(dialog).toContainText('Replace this device with Google Drive?')
    await expect(page.getByTestId('gdrive-recovery-primary')).toBeEnabled({ timeout: 10_000 })
    await page.getByTestId('gdrive-recovery-back').click()
    await expect(dialog.getByTestId('gdrive-recovery-triage-sync_stuck')).toBeVisible()
    await expectRecoveryBannerAbsent(page)

    await dialog.getByTestId('gdrive-recovery-triage-cloud_wrong').click()
    await expect(dialog).toContainText('Replace Google Drive with this device?')
    await expect(page.getByTestId('gdrive-recovery-primary')).toBeEnabled({ timeout: 10_000 })
    await page.getByTestId('gdrive-recovery-back').click()
    await expect(dialog.getByTestId('gdrive-recovery-triage-sync_stuck')).toBeVisible()
    await expectRecoveryBannerAbsent(page)

    await dialog.getByTestId('gdrive-recovery-triage-stop_syncing').click()
    await expect(dialog.getByTestId('gdrive-recovery-stop-keep_cloud')).toBeVisible()
    await expect(dialog.getByTestId('gdrive-recovery-stop-delete_cloud')).toBeVisible()

    await dialog.getByTestId('gdrive-recovery-stop-keep_cloud').click()
    await expect(dialog).toContainText('Disconnect Google Drive?')
    await page.getByTestId('gdrive-recovery-back').click()
    await expect(dialog.getByTestId('gdrive-recovery-stop-keep_cloud')).toBeVisible()

    await dialog.getByTestId('gdrive-recovery-stop-delete_cloud').click()
    await expect(dialog).toContainText(
      'This permanently deletes the cloud copy. After deletion, the copy on this device is your only copy — export a backup first (Settings → Data → Export) if you need one.',
    )
    await page.getByTestId('gdrive-recovery-back').click()
    await expect(dialog.getByTestId('gdrive-recovery-stop-delete_cloud')).toBeVisible()

    await page.getByTestId('gdrive-recovery-back').click()
    await expect(dialog.getByTestId('gdrive-recovery-triage-sync_stuck')).toBeVisible()
  })

  test('active recovery remains visible after reload with Sync Now blocked', async ({ page }) => {
    await openScenario(page, 'gdrive-recovery-active')
    await expect(page.getByTestId('gdrive-recovery-progress')).toBeVisible()
    // local_to_cloud @ transfer is past fence — cancel must not be offered.
    await expect(page.getByTestId('gdrive-recovery-cancel')).toHaveCount(0)
    // Settings panel SyncStatus (non-compact) shows recovery chrome, not plain Sync now.
    const panelSync = page.locator('[data-testid="sync-status"][data-state="recovery"]').filter({
      has: page.getByRole('button', { name: /View recovery|Xem khôi phục/i }),
    })
    await expect(panelSync).toBeVisible()
    await expect(panelSync).toContainText(/Recovery in progress|Đang khôi phục/i)

    await openWizardWhileActionsBlocked(page)
    await expect(page.getByTestId('gdrive-recovery-progress')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(wizard(page)).toHaveCount(0)
    await expect(page.getByTestId('gdrive-recovery-progress')).toBeVisible()

    // Reload hydrates the same interrupted job via get_sync_recovery_status.
    await page.reload()
    await expect(page.getByTestId('gdrive-recovery-progress')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('gdrive-recovery-cancel')).toHaveCount(0)
    await expect(panelSync).toBeVisible()
  })

  test('replace confirm enables primary after preflight and hides banner actions', async ({
    page,
  }) => {
    await openScenario(page, 'gdrive-settings-collapsed')
    await openWizard(page)
    await wizard(page).getByTestId('gdrive-recovery-triage-cloud_wrong').click()
    await expect(wizard(page)).toContainText('Replace Google Drive with this device?')

    await expect(page.getByTestId('gdrive-recovery-primary')).toBeEnabled({ timeout: 10_000 })
    await expect(page.getByTestId('gdrive-recovery-progress')).toHaveCount(0)
    await expect(page.getByTestId('gdrive-recovery-resume')).toHaveCount(0)
    await expect(page.getByTestId('gdrive-recovery-cancel')).toHaveCount(0)

    await page.getByTestId('gdrive-recovery-back').click()
    await expect(wizard(page).getByTestId('gdrive-recovery-triage-sync_stuck')).toBeVisible()
    await expectRecoveryBannerAbsent(page)
  })

  test('reset flow reaches the done step and Done closes the wizard', async ({ page }) => {
    await openScenario(page, 'gdrive-settings-collapsed')
    await openWizard(page)
    await wizard(page).getByTestId('gdrive-recovery-triage-sync_stuck').click()
    await expect(page.getByTestId('gdrive-recovery-primary')).toHaveText(/^Reset$/)
    await page.getByTestId('gdrive-recovery-primary').click()

    await expect(wizard(page)).toContainText(/Reset complete/i)
    await expect(wizard(page)).toContainText('3 entries')
    await expect(wizard(page)).toContainText('1 media')
    await expect(wizard(page)).toContainText('1 journal')

    await page.getByTestId('gdrive-recovery-primary').click()
    await expect(wizard(page)).toHaveCount(0)
  })

  test('EN and VI keep triage order; narrow viewport and 200% zoom keep labels visible', async ({
    page,
  }) => {
    await openScenario(page, 'gdrive-settings-collapsed')
    await openWizard(page)
    expect(await triageOrder(wizard(page))).toEqual([...TRIAGE_TEST_IDS])
    await page.keyboard.press('Escape')
    await expect(wizard(page)).toHaveCount(0)

    await page.locator('#settings-tab-general').click()
    await page.getByRole('radio', { name: 'Vietnamese' }).click()
    await expect(page.getByRole('radio', { name: 'Tiếng Việt' })).toBeVisible()
    await page.locator('#settings-tab-sync').click()
    await expect(page.locator('#settings-tab-sync')).toContainText(/Đồng bộ/i)
    await expect(page.getByTestId('gdrive-recovery-wizard-open')).toContainText(
      'Trợ giúp và khôi phục đồng bộ',
    )

    await openWizard(page)
    expect(await triageOrder(wizard(page))).toEqual([...TRIAGE_TEST_IDS])

    await page.setViewportSize({ width: 360, height: 640 })
    await expectTriageLabelsPresent(wizard(page))

    await page.evaluate(() => {
      document.documentElement.style.zoom = '2'
    })
    await expectTriageLabelsPresent(wizard(page))
  })
})
