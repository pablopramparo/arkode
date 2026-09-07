/**
 * Deliberately scoped to pure, platform-independent logic (crypto interop
 * against pocket-shared, search, sync-state decisions, freshness copy) —
 * exactly the "shared contract" pieces the project brief asks to test most
 * carefully. Screen/component rendering tests would need the full
 * jest-expo + React Native Testing Library stack (and, for anything
 * touching Keychain/biometrics/camera/Google Sign-In, a real device) which
 * this authoring environment cannot exercise — see docs/pocket.md's testing
 * section for what's covered here vs. what still needs on-device
 * verification.
 *
 * `pocket-shared` is mapped straight to its TypeScript SOURCE (not its
 * compiled `dist/`, which is ESM and Jest's default CJS runtime can't
 * `require()` without an extra Babel transform pass over node_modules).
 * ts-jest already transpiles TS→CJS for this project's own files, so
 * pointing it at pocket-shared's source gets the same treatment for free —
 * and as a bonus, tests always run against pocket-shared's CURRENT source,
 * never a stale `dist/` someone forgot to rebuild.
 */
const path = require('node:path');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^pocket-shared/node$': path.resolve(__dirname, '../pocket-shared/src/nodeCryptoAdapter.ts'),
    '^pocket-shared/fixtures$': path.resolve(__dirname, '../pocket-shared/src/fixtures.ts'),
    '^pocket-shared$': path.resolve(__dirname, '../pocket-shared/src/index.ts'),
    // pocket-shared's source uses explicit ".js" extensions on relative
    // imports (correct for its own NodeNext build), which Jest's CJS
    // resolver can't map back to the on-disk ".ts" files on its own —
    // strip the extension so moduleFileExtensions below finds the .ts.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
