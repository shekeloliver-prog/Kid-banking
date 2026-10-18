import { kidHome } from './home.js';
import { goalsView } from './goals.js';
import { kidActivityView } from './activity.js';
import { askView } from './ask.js';
import { kidChoresView } from './chores.js';

export const kidRoutes = [
  ['/', kidHome],
  ['/goals', goalsView],
  ['/chores', kidChoresView],
  ['/activity', kidActivityView],
  ['/ask', askView],
];
