import { RHDHDeployment } from "../../deployment/rhdh/index.js";
import { test as base } from "@playwright/test";
import { LoginHelper, UIhelper } from "../helpers/index.js";
import { runOnce } from "../run-once.js";
import { $ } from "../../utils/bash.js";
import { WorkspacePaths } from "../../utils/workspace-paths.js";
import fs from "node:fs";
import path from "path";

type RHDHDeploymentTestFixtures = {
  rhdh: RHDHDeployment;
  uiHelper: UIhelper;
  loginHelper: LoginHelper;
  autoAnnotations: void;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  _coverageCollector: void;
};

type RHDHDeploymentWorkerFixtures = {
  rhdhDeploymentWorker: RHDHDeployment;
};

const baseTest = base.extend<
  RHDHDeploymentTestFixtures,
  RHDHDeploymentWorkerFixtures
>({
  rhdhDeploymentWorker: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      // Set CWD to the workspace's e2e-tests directory so that relative
      // config paths resolve correctly even when Playwright runs from the repo root.
      // Each worker is a separate process, so this doesn't affect other workers.
      const e2eRoot = path.resolve(workerInfo.project.testDir, "..");
      process.chdir(e2eRoot);
      $.cwd = e2eRoot;

      const rhdhDeployment = new RHDHDeployment(workerInfo.project.name);

      await rhdhDeployment.configure();
      await use(rhdhDeployment);
    },
    { scope: "worker", auto: true },
  ],

  rhdh: [
    async ({ rhdhDeploymentWorker }, use) => {
      await use(rhdhDeploymentWorker);
    },
    { auto: true, scope: "test" },
  ],
  uiHelper: [
    async ({ page }, use) => {
      await use(new UIhelper(page));
    },
    { scope: "test" },
  ],
  loginHelper: [
    async ({ page }, use) => {
      await use(new LoginHelper(page));
    },
    { scope: "test" },
  ],
  baseURL: [
    async ({ rhdhDeploymentWorker }, use) => {
      await use(rhdhDeploymentWorker.rhdhUrl);
    },
    { scope: "test" },
  ] as const,
  autoAnnotations: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      testInfo.annotations.push(
        {
          type: "workspace",
          description: path.basename(WorkspacePaths.workspaceRoot),
        },
        { type: "project", description: testInfo.project.name },
      );
      await use();
    },
    { auto: true, scope: "test" },
  ],
  // eslint-disable-next-line @typescript-eslint/naming-convention
  _coverageCollector: [
    async ({ page }, use, testInfo) => {
      await use();
      console.log("[_coverageCollector] Fixture executed");
      console.log(
        `[_coverageCollector] E2E_COLLECT_COVERAGE = ${process.env.E2E_COLLECT_COVERAGE}`,
      );
      if (process.env.E2E_COLLECT_COVERAGE !== "true") {
        console.log(
          "[_coverageCollector] Skipping - E2E_COLLECT_COVERAGE !== 'true'",
        );
        return;
      }
      try {
        // Wait a bit for any pending JS execution to complete
        await page.waitForTimeout(1000);

        console.log("[_coverageCollector] Evaluating page for __coverage__");

        // Try to access __coverage__ from different scopes
        const coverage = await page.evaluate(() => {
          const globalObj = globalThis as unknown as {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            __coverage__?: Record<string, unknown>;
          };

          // Check window scope
          const windowCov = globalObj.__coverage__;

          // Also check if it's in a different context
          console.log('[Browser] Checking window.__coverage__:', typeof windowCov);
          console.log('[Browser] window keys containing coverage:',
            Object.keys(globalObj).filter(k => k.includes('coverage')));

          return windowCov;
        });

        console.log(
          `[_coverageCollector] Coverage result: ${coverage ? `${Object.keys(coverage).length} files` : "undefined"}`,
        );
        if (!coverage) {
          console.log("[_coverageCollector] No coverage data, returning");
          return;
        }
        const dir = path.join(testInfo.project.outputDir, "coverage");
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(
          dir,
          `${testInfo.testId}-${Date.now()}.json`,
        );
        fs.writeFileSync(filePath, JSON.stringify(coverage));
        console.log(
          `[_coverageCollector] Written coverage to ${filePath} (${Object.keys(coverage).length} files)`,
        );
      } catch (error) {
        console.error("[_coverageCollector] Error:", error);
      }
    },
    { auto: true, scope: "test" },
  ],
});

export const test = Object.assign(baseTest, {
  runOnce,
});

export * from "@playwright/test";
