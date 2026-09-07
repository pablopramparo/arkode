// Metro config for an Expo app living inside a pnpm monorepo.
//
// This file was MISSING entirely, and is almost certainly the real cause of
// the "Bundle JavaScript" build failure: Expo's default Metro config has no
// idea this project's dependencies (react, react-native, and this repo's own
// `pocket-shared`) live one level up, symlinked via pnpm's node_modules
// layout — pnpm does not hoist into a single flat node_modules the way
// npm/Yarn classic do, so Metro's default resolver simply can't find them
// without being told where to look. This is the standard, Expo-documented
// pnpm-monorepo pattern (https://docs.expo.dev/guides/monorepos/), not a
// project-specific customization.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo (not just this package) so Metro picks up
// changes in packages/pocket-shared during development.
config.watchFolders = [workspaceRoot];

// Resolve modules from this package's own node_modules first, then fall
// back to the workspace root's.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// pnpm's node_modules is built on symlinks (e.g. node_modules/pocket-shared
// -> ../../pocket-shared) — Metro must be told to follow them.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
