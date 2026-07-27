'use strict';

/**
 * @module dwm-core/test/harness
 *
 * A dependency-free test harness: registers suites, runs them sequentially and
 * reports a summary. Kept deliberately tiny so the package has no dev
 * dependencies and live hardware tests can be run from anywhere.
 */

const suites = [];

/**
 * Registers a suite of tests.
 *
 * @param {string} name Suite name.
 * @param {(t: {test: Function, before: Function, after: Function}) => void} body
 *   Callback that registers the suite's tests.
 */
function describe(name, body) {
  const tests = [];
  const hooks = { before: null, after: null };

  body({
    test: (title, fn) => tests.push({ title, fn }),
    before: (fn) => {
      hooks.before = fn;
    },
    after: (fn) => {
      hooks.after = fn;
    },
  });

  suites.push({ name, tests, hooks });
}

/**
 * Runs every registered suite.
 *
 * @returns {Promise<{passed: number, failed: number}>}
 */
async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const suite of suites) {
    console.log(`\n\x1b[1m${suite.name}\x1b[0m`);

    let context = {};
    if (suite.hooks.before) {
      try {
        context = (await suite.hooks.before()) || {};
      } catch (error) {
        console.log(`  \x1b[31m! setup failed: ${error.message}\x1b[0m`);
        failed += suite.tests.length;
        failures.push({ title: `${suite.name} (setup)`, error });
        continue;
      }
    }

    for (const entry of suite.tests) {
      const startedAt = Date.now();
      try {
        await entry.fn(context);
        const ms = Date.now() - startedAt;
        console.log(`  \x1b[32mPASS\x1b[0m ${entry.title} \x1b[90m(${ms}ms)\x1b[0m`);
        passed += 1;
      } catch (error) {
        const ms = Date.now() - startedAt;
        console.log(`  \x1b[31mFAIL\x1b[0m ${entry.title} \x1b[90m(${ms}ms)\x1b[0m`);
        console.log(`       ${error.message}`);
        failed += 1;
        failures.push({ title: `${suite.name} > ${entry.title}`, error });
      }
    }

    if (suite.hooks.after) {
      try {
        await suite.hooks.after(context);
      } catch (error) {
        console.log(`  \x1b[33m! teardown failed: ${error.message}\x1b[0m`);
      }
    }
  }

  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m (${suites.length} suites)`,
  );

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(({ title, error }) => {
      console.log(`  - ${title}`);
      if (error.stack) console.log(`    ${error.stack.split('\n')[1] || ''}`);
    });
  }

  return { passed, failed };
}

module.exports = { describe, run };
