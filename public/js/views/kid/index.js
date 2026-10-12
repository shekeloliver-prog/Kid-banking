import { kidHome } from './home.js';
import { goalsView } from './goals.js';
import { kidActivityView } from './activity.js';
import { askView } from './ask.js';

export const kidRoutes = [
  ['/', kidHome],
  ['/goals', goalsView],
  ['/activity', kidActivityView],
  ['/ask', askView],
];
