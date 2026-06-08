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
      // Forward browser console to test output
      page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();
        console.log(`[Browser Console ${type.toUpperCase()}] ${text}`);
      });

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

        // Deep investigation of global scope
        const coverageData = await page.evaluate(() => {
          const globalObj = globalThis as any;

          // Dump all keys containing "cov" to find coverage objects
          const covKeys = Object.keys(globalObj).filter(k =>
            k.toLowerCase().includes('cov') ||
            k.includes('__') ||
            k.includes('nyc') ||
            k.includes('istanbul')
          );

          // Check common locations
          const checks = {
            'globalThis.__coverage__': globalObj.__coverage__,
            'window.__coverage__': (globalObj.window as any)?.__coverage__,
            'self.__coverage__': (globalObj.self as any)?.__coverage__,
            'global.__coverage__': (globalObj.global as any)?.__coverage__,
          };

          // Also check all window frames
          let frameCoverage = null;
          try {
            if (globalObj.frames && globalObj.frames.length > 0) {
              for (let i = 0; i < globalObj.frames.length; i++) {
                try {
                  const frameCov = (globalObj.frames[i] as any).__coverage__;
                  if (frameCov) {
                    frameCoverage = frameCov;
                    break;
                  }
                } catch (e) {
                  // Frame might be cross-origin
                }
              }
            }
          } catch (e) {
            // Ignore frame errors
          }

          return {
            covKeys,
            checks,
            frameCoverage,
            hasWindow: typeof globalObj.window !== 'undefined',
            hasSelf: typeof globalObj.self !== 'undefined',
            hasGlobal: typeof globalObj.global !== 'undefined',
            totalKeys: Object.keys(globalObj).length,
          };
        });

        console.log("[_coverageCollector] Global scope investigation:");
        console.log(`  - Total globalThis keys: ${coverageData.totalKeys}`);
        console.log(`  - Keys containing 'cov': ${JSON.stringify(coverageData.covKeys)}`);
        console.log(`  - hasWindow: ${coverageData.hasWindow}`);
        console.log(`  - hasSelf: ${coverageData.hasSelf}`);
        console.log(`  - hasGlobal: ${coverageData.hasGlobal}`);
        console.log("  - Coverage location checks:");
        for (const [key, value] of Object.entries(coverageData.checks)) {
          console.log(`    ${key}: ${value ? `FOUND (${Object.keys(value as any).length} files)` : 'undefined'}`);
        }
        if (coverageData.frameCoverage) {
          console.log(`  - Found coverage in iframe: ${Object.keys(coverageData.frameCoverage).length} files`);
        }

        // Try to extract the coverage object from any of the locations
        const coverage =
          coverageData.checks['globalThis.__coverage__'] ||
          coverageData.checks['window.__coverage__'] ||
          coverageData.checks['self.__coverage__'] ||
          coverageData.checks['global.__coverage__'] ||
          coverageData.frameCoverage;

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
