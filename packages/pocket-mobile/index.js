// A project-owned entry point, replacing the default "main":
// "node_modules/expo/AppEntry.js". That file's own `import App from
// '../../App'` is a path RELATIVE TO WHERE IT PHYSICALLY LIVES — under
// classic npm/Yarn hoisting that's two levels above the project root, which
// works, but under pnpm's node_modules (a symlink into
// .pnpm/expo@.../node_modules/expo/) combined with Metro's
// `unstable_enableSymlinks` (required for pnpm — see metro.config.js),
// Metro resolves that relative import against the symlink's REAL physical
// location instead, landing outside the project entirely. Owning the entry
// point here avoids the reach-through-node_modules trick altogether: both
// imports below are either a plain package import or a normal
// project-relative one, so neither depends on any node_modules layout.
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
